using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace TerminalGridIntegrated
{
    // .NET Framework Process.Start writes Console.InputEncoding's preamble to
    // redirected stdin before callers can access BaseStream. Use byte pipes so
    // file contents stay exact without changing the host's console encoding.
    internal sealed class AdbProcess : IDisposable
    {
        IntPtr handle;
        public FileStream StandardInput, StandardOutput;
        public StreamReader StandardError;

        public static AdbProcess Start(string executable, string arguments)
        {
            var child = new AdbProcess();
            SafeFileHandle inputRead = null, inputWrite = null, outputRead = null, outputWrite = null, errorRead = null, errorWrite = null;
            IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero;
            bool initialized = false;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            try {
                Pipe(out inputRead, out inputWrite, false);
                Pipe(out outputRead, out outputWrite, true);
                Pipe(out errorRead, out errorWrite, true);
                child.StandardInput = new FileStream(inputWrite, FileAccess.Write, 1, false);
                child.StandardOutput = new FileStream(outputRead, FileAccess.Read, 4096, false);
                child.StandardError = new StreamReader(new FileStream(errorRead, FileAccess.Read, 4096, false), Encoding.UTF8);
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                attributes = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
                initialized = true;
                handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
                Marshal.WriteIntPtr(handles, 0, inputRead.DangerousGetHandle());
                Marshal.WriteIntPtr(handles, IntPtr.Size, outputWrite.DangerousGetHandle());
                Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, errorWrite.DangerousGetHandle());
                // Inherit only these three handles, not other live terminals.
                if (!UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x20002, handles, (IntPtr)(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
                var startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.StartupInfo.dwFlags = 0x100;
                startup.StartupInfo.hStdInput = inputRead.DangerousGetHandle();
                startup.StartupInfo.hStdOutput = outputWrite.DangerousGetHandle();
                startup.StartupInfo.hStdError = errorWrite.DangerousGetHandle();
                startup.lpAttributeList = attributes;
                var command = new StringBuilder(ShellBuilder.Quote(executable) + " " + arguments);
                if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000000 | 0x00080000, IntPtr.Zero, null, ref startup, out process)) throw new Win32Exception(Marshal.GetLastWin32Error());
                child.handle = process.hProcess;
                return child;
            } catch {
                child.Dispose();
                if (inputWrite != null) inputWrite.Dispose();
                if (outputRead != null) outputRead.Dispose();
                if (errorRead != null) errorRead.Dispose();
                throw;
            } finally {
                if (inputRead != null) inputRead.Dispose();
                if (outputWrite != null) outputWrite.Dispose();
                if (errorWrite != null) errorWrite.Dispose();
                if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
                if (initialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            }
        }
        static void Pipe(out SafeFileHandle read, out SafeFileHandle write, bool parentReads)
        {
            var security = new SECURITY_ATTRIBUTES { length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), inherit = true };
            if (!CreatePipe(out read, out write, ref security, 65536)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!SetHandleInformation(parentReads ? read : write, 1, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        public bool WaitForExit(int milliseconds)
        {
            uint result = WaitForSingleObject(handle, (uint)milliseconds);
            if (result == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
            return result == 0;
        }
        public bool HasExited { get { return WaitForExit(0); } }
        public int ExitCode { get { uint code; if (!GetExitCodeProcess(handle, out code)) throw new Win32Exception(Marshal.GetLastWin32Error()); return unchecked((int)code); } }
        public void Kill()
        {
            if (handle == IntPtr.Zero || HasExited) return;
            if (!TerminateProcess(handle, 1)) {
                int error = Marshal.GetLastWin32Error();
                // Termination is asynchronous. A second caller can receive
                // ACCESS_DENIED while the same child is already exiting.
                if (!WaitForExit(5000)) throw new Win32Exception(error);
            }
        }
        public void Dispose()
        {
            if (handle != IntPtr.Zero) { Kill(); WaitForExit(5000); CloseHandle(handle); handle = IntPtr.Zero; }
            if (StandardInput != null) StandardInput.Dispose();
            if (StandardOutput != null) StandardOutput.Dispose();
            if (StandardError != null) StandardError.Dispose();
        }
        [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO
        {
            public int cb; public string lpReserved, lpDesktop, lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }
        [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
        [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint processId, threadId; }
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, ref SECURITY_ATTRIBUTES security, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
        [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr handle, uint code);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    }
}
