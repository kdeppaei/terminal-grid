using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using TerminalGridIntegrated;
class BatchRunTests
{
    static int count;
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); count++; }
    static void Until(Func<bool> done) { var timer = Stopwatch.StartNew(); while (!done()) { if (timer.ElapsedMilliseconds > 15000) throw new Exception("Batch test timed out"); Thread.Sleep(40); } }
    public static int Main(string[] args)
    {
        string root = Path.Combine(Path.GetFullPath(args[0]), "batch-" + Guid.NewGuid().ToString("N"), "中文 folder & ! %TG_BATCH_TEST% (one)");
        Directory.CreateDirectory(root);
        string batch = Path.Combine(root, "run & ! %TG_BATCH_TEST% ' .bat");
        string content = "@echo off\r\nchcp 65001 >nul\r\nsetlocal enabledelayedexpansion\r\nfor /l %%n in (1,1,3) do echo line-%%n>>relative.txt\r\nsetlocal disabledelayedexpansion\r\n>full.txt echo \"%~f0\"\r\n>before.txt echo ready\r\npause >nul\r\n>after.txt echo continued\r\nexit /b 7\r\n";
        File.WriteAllText(batch, content, new UTF8Encoding(false));
        string old = Environment.GetEnvironmentVariable("TG_BATCH_TEST");
        string oldBatch = Environment.GetEnvironmentVariable("TERMINALGRID_BATCH_FILE");
        Environment.SetEnvironmentVariable("TG_BATCH_TEST", "must-not-expand");
        try {
            var built = ShellBuilder.Build(new PaneConfig { shell = "CMD", batchFile = batch, command = "echo MUST_NOT_RUN", cwd = Path.GetTempPath() });
            Check(built.Directory == root && built.TemporaryScript == null, "original file and its directory used without rewritten script");
            using (var exited = new ManualResetEvent(false)) using (var pty = new PtySession()) {
                pty.Output += bytes => { if (Encoding.UTF8.GetString(bytes).Contains("\x1b[6n")) pty.Write(Encoding.ASCII.GetBytes("\x1b[1;1R")); };
                pty.Exited += code => exited.Set();
                pty.Start(built.Executable, built.Arguments, built.Directory, 200, 25, built.EnvironmentOverrides);
                Until(() => File.Exists(Path.Combine(root, "before.txt")));
                Check(File.ReadAllLines(Path.Combine(root, "relative.txt")).Length == 3, "loops and relative files execute in original folder");
                Check(File.ReadAllText(Path.Combine(root, "full.txt"), Encoding.UTF8).Trim().Trim('"') == batch, "percent, bang, spaces, Unicode and shell metacharacters preserve original batch path");
                Check(!File.Exists(Path.Combine(root, "after.txt")), "batch pause waits for terminal input");
                pty.Write(Encoding.ASCII.GetBytes(" "));
                Until(() => File.Exists(Path.Combine(root, "after.txt")));
                Check(!exited.WaitOne(250), "CMD remains interactive after batch exit /b");
                pty.Write(Encoding.ASCII.GetBytes("exit 0\r"));
                Check(exited.WaitOne(10000), "terminal can be closed normally");
            }
            Check(File.ReadAllText(batch, Encoding.UTF8) == content, "source BAT is never modified");
            Check(Environment.GetEnvironmentVariable("TERMINALGRID_BATCH_FILE") == oldBatch, "child batch path does not alter host environment");
            var config = AppConfig.Normalize(null); config.workspaces[0].slots[0].tabs[0].batchFile = batch;
            Check(ConfigStore.ParseAppConfig(ConfigStore.Serializer().Serialize(config)).workspaces[0].slots[0].tabs[0].batchFile == batch, "batch reference survives config round trip without execution");
            string cmd = Path.Combine(root, "exit.CMD"); File.WriteAllText(cmd, "@exit 23\r\n", Encoding.ASCII);
            built = ShellBuilder.Build(new PaneConfig { shell = "CMD", batchFile = cmd });
            using (var exited = new ManualResetEvent(false)) using (var pty = new PtySession()) {
                int result = 0; pty.Output += bytes => { if (Encoding.UTF8.GetString(bytes).Contains("\x1b[6n")) pty.Write(Encoding.ASCII.GetBytes("\x1b[1;1R")); }; pty.Exited += code => { result = code; exited.Set(); };
                pty.Start(built.Executable, built.Arguments, built.Directory, 120, 25, built.EnvironmentOverrides);
                Check(exited.WaitOne(10000) && result == 23, "CMD extension and explicit exit code preserved");
            }
            try { ShellBuilder.ValidateBatchFile(Path.Combine(root, "missing.bat")); throw new Exception("Missing BAT accepted"); } catch (FileNotFoundException) { count++; }
            try { ShellBuilder.ValidateBatchFile(Path.Combine(root, "wrong.exe")); throw new Exception("Wrong extension accepted"); } catch (ArgumentException) { count++; }
            Console.WriteLine("Batch: " + count + " checks passed; actual CMD/ConPTY with local fixture BATs only."); return 0;
        } catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
        finally { Environment.SetEnvironmentVariable("TG_BATCH_TEST", old); }
    }
}
