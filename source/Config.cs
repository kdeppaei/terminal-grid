using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;

namespace TerminalGridIntegrated
{
    public sealed class TerminalTabConfig
    {
        public string id { get; set; }
        public string name { get; set; }
        public string shell { get; set; }
        public string command { get; set; }
        public string cwd { get; set; }
        public string exe { get; set; }
        public string args { get; set; }
        public TerminalTabConfig() { id = ""; name = ""; shell = "CMD"; command = cwd = exe = args = ""; }
    }
    public sealed class PaneConfig
    {
        public string name { get; set; }
        public string shell { get; set; }
        public string command { get; set; }
        public string cwd { get; set; }
        public string exe { get; set; }
        public string args { get; set; }
        public string activeTabId { get; set; }
        public List<TerminalTabConfig> tabs { get; set; }
        public PaneConfig() { name = ""; shell = "PowerShell"; command = cwd = exe = args = ""; activeTabId = ""; tabs = new List<TerminalTabConfig>(); }
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
                if (pane.tabs == null || pane.tabs.Count == 0)
                    pane.tabs = new List<TerminalTabConfig> { new TerminalTabConfig { id = "tab-1", name = "終端 1", shell = pane.shell, command = pane.command, cwd = pane.cwd, exe = pane.exe, args = pane.args } };
                pane.tabs = pane.tabs.Take(8).Select((tab, tabIndex) => NormalizeTab(tab, tabIndex, pane)).ToList();
                HashSet<string> tabIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (TerminalTabConfig tab in pane.tabs)
                    if (!tabIds.Add(tab.id)) { tab.id = "tab-" + Guid.NewGuid().ToString("N").Substring(0, 12); tabIds.Add(tab.id); }
                if (!pane.tabs.Any(tab => tab.id == pane.activeTabId)) pane.activeTabId = pane.tabs[0].id;
                TerminalTabConfig activeTab = pane.tabs.First(tab => tab.id == pane.activeTabId);
                pane.shell = activeTab.shell; pane.command = activeTab.command; pane.cwd = activeTab.cwd; pane.exe = activeTab.exe; pane.args = activeTab.args;
                config.slots[i] = pane;
            }
            return config;
        }
        static TerminalTabConfig NormalizeTab(TerminalTabConfig tab, int index, PaneConfig legacy)
        {
            if (tab == null) tab = new TerminalTabConfig();
            tab.id = Limit(tab.id, 64);
            if (String.IsNullOrWhiteSpace(tab.id) || tab.id.Any(c => !Char.IsLetterOrDigit(c) && c != '-' && c != '_')) tab.id = "tab-" + (index + 1);
            tab.name = String.IsNullOrWhiteSpace(tab.name) ? "終端 " + (index + 1) : Limit(tab.name.Trim(), 48);
            if (!new[] { "CMD", "PowerShell", "PowerShell 7", "Custom" }.Contains(tab.shell)) tab.shell = legacy.shell;
            tab.command = Limit(tab.command, 16000); tab.cwd = Limit(tab.cwd, 4096); tab.exe = Limit(tab.exe, 4096); tab.args = Limit(tab.args, 16000);
            return tab;
        }
        static string Limit(string value, int maximum) { value = value ?? ""; return value.Length > maximum ? value.Substring(0, maximum) : value; }
    }
    public sealed class WorkspaceConfig
    {
        public string id { get; set; }
        public string name { get; set; }
        public int rows { get; set; }
        public int cols { get; set; }
        public int fontSize { get; set; }
        public List<PaneConfig> slots { get; set; }
        public WorkspaceConfig() { id = ""; name = ""; rows = cols = 2; fontSize = 13; slots = new List<PaneConfig>(); }
        public static WorkspaceConfig Normalize(WorkspaceConfig value, int index)
        {
            if (value == null) value = new WorkspaceConfig();
            LayoutConfig layout = LayoutConfig.Normalize(new LayoutConfig { rows = value.rows, cols = value.cols, fontSize = value.fontSize, slots = value.slots });
            value.rows = layout.rows; value.cols = layout.cols; value.fontSize = layout.fontSize; value.slots = layout.slots;
            value.id = Limit(value.id, 64);
            if (String.IsNullOrWhiteSpace(value.id) || value.id.Any(c => !Char.IsLetterOrDigit(c) && c != '-' && c != '_')) value.id = "workspace-" + (index + 1);
            value.name = String.IsNullOrWhiteSpace(value.name) ? "工作區 " + (index + 1) : Limit(value.name.Trim(), 48);
            return value;
        }
        static string Limit(string value, int maximum) { value = value ?? ""; return value.Length > maximum ? value.Substring(0, maximum) : value; }
    }
    public sealed class FlowStepConfig
    {
        public string action { get; set; }
        public int slot { get; set; }
        public string tabId { get; set; }
        public string text { get; set; }
        public int delayMs { get; set; }
        public bool enter { get; set; }
        public FlowStepConfig() { action = "send"; slot = 0; tabId = ""; text = ""; delayMs = 500; enter = true; }
    }
    public sealed class AutomationConfig
    {
        public string id { get; set; }
        public string name { get; set; }
        public string workspaceId { get; set; }
        public List<FlowStepConfig> steps { get; set; }
        public AutomationConfig() { id = ""; name = ""; workspaceId = ""; steps = new List<FlowStepConfig>(); }
    }
    public sealed class CommandSnippetConfig
    {
        public string id { get; set; }
        public string name { get; set; }
        public string description { get; set; }
        public string command { get; set; }
        public CommandSnippetConfig() { id = ""; name = ""; description = ""; command = ""; }
    }
    public sealed class CommandPackConfig
    {
        public string id { get; set; }
        public string name { get; set; }
        public List<CommandSnippetConfig> commands { get; set; }
        public CommandPackConfig() { id = ""; name = ""; commands = new List<CommandSnippetConfig>(); }
    }
    public sealed class AppConfig
    {
        public int version { get; set; }
        public string activeWorkspaceId { get; set; }
        public List<WorkspaceConfig> workspaces { get; set; }
        public List<AutomationConfig> automations { get; set; }
        public List<CommandPackConfig> commandPacks { get; set; }
        public AppConfig() { version = 2; activeWorkspaceId = ""; workspaces = new List<WorkspaceConfig>(); automations = new List<AutomationConfig>(); commandPacks = new List<CommandPackConfig>(); }
        public static AppConfig Normalize(AppConfig value)
        {
            if (value == null) value = new AppConfig();
            value.version = 2;
            if (value.workspaces == null) value.workspaces = new List<WorkspaceConfig>();
            value.workspaces = value.workspaces.Take(12).Select((workspace, index) => WorkspaceConfig.Normalize(workspace, index)).ToList();
            HashSet<string> ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < value.workspaces.Count; i++)
            {
                if (ids.Add(value.workspaces[i].id)) continue;
                value.workspaces[i].id = "workspace-" + (i + 1) + "-" + Guid.NewGuid().ToString("N").Substring(0, 6);
                ids.Add(value.workspaces[i].id);
            }
            if (value.workspaces.Count == 0)
            {
                WorkspaceConfig first = new WorkspaceConfig { id = "workspace-1", name = "工作區 1" };
                first.slots = Enumerable.Range(0, 16).Select(index => new PaneConfig { name = "終端 " + (index + 1).ToString("00"), shell = "CMD" }).ToList();
                value.workspaces.Add(WorkspaceConfig.Normalize(first, 0));
            }
            if (!value.workspaces.Any(w => w.id == value.activeWorkspaceId)) value.activeWorkspaceId = value.workspaces[0].id;
            if (value.automations == null) value.automations = new List<AutomationConfig>();
            value.automations = value.automations.Take(32).Where(flow => flow != null && value.workspaces.Any(w => w.id == flow.workspaceId)).ToList();
            foreach (AutomationConfig flow in value.automations)
            {
                flow.id = Limit(flow.id, 64); flow.name = String.IsNullOrWhiteSpace(flow.name) ? "自動化流程" : Limit(flow.name.Trim(), 64);
                if (flow.steps == null) flow.steps = new List<FlowStepConfig>();
                flow.steps = flow.steps.Take(100).Where(step => step != null).ToList();
                foreach (FlowStepConfig step in flow.steps)
                {
                    if (step.action != "start" && step.action != "send" && step.action != "wait" && step.action != "pause" && step.action != "stop") step.action = "send";
                    step.slot = Math.Max(0, Math.Min(15, step.slot));
                    step.tabId = Limit(step.tabId, 64);
                    step.delayMs = Math.Max(100, Math.Min(30000, step.delayMs));
                    step.text = Limit(step.text, 16000);
                }
            }
            if (value.commandPacks == null) value.commandPacks = new List<CommandPackConfig>();
            value.commandPacks = value.commandPacks.Take(32).Where(pack => pack != null).ToList();
            foreach (CommandPackConfig pack in value.commandPacks)
            {
                pack.id = Limit(pack.id, 64); pack.name = String.IsNullOrWhiteSpace(pack.name) ? "指令集" : Limit(pack.name.Trim(), 64);
                if (pack.commands == null) pack.commands = new List<CommandSnippetConfig>();
                pack.commands = pack.commands.Take(128).Where(command => command != null).ToList();
                foreach (CommandSnippetConfig command in pack.commands)
                {
                    command.id = Limit(command.id, 64); command.name = String.IsNullOrWhiteSpace(command.name) ? "常用指令" : Limit(command.name.Trim(), 80);
                    command.description = Limit(command.description, 240); command.command = Limit(command.command, 16000);
                }
            }
            return value;
        }
        static string Limit(string value, int maximum) { value = value ?? ""; return value.Length > maximum ? value.Substring(0, maximum) : value; }
    }
    public static class ConfigStore
    {
        public static readonly string DataFolder = String.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("TERMINALGRID_DATA_DIR")) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TerminalGridIntegrated") : Path.GetFullPath(Environment.GetEnvironmentVariable("TERMINALGRID_DATA_DIR"));
        public static readonly string DefaultPath = Path.Combine(DataFolder, "layout.json");
        public static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024, RecursionLimit = 64 }; }
        public static LayoutConfig Parse(string json) { return LayoutConfig.Normalize(Serializer().Deserialize<LayoutConfig>(json)); }
        public static AppConfig ParseAppConfig(string json)
        {
            JavaScriptSerializer serializer = Serializer();
            IDictionary<string, object> root = serializer.DeserializeObject(json) as IDictionary<string, object>;
            if (root != null && root.ContainsKey("workspaces")) return AppConfig.Normalize(serializer.Deserialize<AppConfig>(json));
            LayoutConfig legacy = LayoutConfig.Normalize(serializer.Deserialize<LayoutConfig>(json));
            AppConfig result = new AppConfig();
            result.workspaces.Add(WorkspaceConfig.Normalize(new WorkspaceConfig { id = "workspace-1", name = "工作區 1", rows = legacy.rows, cols = legacy.cols, fontSize = legacy.fontSize, slots = legacy.slots }, 0));
            result.activeWorkspaceId = result.workspaces[0].id;
            return result;
        }
        public static LayoutConfig Read(string path)
        {
            if (new FileInfo(path).Length > 1024 * 1024) throw new InvalidDataException("配置檔超過 1 MB。");
            return Parse(File.ReadAllText(path, Encoding.UTF8));
        }
        public static AppConfig ReadAppConfig(string path)
        {
            if (new FileInfo(path).Length > 2 * 1024 * 1024) throw new InvalidDataException("配置檔超過 2 MB。");
            return ParseAppConfig(File.ReadAllText(path, Encoding.UTF8));
        }
        public static void Write(string path, AppConfig config)
        {
            path = Path.GetFullPath(path); Directory.CreateDirectory(Path.GetDirectoryName(path));
            string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(temporary, Serializer().Serialize(AppConfig.Normalize(config)), new UTF8Encoding(false));
                if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
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
