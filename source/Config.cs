using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;

namespace TerminalGridIntegrated
{
    public sealed class PaneConfig
    {
        public string name { get; set; }
        public string shell { get; set; }
        public string command { get; set; }
        public string cwd { get; set; }
        public string exe { get; set; }
        public string args { get; set; }
        public PaneConfig() { name = ""; shell = "PowerShell"; command = cwd = exe = args = ""; }
    }
    public sealed class LayoutConfig
    {
        public int version { get; set; }
        public int rows { get; set; }
        public int cols { get; set; }
        public int fontSize { get; set; }
        public List<PaneConfig> slots { get; set; }
        public LayoutConfig() { version = 1; rows = cols = 2; fontSize = 13; slots = new List<PaneConfig>(); }
        public static LayoutConfig Normalize(LayoutConfig config)
        {
            if (config == null) config = new LayoutConfig();
            config.version = 1;
            config.rows = Math.Max(1, Math.Min(4, config.rows)); config.cols = Math.Max(1, Math.Min(4, config.cols));
            config.fontSize = Math.Max(10, Math.Min(24, config.fontSize));
            if (config.slots == null) config.slots = new List<PaneConfig>();
            config.slots = config.slots.Take(16).ToList();
            while (config.slots.Count < 16) config.slots.Add(new PaneConfig());
            for (int i = 0; i < 16; i++)
            {
                PaneConfig pane = config.slots[i] ?? new PaneConfig();
                pane.name = String.IsNullOrWhiteSpace(pane.name) ? "終端 " + (i + 1) : Limit(pane.name, 80);
                if (!new[] { "CMD", "PowerShell", "PowerShell 7", "Custom" }.Contains(pane.shell)) pane.shell = "PowerShell";
                pane.command = Limit(pane.command, 16000); pane.cwd = Limit(pane.cwd, 4096); pane.exe = Limit(pane.exe, 4096); pane.args = Limit(pane.args, 16000);
                config.slots[i] = pane;
            }
            return config;
        }
        static string Limit(string value, int maximum) { value = value ?? ""; return value.Length > maximum ? value.Substring(0, maximum) : value; }
    }
    public static class ConfigStore
    {
        public static readonly string DataFolder = String.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("TERMINALGRID_DATA_DIR")) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TerminalGridIntegrated") : Path.GetFullPath(Environment.GetEnvironmentVariable("TERMINALGRID_DATA_DIR"));
        public static readonly string DefaultPath = Path.Combine(DataFolder, "layout.json");
        public static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024, RecursionLimit = 64 }; }
        public static LayoutConfig Parse(string json) { return LayoutConfig.Normalize(Serializer().Deserialize<LayoutConfig>(json)); }
        public static LayoutConfig Read(string path)
        {
            if (new FileInfo(path).Length > 1024 * 1024) throw new InvalidDataException("配置檔超過 1 MB。");
            return Parse(File.ReadAllText(path, Encoding.UTF8));
        }
        public static void Write(string path, LayoutConfig config)
        {
            path = Path.GetFullPath(path); Directory.CreateDirectory(Path.GetDirectoryName(path));
            string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(temporary, Serializer().Serialize(LayoutConfig.Normalize(config)), new UTF8Encoding(false));
                if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
    }
    public sealed class ShellCommand
    {
        public string Executable, Arguments, Directory, TemporaryScript;
    }
    public static class ShellBuilder
    {
        public static string FindExecutable(string name)
        {
            if (String.IsNullOrWhiteSpace(name)) return null;
            name = Environment.ExpandEnvironmentVariables(name.Trim().Trim('"'));
            if (Path.IsPathRooted(name)) return File.Exists(name) && String.Equals(Path.GetExtension(name), ".exe", StringComparison.OrdinalIgnoreCase) ? Path.GetFullPath(name) : null;
            List<string> directories = new List<string>();
            directories.Add(Environment.SystemDirectory);
            directories.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "PowerShell", "7"));
            directories.AddRange((Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'));
            foreach (string directory in directories)
            {
                try
                {
                    if (String.IsNullOrWhiteSpace(directory)) continue;
                    string candidate = Path.Combine(Environment.ExpandEnvironmentVariables(directory.Trim().Trim('"')), name);
                    if (String.IsNullOrEmpty(Path.GetExtension(candidate))) candidate += ".exe";
                    if (File.Exists(candidate) && String.Equals(Path.GetExtension(candidate), ".exe", StringComparison.OrdinalIgnoreCase)) return Path.GetFullPath(candidate);
                }
                catch (ArgumentException) { }
                catch (NotSupportedException) { }
                catch (PathTooLongException) { }
            }
            return null;
        }
        public static ShellCommand Build(PaneConfig pane)
        {
            ShellCommand result = new ShellCommand();
            string selectedDirectory = pane.cwd ?? "";
            // A folder selected from Windows may literally contain %NAME%.
            // Prefer the existing path before expanding manually typed environment variables.
            result.Directory = String.IsNullOrWhiteSpace(selectedDirectory) ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) :
                Directory.Exists(selectedDirectory) ? Path.GetFullPath(selectedDirectory) : Environment.ExpandEnvironmentVariables(selectedDirectory.Trim());
            if (!Directory.Exists(result.Directory)) throw new DirectoryNotFoundException("工作目錄不存在：" + result.Directory);
            if (pane.shell == "CMD")
            {
                result.Executable = Path.Combine(Environment.SystemDirectory, "cmd.exe");
                result.Arguments = "/D /Q /K";
                if (!String.IsNullOrWhiteSpace(pane.command))
                {
                    string folder = Path.Combine(ConfigStore.DataFolder, "startup"); Directory.CreateDirectory(folder);
                    result.TemporaryScript = Path.Combine(folder, Guid.NewGuid().ToString("N") + ".cmd");
                    File.WriteAllText(result.TemporaryScript, "@echo off\r\nchcp 65001 >nul\r\n" + pane.command.Replace("\r\n", "\n").Replace("\n", "\r\n") + "\r\n@echo on\r\n", new UTF8Encoding(false));
                    result.Arguments += " call " + Quote(result.TemporaryScript);
                }
            }
            else if (pane.shell == "PowerShell" || pane.shell == "PowerShell 7")
            {
                result.Executable = pane.shell == "PowerShell 7" ? FindExecutable("pwsh.exe") : Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
                if (String.IsNullOrWhiteSpace(result.Executable) || !File.Exists(result.Executable)) throw new FileNotFoundException("找不到 " + pane.shell + "，請改用 PowerShell 或在設定中指定執行檔。");
                result.Arguments = "-NoLogo -NoProfile -NoExit";
                if (!String.IsNullOrWhiteSpace(pane.command)) result.Arguments += " -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(pane.command));
            }
            else if (pane.shell == "Custom")
            {
                result.Executable = FindExecutable(pane.exe);
                if (result.Executable == null) throw new FileNotFoundException("找不到自訂的命令列 .exe：" + pane.exe);
                result.Arguments = pane.args ?? "";
            }
            else throw new ArgumentException("不支援的 Shell。");
            return result;
        }
        public static string Quote(string value)
        {
            StringBuilder result = new StringBuilder("\""); int slashes = 0;
            foreach (char c in value ?? "")
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
                result.Append('\\', slashes); slashes = 0; result.Append(c);
            }
            result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
        }
        public static void Clean(ShellCommand command)
        {
            if (command == null || command.TemporaryScript == null) return;
            try { File.Delete(command.TemporaryScript); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
