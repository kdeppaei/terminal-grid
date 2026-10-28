using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace TerminalGridIntegrated
{
    /// <summary>
    /// One Windows ConPTY and its private process-tree job. Output is UTF-8 VT
    /// data, not independently decodable strings. Events run on worker threads;
    /// subscribers must dispatch asynchronously and must not block the reader.
    /// </summary>
    public sealed class PtySession : IDisposable
    {
        public event Action<byte[]> Output;
        public event Action<int> Exited;

        private readonly object stateGate = new object();
        private readonly object nativeGate = new object();
        private readonly object inputGate = new object();
        private readonly Queue<byte[]> inputQueue = new Queue<byte[]>();
        private readonly ManualResetEvent cleanupDone = new ManualResetEvent(false);
        private IntPtr pseudoConsole;
        private IntPtr inputWrite;
        private IntPtr outputRead;
        private IntPtr processHandle;
        private IntPtr jobHandle;
        private IntPtr readerNativeThread;
        private IntPtr writerNativeThread;
        private Thread readerThread;
        private Thread writerThread;
        private Thread lifetimeThread;
        private volatile bool running;
        private volatile bool disposed;
        private volatile bool inputStopping;
        private volatile bool outputStopping;
        private bool startAttempted;
        private bool started;
        private int processId;
        private int inputBytes;
        private int cleanupStarted;
        private const int MaxQueuedInput = 16 * 1024 * 1024;

        public int ProcessId { get { return processId; } }
        public bool IsRunning { get { return running && !disposed; } }

        public void Start(string exe, string args, string cwd, int cols, int rows)
        {
            if (String.IsNullOrWhiteSpace(exe)) throw new ArgumentException("Shell executable is required.", "exe");
            ValidateSize(cols, rows);
            if (!String.IsNullOrEmpty(cwd) && !Directory.Exists(cwd))
                throw new DirectoryNotFoundException("Working directory does not exist: " + cwd);

            lock (stateGate)
            {
                if (disposed) throw new ObjectDisposedException("PtySession");
                if (startAttempted) throw new InvalidOperationException("Each PtySession can be started only once.");
                startAttempted = true;
                IntPtr inputReadSide = IntPtr.Zero;
                IntPtr outputWriteSide = IntPtr.Zero;
                IntPtr attributeList = IntPtr.Zero;
                bool attributesInitialized = false;
                PROCESS_INFORMATION process = new PROCESS_INFORMATION();
                try
                {
                    if (!CreatePipe(out inputReadSide, out inputWrite, IntPtr.Zero, 65536)) ThrowLastError("Create input pipe");
                    if (!CreatePipe(out outputRead, out outputWriteSide, IntPtr.Zero, 65536)) ThrowLastError("Create output pipe");
                    int result;
                    try
                    {
                        result = CreatePseudoConsole(new COORD((short)cols, (short)rows), inputReadSide, outputWriteSide, 0, out pseudoConsole);
                    }
                    catch (EntryPointNotFoundException ex)
                    {
                        throw new PlatformNotSupportedException("Embedded terminals require Windows 10 version 1809 or later.", ex);
                    }
                    if (result < 0) Marshal.ThrowExceptionForHR(result);

                    // Drain from the instant the pseudoconsole exists, including
                    // error cleanup before a shell was successfully created.
                    readerThread = NewThread(ReadOutput, "TerminalGrid output");
                    readerThread.Start();

                    jobHandle = CreateJobObject(IntPtr.Zero, null);
                    if (jobHandle == IntPtr.Zero) ThrowLastError("Create session job");
                    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobInfo = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                    jobInfo.BasicLimitInformation.LimitFlags = 0x00002000; // KILL_ON_JOB_CLOSE
                    if (!SetInformationJobObject(jobHandle, 9, ref jobInfo, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                        ThrowLastError("Configure session job");

                    IntPtr attributeBytes = IntPtr.Zero;
                    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
                    if (attributeBytes == IntPtr.Zero) ThrowLastError("Size process attributes");
                    attributeList = Marshal.AllocHGlobal(attributeBytes);
                    if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeBytes)) ThrowLastError("Initialize process attributes");
                    attributesInitialized = true;
                    // For PSEUDOCONSOLE the value is HPCON itself, not &HPCON.
                    if (!UpdateProcThreadAttribute(attributeList, 0, (IntPtr)0x00020016, pseudoConsole, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                        ThrowLastError("Attach pseudoconsole");

                    STARTUPINFOEX startup = new STARTUPINFOEX();
                    startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                    // Explicit null standard handles prevent CreateProcess from
                    // copying a host's redirected stdin/stdout into the shell.
                    // Console initialization reopens these against our ConPTY.
                    startup.StartupInfo.dwFlags = 0x00000100; // STARTF_USESTDHANDLES
                    startup.lpAttributeList = attributeList;
                    StringBuilder commandLine = new StringBuilder(QuoteArgument(exe) + (String.IsNullOrWhiteSpace(args) ? "" : " " + args));
                    // Do not use CREATE_NEW_CONSOLE / CREATE_NO_WINDOW: ConPTY
                    // provides the console. Suspension closes the child-spawn
                    // race before assigning this session's private job.
                    if (!CreateProcess(exe, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                        0x00080000 | 0x00000004 | 0x00000400, IntPtr.Zero,
                        String.IsNullOrWhiteSpace(cwd) ? null : cwd, ref startup, out process))
                        ThrowLastError("Start shell");
                    processHandle = process.hProcess;
                    processId = unchecked((int)process.dwProcessId);
                    if (!AssignProcessToJobObject(jobHandle, processHandle))
                        ThrowLastError("Assign shell to session job");

                    // The pseudoconsole owns its copies. Keeping these host
                    // copies prevents EOF detection and can hang teardown.
                    Close(ref inputReadSide);
                    Close(ref outputWriteSide);
                    writerThread = NewThread(WriteInput, "TerminalGrid input");
                    writerThread.Start();
                    running = true;
                    if (ResumeThread(process.hThread) == UInt32.MaxValue) ThrowLastError("Resume shell");
                    started = true;
                    lifetimeThread = NewThread(WatchProcess, "TerminalGrid session");
                    lifetimeThread.Start();
                }
                catch
                {
                    running = false;
                    // It may still be suspended and not assigned to the job.
                    if (process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, 1);
                    StopInput();
                    CloseJob();
                    StartFailedCleanup();
                    throw;
                }
                finally
                {
                    Close(ref inputReadSide);
                    Close(ref outputWriteSide);
                    Close(ref process.hThread);
                    if (attributeList != IntPtr.Zero)
                    {
                        if (attributesInitialized) DeleteProcThreadAttributeList(attributeList);
                        Marshal.FreeHGlobal(attributeList);
                    }
                }
            }
        }

        /// <summary>Queues input without blocking the UI on a synchronous pipe.</summary>
        public void Write(byte[] data)
        {
            if (data == null) throw new ArgumentNullException("data");
            if (data.Length == 0 || !IsRunning) return;
            lock (inputGate)
            {
                if (inputStopping || !IsRunning) return;
                if (data.Length > MaxQueuedInput - inputBytes)
                    throw new InvalidOperationException("The terminal input queue is full. Wait before pasting more text.");
                byte[] copy = (byte[])data.Clone();
                inputQueue.Enqueue(copy);
                inputBytes += copy.Length;
                Monitor.Pulse(inputGate);
            }
        }

        public void Resize(int cols, int rows)
        {
            ValidateSize(cols, rows);
            lock (nativeGate)
            {
                if (disposed || pseudoConsole == IntPtr.Zero) return;
                int result = ResizePseudoConsole(pseudoConsole, new COORD((short)cols, (short)rows));
                if (result < 0 && IsRunning) Marshal.ThrowExceptionForHR(result);
            }
        }

        public void Dispose()
        {
            lock (stateGate)
            {
                if (disposed) return;
                disposed = true;
                running = false;
                StopInput();
                // Closing our unnamed, non-inheritable job kills only processes
                // launched by this session, including their ordinary children.
                CloseJob();
                if (!startAttempted) cleanupDone.Set();
            }
            // ClosePseudoConsole is deliberately never called on the UI or
            // output thread. A bounded wait also avoids a UI-join deadlock if
            // an event subscriber is itself waiting to dispatch to the UI.
            if (Thread.CurrentThread != readerThread && Thread.CurrentThread != writerThread && Thread.CurrentThread != lifetimeThread)
                cleanupDone.WaitOne(1000);
            GC.SuppressFinalize(this);
        }

        private void ReadOutput()
        {
            IntPtr pipe = Interlocked.Exchange(ref outputRead, IntPtr.Zero);
            readerNativeThread = OpenThread(0x0001, false, GetCurrentThreadId()); // THREAD_TERMINATE for CancelSynchronousIo
            byte[] buffer = new byte[8192];
            try
            {
                while (!outputStopping)
                {
                    uint count;
                    if (!ReadFile(pipe, buffer, (uint)buffer.Length, out count, IntPtr.Zero) || count == 0) break;
                    if (!disposed)
                    {
                        byte[] data = new byte[count];
                        Buffer.BlockCopy(buffer, 0, data, 0, (int)count);
                        Action<byte[]> callback = Output;
                        if (callback != null)
                        {
                            try { callback(data); }
                            catch { /* Presentation errors must not stop pipe draining. */ }
                        }
                    }
                }
            }
            finally
            {
                Close(ref pipe);
                CloseAtomic(ref readerNativeThread);
            }
        }

        private void WriteInput()
        {
            IntPtr pipe = Interlocked.Exchange(ref inputWrite, IntPtr.Zero);
            writerNativeThread = OpenThread(0x0001, false, GetCurrentThreadId());
            try
            {
                while (true)
                {
                    byte[] data;
                    lock (inputGate)
                    {
                        while (!inputStopping && inputQueue.Count == 0) Monitor.Wait(inputGate);
                        if (inputStopping) break;
                        data = inputQueue.Dequeue();
                        inputBytes -= data.Length;
                    }
                    GCHandle pin = GCHandle.Alloc(data, GCHandleType.Pinned);
                    try
                    {
                        int offset = 0;
                        while (!inputStopping && offset < data.Length)
                        {
                            uint written;
                            uint amount = (uint)Math.Min(8192, data.Length - offset);
                            if (!WriteFile(pipe, IntPtr.Add(pin.AddrOfPinnedObject(), offset), amount, out written, IntPtr.Zero) || written == 0)
                                return;
                            offset += (int)written;
                        }
                    }
                    finally { pin.Free(); }
                }
            }
            finally
            {
                Close(ref pipe);
                CloseAtomic(ref writerNativeThread);
            }
        }

        private void WatchProcess()
        {
            int exitCode = -1;
            try
            {
                if (WaitForSingleObject(processHandle, UInt32.MaxValue) == 0)
                {
                    uint code;
                    if (GetExitCodeProcess(processHandle, out code)) exitCode = unchecked((int)code);
                }
            }
            finally
            {
                running = false;
                CleanupResources();
                if (started)
                {
                    Action<int> callback = Exited;
                    if (callback != null)
                    {
                        try { callback(exitCode); }
                        catch { }
                    }
                }
            }
        }

        private void StartFailedCleanup()
        {
            lifetimeThread = NewThread(CleanupResources, "TerminalGrid failed-start cleanup");
            lifetimeThread.Start();
        }

        private void CleanupResources()
        {
            if (Interlocked.CompareExchange(ref cleanupStarted, 1, 0) != 0) return;
            try
            {
                StopInput();
                CloseJob();
                IntPtr console;
                lock (nativeGate)
                {
                    console = pseudoConsole;
                    pseudoConsole = IntPtr.Zero;
                }
                // Keep the output worker draining while this potentially
                // blocking call emits the console's final output frame.
                if (console != IntPtr.Zero) ClosePseudoConsole(console);
                if (readerThread != null && readerThread != Thread.CurrentThread && !readerThread.Join(3000))
                {
                    outputStopping = true;
                    CancelWorker(ref readerNativeThread);
                    readerThread.Join(500);
                }
                if (writerThread != null && writerThread != Thread.CurrentThread && !writerThread.Join(250))
                {
                    CancelWorker(ref writerNativeThread);
                    writerThread.Join(500);
                }
                CloseAtomic(ref inputWrite); // no writer was started on failure
                CloseAtomic(ref outputRead); // no reader was started on failure
                CloseAtomic(ref processHandle);
            }
            finally { cleanupDone.Set(); }
        }

        private void StopInput()
        {
            lock (inputGate)
            {
                inputStopping = true;
                inputQueue.Clear();
                inputBytes = 0;
                Monitor.PulseAll(inputGate);
            }
        }

        private void CloseJob() { CloseAtomic(ref jobHandle); }

        private static void CancelWorker(ref IntPtr nativeThread)
        {
            IntPtr handle = Interlocked.Exchange(ref nativeThread, IntPtr.Zero);
            if (handle == IntPtr.Zero) return;
            CancelSynchronousIo(handle);
            CloseHandle(handle);
        }

        private static Thread NewThread(ThreadStart action, string name)
        {
            Thread thread = new Thread(action);
            thread.IsBackground = true;
            thread.Name = name;
            return thread;
        }

        private static void ValidateSize(int cols, int rows)
        {
            if (cols < 1 || cols > Int16.MaxValue) throw new ArgumentOutOfRangeException("cols");
            if (rows < 1 || rows > Int16.MaxValue) throw new ArgumentOutOfRangeException("rows");
        }

        private static string QuoteArgument(string value)
        {
            // Executable paths cannot contain a quote. Reject it rather than
            // creating a command line with an ambiguous first argument.
            if (value.IndexOf('"') >= 0) throw new ArgumentException("Invalid executable path.", "exe");
            return "\"" + value + "\"";
        }

        private static void ThrowLastError(string operation)
        {
            int error = Marshal.GetLastWin32Error();
            throw new Win32Exception(error, operation + ": " + new Win32Exception(error).Message);
        }

        private static void Close(ref IntPtr handle)
        {
            IntPtr value = handle;
            handle = IntPtr.Zero;
            if (value != IntPtr.Zero && value != new IntPtr(-1)) CloseHandle(value);
        }

        private static void CloseAtomic(ref IntPtr handle)
        {
            IntPtr value = Interlocked.Exchange(ref handle, IntPtr.Zero);
            if (value != IntPtr.Zero && value != new IntPtr(-1)) CloseHandle(value);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct COORD
        {
            public short X;
            public short Y;
            public COORD(short x, short y) { X = x; Y = y; }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attributes, uint size);
        [DllImport("kernel32.dll")]
        private static extern int CreatePseudoConsole(COORD size, IntPtr input, IntPtr output, uint flags, out IntPtr console);
        [DllImport("kernel32.dll")]
        private static extern int ResizePseudoConsole(IntPtr console, COORD size);
        [DllImport("kernel32.dll")]
        private static extern void ClosePseudoConsole(IntPtr console);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ReadFile(IntPtr handle, byte[] buffer, uint requested, out uint read, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WriteFile(IntPtr handle, IntPtr buffer, uint requested, out uint written, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenThread(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint id);
        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CancelSynchronousIo(IntPtr thread);
    }
}
