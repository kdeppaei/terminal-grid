using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using TerminalGridIntegrated;

internal static class PtySelfTest
{
    private sealed class Probe : IDisposable
    {
        public PtySession Pty = new PtySession();
        private StringBuilder text = new StringBuilder();
        private Decoder decoder = Encoding.UTF8.GetDecoder();
        private object gate = new object();
        public ManualResetEvent Exit = new ManualResetEvent(false);
        public int ExitCode;
        public Probe()
        {
            Pty.Output += delegate(byte[] bytes) {
                char[] chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
                int count = decoder.GetChars(bytes, 0, bytes.Length, chars, 0, false);
                string chunk = new string(chars, 0, count);
                lock(gate) text.Append(chunk);
                if (chunk.Contains("\x1b[6n")) Pty.Write(Encoding.ASCII.GetBytes("\x1b[1;1R"));
            };
            Pty.Exited += delegate(int code) { ExitCode = code; Exit.Set(); };
        }
        public string Text { get { lock(gate) return text.ToString(); } }
        public void Send(string command) { Pty.Write(Encoding.UTF8.GetBytes(command)); }
        public void Expect(string marker, int seconds)
        {
            Stopwatch timer = Stopwatch.StartNew();
            while(timer.ElapsedMilliseconds < seconds * 1000)
            {
                if (Text.Contains(marker)) return;
                Thread.Sleep(40);
            }
            throw new Exception("Missing marker " + marker + "\n" + Text);
        }
        public void Dispose() { Pty.Dispose(); }
    }

    public static int Main(string[] arguments)
    {
        try
        {
            string results = Path.GetFullPath(arguments.Length > 0 ? arguments[0] : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "test-results"));
            Directory.CreateDirectory(results);
            string cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe");
            string ps = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            string cwd = Environment.CurrentDirectory;
            using(Probe p = new Probe())
            {
                p.Pty.Start(cmd, "/D /Q", cwd, 80, 24);
                p.Send("echo __TG_READY__\r");
                p.Expect("__TG_READY__", 8);
                p.Send("ping -t 127.0.0.1\r");
                p.Expect("TTL=", 8);
                p.Send("\x03");
                Thread.Sleep(400);
                p.Send("echo __TG_AFTER_CTRL_C__\r");
                p.Expect("__TG_AFTER_CTRL_C__", 8);
                p.Send("exit 7\r");
                if (!p.Exit.WaitOne(10000) || p.ExitCode != 7) throw new Exception("CMD exit code was not 7.");
                if(p.Pty.IsRunning) throw new Exception("CMD still marked running.");
                File.WriteAllText(Path.Combine(results, "cmd-output.log"), p.Text, Encoding.UTF8);
                Console.WriteLine("PASS CMD input + ping + Ctrl+C + exit code + output drain");
            }
            using(Probe p = new Probe())
            {
                p.Pty.Start(ps, "-NoLogo -NoProfile -NoExit", cwd, 80, 24);
                Thread.Sleep(1000);
                p.Send("[Console]::WriteLine('終端中文測試')\r");
                p.Expect("終端中文測試", 12);
                p.Pty.Resize(101, 31);
                p.Send("[Console]::WriteLine(('SIZE{0}X{1}' -f [Console]::WindowWidth,[Console]::WindowHeight))\r");
                p.Expect("SIZE101X31", 12);
                p.Send("exit 0\r");
                if(!p.Exit.WaitOne(10000) || p.ExitCode != 0) throw new Exception("PowerShell did not exit cleanly.");
                File.WriteAllText(Path.Combine(results, "powershell-output.log"), p.Text, Encoding.UTF8);
                Console.WriteLine("PASS PowerShell UTF-8 interactive input + ConPTY resize");
            }
            string pidFile = Path.Combine(results, "child-pid.txt");
            if(File.Exists(pidFile)) File.Delete(pidFile);
            int shellPid;
            int childPid;
            using(Probe p = new Probe())
            {
                string command = "$p=Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 120' -NoNewWindow -PassThru; $p.Id | Set-Content -LiteralPath '" + pidFile.Replace("'", "''") + "'; Start-Sleep -Seconds 120";
                string args = "-NoLogo -NoProfile -Command " + QuoteArgument(command);
                p.Pty.Start(ps, args, cwd, 80, 24);
                shellPid=p.Pty.ProcessId;
                Stopwatch timer=Stopwatch.StartNew();
                while(!File.Exists(pidFile) && timer.ElapsedMilliseconds < 12000) Thread.Sleep(50);
                if(!File.Exists(pidFile)) throw new Exception("Child PID file missing. " + p.Text);
                childPid=Int32.Parse(File.ReadAllText(pidFile).Trim());
                if(!Alive(childPid)) throw new Exception("Child never started.");
                timer.Restart();
                p.Pty.Dispose();
                if(timer.ElapsedMilliseconds > 1500) throw new Exception("Dispose blocked UI too long.");
                if(!p.Exit.WaitOne(8000)) throw new Exception("Dispose did not finish cleanup.");
            }
            Thread.Sleep(200);
            if(Alive(shellPid) || Alive(childPid)) throw new Exception("Session job left live descendants.");
            Console.WriteLine("PASS bounded Dispose kills private shell and child process");

            using(Probe p = new Probe())
            {
                bool failed=false;
                try { p.Pty.Start(Path.Combine(results, "nonexistent-terminal-grid-shell.exe"), "", cwd,80,24); }
                catch(System.ComponentModel.Win32Exception) { failed=true; }
                if(!failed) throw new Exception("Missing shell was accepted.");
                Stopwatch timer=Stopwatch.StartNew();
                p.Pty.Dispose();
                if(timer.ElapsedMilliseconds > 1500) throw new Exception("Failed-start cleanup stalled.");
                Console.WriteLine("PASS failed Start resource cleanup");
            }
            Console.WriteLine("ALL CONPTY SELFTESTS PASSED");
            return 0;
        }
        catch(Exception ex) { Console.Error.WriteLine(ex.ToString()); return 1; }
    }
    private static string QuoteArgument(string value)
    {
        StringBuilder quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach(char c in value)
        {
            if(c == '\\') { slashes++; continue; }
            if(c == '"') { quoted.Append('\\', slashes * 2 + 1); quoted.Append(c); slashes = 0; continue; }
            quoted.Append('\\', slashes); slashes = 0; quoted.Append(c);
        }
        quoted.Append('\\', slashes * 2); quoted.Append('"'); return quoted.ToString();
    }
    private static bool Alive(int pid)
    {
        try { using(Process p=Process.GetProcessById(pid)) return !p.HasExited; }
        catch(ArgumentException) { return false; }
    }
}
