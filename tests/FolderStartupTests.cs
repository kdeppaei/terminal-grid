using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using TerminalGridIntegrated;

internal static class FolderStartupTests
{
    private static int assertions;
    private static void Check(bool value, string label)
    {
        assertions++;
        if (!value) throw new Exception("FAIL: " + label);
        Console.WriteLine("PASS: " + label);
    }

    private sealed class Probe : IDisposable
    {
        public readonly PtySession Pty = new PtySession();
        public readonly ManualResetEvent Exit = new ManualResetEvent(false);
        private readonly StringBuilder text = new StringBuilder();
        private readonly Decoder decoder = Encoding.UTF8.GetDecoder();
        private readonly object gate = new object();
        public int ExitCode;
        public Probe()
        {
            Pty.Output += delegate(byte[] bytes) {
                char[] chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
                int count = decoder.GetChars(bytes, 0, bytes.Length, chars, 0, false);
                string chunk = new string(chars, 0, count);
                lock (gate) text.Append(chunk);
                if (chunk.Contains("\x1b[6n")) Pty.Write(Encoding.ASCII.GetBytes("\x1b[1;1R"));
            };
            Pty.Exited += delegate(int code) { ExitCode = code; Exit.Set(); };
        }
        public string Text { get { lock (gate) return text.ToString(); } }
        public void Dispose() { Pty.Dispose(); }
    }

    private static string PlainText(string value)
    {
        value = Regex.Replace(value, "\x1b\\][^\x07\x1b]*(?:\x07|\x1b\\\\)", "");
        value = Regex.Replace(value, "\x1b\\[[0-?]*[ -/]*[@-~]", "");
        return value.Replace("\r", "").Replace("\0", "");
    }

    private static void CheckShell(string shell, string selectedFolder, string results)
    {
        string expectedMarker = "__TG_CWD_" + Guid.NewGuid().ToString("N") + "__";
        string endMarker = "__TG_CWD_END__";
        string command = shell == "CMD"
            ? "echo " + expectedMarker + "\r\ncd\r\necho " + endMarker + "\r\nexit 0"
            : "[Console]::WriteLine('" + expectedMarker + "'); [Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).ProviderPath))); [Console]::WriteLine('" + endMarker + "'); exit 0";
        // The chosen folder is configuration data only. It is never inserted into shell input.
        ShellCommand built = ShellBuilder.Build(new PaneConfig { shell = shell, cwd = selectedFolder, command = command });
        try
        {
            Check(String.Equals(built.Directory, selectedFolder, StringComparison.Ordinal), shell + " passes the exact selected folder as process working directory");
            Check(built.Arguments.IndexOf(selectedFolder, StringComparison.Ordinal) < 0 && command.IndexOf(selectedFolder, StringComparison.Ordinal) < 0,
                shell + " does not inject the selected folder into arguments or startup commands");
            using (Probe probe = new Probe())
            {
                probe.Pty.Start(built.Executable, built.Arguments, built.Directory, 400, 30);
                if (!probe.Exit.WaitOne(18000)) throw new Exception(shell + " folder probe timed out. " + probe.Text);
                Check(probe.ExitCode == 0, shell + " folder probe exits cleanly");
                string output = PlainText(probe.Text);
                File.WriteAllText(Path.Combine(results, shell.ToLowerInvariant() + "-folder-output.log"), probe.Text, new UTF8Encoding(false));
                int begin = output.IndexOf(expectedMarker, StringComparison.Ordinal);
                int end = begin < 0 ? -1 : output.IndexOf(endMarker, begin + expectedMarker.Length, StringComparison.Ordinal);
                Check(begin >= 0 && end > begin, shell + " reports both process-output markers");
                string actual = output.Substring(begin + expectedMarker.Length, end - begin - expectedMarker.Length).Trim();
                if (shell != "CMD") actual = Encoding.UTF8.GetString(Convert.FromBase64String(actual));
                Check(String.Equals(actual, selectedFolder, StringComparison.OrdinalIgnoreCase), shell + " process confirms selected folder containing spaces, Chinese, apostrophe, ampersand and percent variables");
            }
        }
        finally { ShellBuilder.Clean(built); }
    }

    public static int Main(string[] args)
    {
        string previous = Environment.GetEnvironmentVariable("TG_FOLDER_CWD_TEST", EnvironmentVariableTarget.Process);
        try
        {
            string results = Path.GetFullPath(args.Length > 0 ? args[0] : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "test-results"));
            Directory.CreateDirectory(results);
            string selectedFolder = Path.Combine(results, "folder cases " + Guid.NewGuid().ToString("N"), "中文 folder's & %TG_FOLDER_CWD_TEST%");
            Directory.CreateDirectory(selectedFolder);
            Environment.SetEnvironmentVariable("TG_FOLDER_CWD_TEST", "must-not-expand", EnvironmentVariableTarget.Process);
            Check(FolderPicker.InitialFolder(selectedFolder) == selectedFolder, "picker keeps an existing literal folder before any environment expansion");
            Check(FolderPicker.InitialFolder("") == Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "picker opens the user folder for a blank starting folder");
            Check(FolderPicker.InitialFolder(Path.GetPathRoot(selectedFolder)) == Path.GetPathRoot(selectedFolder), "picker accepts a drive root");
            Check(FolderPicker.InitialFolder(Path.Combine(selectedFolder, "missing", "nested")) == selectedFolder,
                "picker falls back to the nearest existing parent when a saved folder was removed");
            CheckShell("CMD", selectedFolder, results);
            CheckShell("PowerShell", selectedFolder, results);
            Console.WriteLine("OK: " + assertions + " folder assertions; actual local CMD and Windows PowerShell, no network traffic.");
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
        finally { Environment.SetEnvironmentVariable("TG_FOLDER_CWD_TEST", previous, EnvironmentVariableTarget.Process); }
    }
}
