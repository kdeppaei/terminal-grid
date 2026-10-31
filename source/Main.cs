using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: System.Reflection.AssemblyTitle("Terminal Grid Integrated")]
[assembly: System.Reflection.AssemblyDescription("Interactive embedded CMD and PowerShell terminal grid")]
[assembly: System.Reflection.AssemblyVersion("3.4.0.0")]

namespace TerminalGridIntegrated
{
    internal sealed class PaneState
    {
        public string WorkspaceId;
        public int Slot;
        public string TabId;
        public int Generation;
        public PtySession Session;
        public ShellCommand Command;
        public BlockingCollection<byte[]> Output = new BlockingCollection<byte[]>(256);
        public bool Starting, Stopping, ExitSent;
        public int? ExitCode;
        public int InFlight;
    }
    public sealed class TerminalForm : Form
    {
        const string Origin = "https://terminalgrid.local";
        readonly Dictionary<string, PaneState> panes = new Dictionary<string, PaneState>(StringComparer.OrdinalIgnoreCase);
        readonly WebView2 browser;
        readonly System.Windows.Forms.Timer outputTimer;
        AppConfig config;
        bool closing, closeApproved, ready, folderPickerOpen;
        string loadWarning = "";

        public TerminalForm()
        {
            Text = "Terminal Grid · 整合終端"; BackColor = Color.FromArgb(13, 19, 29);
            ClientSize = new Size(1360, 870); MinimumSize = new Size(900, 620);
            StartPosition = FormStartPosition.CenterScreen; AutoScaleMode = AutoScaleMode.Dpi;
            try { config = File.Exists(ConfigStore.DefaultPath) ? ConfigStore.ReadAppConfig(ConfigStore.DefaultPath) : AppConfig.Normalize(null); }
            catch (Exception ex) { config = AppConfig.Normalize(null); loadWarning = "配置無法載入，已使用預設值：" + ex.Message; }
            browser = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            Controls.Add(browser);
            outputTimer = new System.Windows.Forms.Timer { Interval = 25 };
            outputTimer.Tick += delegate { FlushAll(); };
            Shown += async delegate { await InitializeBrowser(); };
            FormClosing += OnClosing;
            FormClosed += delegate { outputTimer.Dispose(); };
        }
        async Task InitializeBrowser()
        {
            try
            {
                CoreWebView2Environment.GetAvailableBrowserVersionString();
                string profile = Path.Combine(ConfigStore.DataFolder, "WebView2");
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profile);
                await browser.EnsureCoreWebView2Async(environment);
                CoreWebView2 core = browser.CoreWebView2;
                core.Settings.AreDevToolsEnabled = false; core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsStatusBarEnabled = false; core.Settings.IsZoomControlEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
                {
                    Uri uri; if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out uri) || uri.Scheme != "https" || uri.Host != "terminalgrid.local") e.Cancel = true;
                };
                core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
                core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e)
                {
                    e.State = e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead && e.IsUserInitiated && e.Uri.StartsWith(Origin + "/", StringComparison.OrdinalIgnoreCase) ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
                };
                core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += delegate(object sender, CoreWebView2WebResourceRequestedEventArgs e)
                {
                    Uri uri;
                    if (!Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out uri) || uri.Scheme != "https" || uri.Host != "terminalgrid.local")
                        e.Response = environment.CreateWebResourceResponse(new MemoryStream(new byte[0]), 403, "Blocked", "Content-Type: text/plain");
                };
                core.WebMessageReceived += OnMessage;
                core.ProcessFailed += delegate(object sender, CoreWebView2ProcessFailedEventArgs e)
                {
                    if (closing) return;
                    Ui(delegate { MessageBox.Show(this, "終端畫面元件已停止。請重新開啟工具。關閉時會清理本工具的終端工作階段。", "Terminal Grid", MessageBoxButtons.OK, MessageBoxIcon.Warning); });
                };
                core.SetVirtualHostNameToFolderMapping("terminalgrid.local", Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ui"), CoreWebView2HostResourceAccessKind.DenyCors);
                core.Navigate(Origin + "/index.html");
                outputTimer.Start();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "無法載入終端介面：" + ex.Message + "\n\n本工具需要 Windows 10 1809 以上、.NET Framework 4.8 與 Microsoft Edge WebView2 Runtime。請保留 ZIP 內所有 DLL 與 ui 資料夾。", "Terminal Grid", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
        void Ui(Action action)
        {
            if (closing || IsDisposed || !IsHandleCreated) return;
            try { BeginInvoke((Action)delegate { if (!closing && !IsDisposed) action(); }); }
            catch (InvalidOperationException) { }
        }
        void Send(object value)
        {
            if (closing || !ready || browser.CoreWebView2 == null) return;
            try { browser.CoreWebView2.PostWebMessageAsJson(ConfigStore.Serializer().Serialize(value)); }
            catch (InvalidOperationException) { }
            catch (COMException) { }
        }
        void Status(string message) { Send(new { type = "status", message = message }); }
        static string StateKey(string workspaceId, int slot, string tabId) { return (workspaceId ?? "") + ":" + slot + ":" + (tabId ?? ""); }
        WorkspaceConfig FindWorkspace(string workspaceId)
        {
            return config.workspaces.FirstOrDefault(workspace => String.Equals(workspace.id, workspaceId, StringComparison.OrdinalIgnoreCase));
        }
        PaneState FindPane(string workspaceId, int slot, string tabId)
        {
            PaneState pane; return panes.TryGetValue(StateKey(workspaceId, slot, tabId), out pane) ? pane : null;
        }
        PaneState GetPane(string workspaceId, int slot, string tabId)
        {
            PaneState pane = FindPane(workspaceId, slot, tabId);
            if (pane != null) return pane;
            WorkspaceConfig workspace = FindWorkspace(workspaceId);
            if (workspace == null || !workspace.slots[slot].tabs.Any(tab => tab.id == tabId)) return null;
            pane = new PaneState { WorkspaceId = workspaceId, Slot = slot, TabId = tabId };
            panes.Add(StateKey(workspaceId, slot, tabId), pane);
            return pane;
        }
        void Error(string workspaceId, int slot, string tabId, string message, int generation)
        {
            Send(new { type = "error", workspaceId = workspaceId, slot = slot, tabId = tabId, message = message, generation = generation });
        }
        static string StringValue(IDictionary<string, object> message, string key)
        {
            object value; return message.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
        }
        static int IntValue(IDictionary<string, object> message, string key, int fallback)
        {
            int value; return Int32.TryParse(StringValue(message, key), out value) ? value : fallback;
        }
        bool ValidGeneration(IDictionary<string, object> message, PaneState pane)
        {
            return !message.ContainsKey("generation") || IntValue(message, "generation", -1) == pane.Generation;
        }
        void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (closing) return;
            Uri source;
            if (!Uri.TryCreate(e.Source, UriKind.Absolute, out source) || source.Scheme != "https" || source.Host != "terminalgrid.local" || source.AbsolutePath != "/index.html") return;
            try
            {
                var serializer = ConfigStore.Serializer();
                var message = serializer.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
                string type = StringValue(message, "type");
                if (type == "ready")
                {
                    ready = true;
                    Send(new { type = "init", config = config, version = "3.4.0", capabilities = new { pwsh = ShellBuilder.FindExecutable("pwsh.exe") != null } });
                    if (loadWarning.Length > 0) Status(loadWarning);
                    return;
                }
                if (type == "save" || type == "export")
                {
                    object value; if (!message.TryGetValue("config", out value)) return;
                    config = ConfigStore.ParseAppConfig(serializer.Serialize(value));
                    ConfigStore.Write(ConfigStore.DefaultPath, config);
                    if (type == "export") Ui(ExportConfig); else Status("配置已儲存。");
                    return;
                }
                if (type == "import") { Ui(ImportConfig); return; }
                if (type == "flowOpen") { Ui(OpenFlow); return; }
                if (type == "flowSave") { Ui(delegate { SaveFlow(StringValue(message, "text")); }); return; }
                if (type == "commandPackOpen") { Ui(OpenCommandPack); return; }
                if (type == "commandPackSave") { Ui(delegate { SaveCommandPack(StringValue(message, "text")); }); return; }
                int index = IntValue(message, "slot", -1);
                if (index < 0 || index >= 16) return;
                string workspaceId = StringValue(message, "workspaceId");
                if (String.IsNullOrWhiteSpace(workspaceId)) workspaceId = config.activeWorkspaceId;
                WorkspaceConfig targetWorkspace = FindWorkspace(workspaceId);
                string tabId = StringValue(message, "tabId");
                if (String.IsNullOrWhiteSpace(tabId) && targetWorkspace != null) tabId = targetWorkspace.slots[index].activeTabId;
                if (type == "pickFolder")
                {
                    if (targetWorkspace == null) return;
                    QueueFolderPicker(workspaceId, index, tabId, StringValue(message, "requestId"), StringValue(message, "initialPath"));
                    return;
                }
                PaneState pane = GetPane(workspaceId, index, tabId);
                if (pane == null) return;
                if (!ValidGeneration(message, pane)) return;
                if (type == "start" || type == "restart")
                {
                    object value; if (!message.TryGetValue("config", out value)) return;
                    TerminalTabConfig tabConfig = serializer.Deserialize<TerminalTabConfig>(serializer.Serialize(value));
                    PaneConfig paneConfig = new PaneConfig { name = tabConfig.name, shell = tabConfig.shell, command = tabConfig.command, cwd = tabConfig.cwd, exe = tabConfig.exe, args = tabConfig.args };
                    var temp = LayoutConfig.Normalize(new LayoutConfig { slots = new List<PaneConfig> { paneConfig } }); paneConfig = temp.slots[0];
                    int cols = Clamp(IntValue(message, "cols", 80), 2, 500), rows = Clamp(IntValue(message, "rows", 24), 1, 300);
                    if (type == "restart") RestartSlot(workspaceId, index, tabId, paneConfig, cols, rows); else StartSlot(workspaceId, index, tabId, paneConfig, cols, rows);
                }
                else if (type == "ack")
                {
                    pane.InFlight = Math.Max(0, pane.InFlight - Clamp(IntValue(message, "bytes", 0), 0, 1024 * 1024));
                }
                else if (type == "input")
                {
                    string data = StringValue(message, "data");
                    if (data.Length > 1024 * 1024) throw new ArgumentException("貼上內容過大，請分批貼上。");
                    if (pane.Session != null && !pane.Stopping) pane.Session.Write(Encoding.UTF8.GetBytes(data));
                }
                else if (type == "resize")
                {
                    if (pane.Session != null && !pane.Starting && !pane.Stopping)
                        pane.Session.Resize(Clamp(IntValue(message, "cols", 80), 2, 500), Clamp(IntValue(message, "rows", 24), 1, 300));
                }
                else if (type == "stop") StopSlot(workspaceId, index, tabId);
            }
            catch (Exception ex) { Status("操作未完成：" + ex.Message); }
        }
        void QueueFolderPicker(string workspaceId, int slot, string tabId, string requestId, string initialPath)
        {
            if (String.IsNullOrEmpty(requestId) || requestId.Length > 128)
            {
                Send(new { type = "folderPickError", workspaceId = workspaceId, slot = slot, tabId = tabId, requestId = requestId, message = "選擇資料夾請求無效，請重新開啟設定。" });
                return;
            }
            if (folderPickerOpen)
            {
                Send(new { type = "folderPickError", workspaceId = workspaceId, slot = slot, tabId = tabId, requestId = requestId, message = "請先完成目前的資料夾選擇。" });
                return;
            }
            folderPickerOpen = true;
            // WebView2 callbacks must return before entering a modal message loop.
            // Ui uses BeginInvoke so the owned STA dialog opens on a later UI turn.
            Ui(delegate
            {
                try
                {
                    string path = FolderPicker.Pick(this, initialPath);
                    Send(new { type = "folderPicked", workspaceId = workspaceId, slot = slot, tabId = tabId, requestId = requestId, path = path ?? "", cancelled = path == null });
                }
                catch (Exception ex)
                {
                    Send(new { type = "folderPickError", workspaceId = workspaceId, slot = slot, tabId = tabId, requestId = requestId, message = "無法選擇工作資料夾：" + ex.Message });
                }
                finally { folderPickerOpen = false; }
            });
        }
        static int Clamp(int value, int minimum, int maximum) { return Math.Max(minimum, Math.Min(maximum, value)); }
        async void StartSlot(string workspaceId, int index, string tabId, PaneConfig paneConfig, int cols, int rows)
        {
            PaneState pane = GetPane(workspaceId, index, tabId);
            if (pane == null) { Error(workspaceId, index, tabId, "找不到指定工作區或終端分頁。", 0); return; }
            if (closing || pane.Starting || pane.Stopping || pane.Session != null) return;
            if (panes.Values.Count(p => p.Session != null || p.Starting) >= 64)
            {
                Error(workspaceId, index, tabId, "同時執行的終端已達 64 格上限。", pane.Generation);
                return;
            }
            int generation = Interlocked.Increment(ref pane.Generation);
            pane.Starting = true; pane.ExitCode = null; pane.ExitSent = false; pane.InFlight = 0;
            var queue = new BlockingCollection<byte[]>(256); pane.Output = queue;
            PtySession session = new PtySession(); pane.Session = session;
            session.Output += delegate(byte[] data)
            {
                while (!closing && Thread.VolatileRead(ref pane.Generation) == generation)
                {
                    if (queue.TryAdd(data, 50)) break;
                }
            };
            session.Exited += delegate(int code)
            {
                Ui(delegate { if (pane.Generation == generation && pane.Session == session) pane.ExitCode = code; });
            };
            try
            {
                WorkspaceConfig workspace = FindWorkspace(workspaceId);
                if (workspace != null)
                {
                    PaneConfig cell = workspace.slots[index];
                    int tabIndex = cell.tabs.FindIndex(tab => tab.id == tabId);
                    if (tabIndex >= 0)
                    {
                        TerminalTabConfig tab = cell.tabs[tabIndex];
                        tab.name = paneConfig.name; tab.shell = paneConfig.shell; tab.command = paneConfig.command;
                        tab.cwd = paneConfig.cwd; tab.exe = paneConfig.exe; tab.args = paneConfig.args;
                        cell.activeTabId = tabId;
                    }
                    ConfigStore.Write(ConfigStore.DefaultPath, config);
                }
                ShellCommand command = ShellBuilder.Build(paneConfig); pane.Command = command;
                await Task.Run(delegate { session.Start(command.Executable, command.Arguments, command.Directory, cols, rows); });
                if (closing) { await Task.Run((Action)session.Dispose); ShellBuilder.Clean(command); return; }
                if (pane.Generation != generation) return;
                pane.Starting = false;
                Send(new { type = "started", workspaceId = workspaceId, slot = index, tabId = tabId, pid = session.ProcessId, generation = generation });
            }
            catch (Exception ex)
            {
                DisposeLater(session);
                if (pane.Generation == generation)
                {
                    pane.Starting = false; pane.Session = null; pane.ExitSent = true;
                    ShellBuilder.Clean(pane.Command); pane.Command = null;
                    Error(workspaceId, index, tabId, ex.Message, generation);
                }
            }
        }
        static void DisposeLater(PtySession session) { Task.Run((Action)session.Dispose); }
        async void StopSlot(string workspaceId, int index, string tabId) { await StopSlotAsync(workspaceId, index, tabId); }
        async Task StopSlotAsync(string workspaceId, int index, string tabId)
        {
            PaneState pane = FindPane(workspaceId, index, tabId);
            if (pane == null) return;
            if (pane.Starting || pane.Stopping || pane.Session == null) return;
            pane.Stopping = true; int generation = pane.Generation;
            PtySession session = pane.Session;
            try { await Task.Run((Action)session.Dispose); }
            catch (Exception ex) { if (!closing) Status("停止終端時發生問題：" + ex.Message); }
            if (closing || pane.Generation != generation) return;
            DateTime drainDeadline = DateTime.UtcNow.AddSeconds(2);
            while (!closing && pane.Generation == generation && DateTime.UtcNow < drainDeadline && (pane.Output.Count > 0 || pane.InFlight > 0))
            {
                FlushPane(pane, 65536); await Task.Delay(20);
            }
            if (closing || pane.Generation != generation) return;
            pane.Session = null; pane.Stopping = false;
            if (!pane.ExitSent)
            {
                Send(new { type = "exited", workspaceId = workspaceId, slot = index, tabId = tabId, exitCode = pane.ExitCode ?? -1, generation = generation }); pane.ExitSent = true;
            }
            ShellBuilder.Clean(pane.Command); pane.Command = null;
        }
        async void RestartSlot(string workspaceId, int index, string tabId, PaneConfig paneConfig, int cols, int rows)
        {
            PaneState pane = GetPane(workspaceId, index, tabId);
            if (pane == null) return;
            if (closing || pane.Starting || pane.Stopping) return;
            await StopSlotAsync(workspaceId, index, tabId);
            if (!closing) StartSlot(workspaceId, index, tabId, paneConfig, cols, rows);
        }
        void FlushPane(PaneState pane, int budget)
        {
            int index = pane.Slot;
            string workspaceId = pane.WorkspaceId;
            if (pane.Starting || pane.ExitSent) return;
            budget = Math.Min(budget, Math.Max(0, 65536 - pane.InFlight));
            byte[] data; int count = 0;
            using (MemoryStream buffer = new MemoryStream())
            {
                while (count < budget && pane.Output.TryTake(out data))
                {
                    buffer.Write(data, 0, data.Length); count += data.Length;
                    if (buffer.Length >= 32768)
                    {
                        pane.InFlight += (int)buffer.Length;
                        Send(new { type = "output", workspaceId = workspaceId, slot = index, tabId = pane.TabId, data = Convert.ToBase64String(buffer.ToArray()), generation = pane.Generation }); buffer.SetLength(0);
                    }
                }
                if (buffer.Length > 0)
                {
                    pane.InFlight += (int)buffer.Length;
                    Send(new { type = "output", workspaceId = workspaceId, slot = index, tabId = pane.TabId, data = Convert.ToBase64String(buffer.ToArray()), generation = pane.Generation });
                }
            }
            if (pane.ExitCode.HasValue && pane.Output.Count == 0 && pane.InFlight == 0 && !pane.ExitSent && !pane.Stopping)
            {
                Send(new { type = "exited", workspaceId = workspaceId, slot = index, tabId = pane.TabId, exitCode = pane.ExitCode.Value, generation = pane.Generation });
                pane.ExitSent = true; PtySession finished = pane.Session; pane.Session = null;
                if (finished != null) Task.Run((Action)finished.Dispose);
                ShellBuilder.Clean(pane.Command); pane.Command = null;
            }
        }
        void FlushAll()
        {
            if (!ready || closing) return;
            foreach (PaneState pane in panes.Values.ToArray()) FlushPane(pane, 65536);
        }
        void ExportConfig()
        {
            using (SaveFileDialog dialog = new SaveFileDialog { Filter = "Terminal Grid 配置 (*.json)|*.json", DefaultExt = "json", FileName = "terminal-grid-integrated.json" })
                if (dialog.ShowDialog(this) == DialogResult.OK)
                    try { ConfigStore.Write(dialog.FileName, config); Status("配置已匯出。"); }
                    catch (Exception ex) { Status("匯出失敗：" + ex.Message); }
        }
        void ImportConfig()
        {
            if (panes.Values.Any(pane => pane.Session != null || pane.Starting))
            {
                MessageBox.Show(this, "匯入配置前請先結束目前執行中的內建終端，避免匯入後分頁識別碼改變而失去控制。", "請先停止終端", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            using (OpenFileDialog dialog = new OpenFileDialog { Filter = "Terminal Grid 配置 (*.json)|*.json" })
                if (dialog.ShowDialog(this) == DialogResult.OK)
                    try
                    {
                        config = ConfigStore.ReadAppConfig(dialog.FileName); ConfigStore.Write(ConfigStore.DefaultPath, config);
                        Send(new { type = "imported", config = config });
                        Status("配置已匯入；執行中的終端繼續保留，啟動指令在下次啟動該格時才會執行。");
                    }
                    catch (Exception ex) { Status("匯入失敗：" + ex.Message); }
        }
        void OpenFlow()
        {
            using (OpenFileDialog dialog = new OpenFileDialog { Filter = "Terminal Grid 自動化流程 (*.tgridflow)|*.tgridflow|JSON 檔案 (*.json)|*.json", CheckFileExists = true })
                if (dialog.ShowDialog(this) == DialogResult.OK)
                    try
                    {
                        FileInfo file = new FileInfo(dialog.FileName);
                        if (file.Length > 1024 * 1024) throw new InvalidDataException("流程檔超過 1 MB。");
                        Send(new { type = "flowLoaded", text = File.ReadAllText(dialog.FileName, Encoding.UTF8), fileName = file.Name });
                    }
                    catch (Exception ex) { Send(new { type = "fileError", message = "匯入流程失敗：" + ex.Message }); }
        }
        void SaveFlow(string text)
        {
            if (text == null || Encoding.UTF8.GetByteCount(text) > 1024 * 1024) { Status("流程檔超過 1 MB，無法匯出。"); return; }
            using (SaveFileDialog dialog = new SaveFileDialog { Filter = "Terminal Grid 自動化流程 (*.tgridflow)|*.tgridflow", DefaultExt = "tgridflow", FileName = "terminal-grid-flow.tgridflow", AddExtension = true })
                if (dialog.ShowDialog(this) == DialogResult.OK)
                    try { File.WriteAllText(dialog.FileName, text, new UTF8Encoding(false)); Status("自動化流程已匯出。"); }
                    catch (Exception ex) { Status("匯出流程失敗：" + ex.Message); }
        }
        void OpenCommandPack()
        {
            using (OpenFileDialog dialog = new OpenFileDialog { Filter = "Terminal Grid 指令集 (*.tgridcmd)|*.tgridcmd|JSON 檔案 (*.json)|*.json", CheckFileExists = true })
                if (dialog.ShowDialog(this) == DialogResult.OK)
                    try
                    {
                        FileInfo file = new FileInfo(dialog.FileName);
                        if (file.Length > 1024 * 1024) throw new InvalidDataException("指令集檔超過 1 MB。");
                        Send(new { type = "commandPackLoaded", text = File.ReadAllText(dialog.FileName, Encoding.UTF8), fileName = file.Name });
                    }
                    catch (Exception ex) { Send(new { type = "fileError", message = "匯入指令集失敗：" + ex.Message }); }
        }
        void SaveCommandPack(string text)
        {
            if (text == null || Encoding.UTF8.GetByteCount(text) > 1024 * 1024) { Status("指令集檔超過 1 MB，無法匯出。"); return; }
            using (SaveFileDialog dialog = new SaveFileDialog { Filter = "Terminal Grid 指令集 (*.tgridcmd)|*.tgridcmd", DefaultExt = "tgridcmd", FileName = "terminal-grid-commands.tgridcmd", AddExtension = true })
                if (dialog.ShowDialog(this) == DialogResult.OK)
                    try { File.WriteAllText(dialog.FileName, text, new UTF8Encoding(false)); Status("指令集已匯出。"); }
                    catch (Exception ex) { Status("匯出指令集失敗：" + ex.Message); }
        }
        async void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (closeApproved) return;
            e.Cancel = true;
            if (closing || folderPickerOpen) return;
            int count = panes.Values.Count(p => p.Session != null || p.Starting);
            if (count > 0 && MessageBox.Show(this, "目前有 " + count + " 個內建終端工作階段。關閉主程式會一併結束這些終端與測試。\n\n確定關閉？", "關閉整合終端", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
            closing = true; outputTimer.Stop(); Enabled = false;
            var tasks = panes.Values.Where(p => p.Session != null).Select(p => Task.Run((Action)p.Session.Dispose)).ToArray();
            await Task.WhenAll(tasks);
            foreach (PaneState pane in panes.Values) ShellBuilder.Clean(pane.Command);
            closeApproved = true; Close();
        }
    }
    public static class Program
    {
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [STAThread]
        public static void Main()
        {
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e) { MessageBox.Show(e.Exception.Message, "Terminal Grid", MessageBoxButtons.OK, MessageBoxIcon.Error); };
            Application.Run(new TerminalForm());
        }
    }
}
