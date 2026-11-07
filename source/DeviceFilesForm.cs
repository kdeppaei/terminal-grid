using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace TerminalGridIntegrated
{
    public sealed class DeviceFilesForm : Form
    {
        readonly ComboBox device = new ComboBox { Width = 310, DropDownStyle = ComboBoxStyle.DropDown };
        readonly TextBox toolsFolder = new TextBox { Width = 320 };
        readonly TextBox remoteFile = new TextBox { Width = 420, Text = "/vendor/firmware/wifi.cfg" };
        readonly TextBox editor = new TextBox { Multiline = true, AcceptsTab = true, AcceptsReturn = true, WordWrap = false, ScrollBars = ScrollBars.Both, Dock = DockStyle.Fill, Font = new Font("Consolas", 11), MaxLength = AdbFiles.TextLimit };
        readonly TextBox search = new TextBox { Width = 250 };
        readonly TextBox transferPath = new TextBox { Width = 430, Text = "/sdcard/log/" };
        readonly TextBox localFolder = new TextBox { Width = 430, Text = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory) };
        readonly TextBox localFile = new TextBox { Width = 430, ReadOnly = true };
        readonly TextBox status = new TextBox { Multiline = true, ReadOnly = true, Dock = DockStyle.Fill, ScrollBars = ScrollBars.Vertical, Text = "選擇手機後讀取設定檔，或切到 Log／檔案傳輸。" };
        readonly Button cancel = new Button { Text = "取消操作", AutoSize = true, Enabled = false };
        readonly ProgressBar progress = new ProgressBar { Width = 140, Height = 20, Style = ProgressBarStyle.Marquee, Visible = false };
        readonly TabControl tabs = new TabControl { Dock = DockStyle.Fill };
        readonly FlowLayoutPanel connection;
        CancellationTokenSource cancellation;
        bool busy, dirty, assigning, loaded;
        byte[] original;
        string loadedSerial, loadedPath, loadedAdb;
        static readonly Color Surface = Color.FromArgb(29, 38, 49), Input = Color.FromArgb(14, 23, 36), Ink = Color.FromArgb(215, 227, 240);
        public DeviceFilesForm()
        {
            Text = "裝置檔案 · wifi.cfg／Logs／local tmp";
            Size = new Size(1050, 790); MinimumSize = new Size(900, 650); StartPosition = FormStartPosition.CenterParent;
            Font = new Font("Microsoft JhengHei UI", 10); BackColor = Surface; ForeColor = Ink;
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 3, ColumnCount = 1, Padding = new Padding(12) };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 100)); layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 105));
            connection = Row(new Label { Text = "手機序號", AutoSize = true }, device, Button("偵測手機", Discover), new Label { Text = "adb 工具資料夾（空白使用 PATH）", AutoSize = true }, toolsFolder, Button("選工具資料夾…", delegate { using (var d = new FolderBrowserDialog()) if (d.ShowDialog(this) == DialogResult.OK) toolsFolder.Text = d.SelectedPath; }));
            connection.SetFlowBreak(connection.Controls[2], true);
            var cfg = new TabPage("設定檔查看／編輯") { Padding = new Padding(8) };
            var cfgLayout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4 };
            cfgLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            cfgLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48)); cfgLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48)); cfgLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); cfgLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 45));
            cfgLayout.Controls.Add(Row(new Label { Text = "手機檔案", AutoSize = true }, remoteFile, Button("wifi.cfg", delegate { remoteFile.Text = "/vendor/firmware/wifi.cfg"; }), Button("讀取／準備新檔", ReadConfig)), 0, 0);
            cfgLayout.Controls.Add(Row(search, Button("尋找下一筆", FindText), Button("載入 RD 本機 cfg…", ImportConfig), Button("另存本機草稿…", ExportDraft)), 0, 1);
            cfgLayout.Controls.Add(editor, 0, 2);
            cfgLayout.Controls.Add(Row(Button("備份並寫回手機…", SaveConfig), new Label { Text = "可修改路徑與檔名（含空格）；UTF-8，限 2 MB。", AutoSize = true }), 0, 3);
            cfg.Controls.Add(cfgLayout); tabs.TabPages.Add(cfg);
            var files = new TabPage("Log／檔案傳輸") { Padding = new Padding(8) };
            var fileLayout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true };
            fileLayout.Controls.Add(Row(Button("/sdcard/log/", delegate { transferPath.Text = "/sdcard/log/"; }), Button("/data/debuglogger", delegate { transferPath.Text = "/data/debuglogger"; }), Button("/data/local/tmp/", delegate { transferPath.Text = "/data/local/tmp/"; })));
            fileLayout.Controls.Add(Row(new Label { Text = "手機檔案／資料夾", AutoSize = true }, transferPath, Button("列出內容", ListRemote)));
            fileLayout.Controls.Add(Row(new Label { Text = "本機下載資料夾", AutoSize = true }, localFolder, Button("選資料夾…", delegate { using (var d = new FolderBrowserDialog()) if (d.ShowDialog(this) == DialogResult.OK) localFolder.Text = d.SelectedPath; })));
            fileLayout.Controls.Add(Row(Button("Pull 抓取至新資料夾", Pull)));
            fileLayout.Controls.Add(new Label { Text = "每次抓取另建『序號＋時間』資料夾，取消／失敗時保留已下載部分。", AutoSize = true, Margin = new Padding(5, 12, 5, 16) });
            fileLayout.Controls.Add(Row(new Label { Text = "本機上傳檔案", AutoSize = true }, localFile, Button("選檔案…", delegate { using (var d = new OpenFileDialog { CheckFileExists = true }) if (d.ShowDialog(this) == DialogResult.OK) localFile.Text = d.FileName; })));
            fileLayout.Controls.Add(Row(Button("Push 至上方手機路徑…", Push)));
            fileLayout.Controls.Add(new Label { Text = "上傳目的路徑以 / 結尾會保留原檔名；同名檔案可能覆寫。\n修改 wifi.cfg 建議使用左頁，可備份、比對並驗證寫入。\n/data/local/tmp 可放測試工具；執行權限請在終端依 RD 指示設定。", AutoSize = true, Margin = new Padding(5, 12, 5, 5) });
            files.Controls.Add(fileLayout); tabs.TabPages.Add(files);
            fileLayout.SizeChanged += delegate { foreach (Control row in fileLayout.Controls) if (row is FlowLayoutPanel) { row.Dock = DockStyle.None; row.Width = Math.Max(200, fileLayout.ClientSize.Width - 25); } };
            var feedback = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 1, ColumnCount = 2 };
            feedback.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); feedback.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 155));
            feedback.Controls.Add(status, 0, 0); feedback.Controls.Add(Row(cancel, progress), 1, 0);
            layout.Controls.Add(connection, 0, 0); layout.Controls.Add(tabs, 0, 1); layout.Controls.Add(feedback, 0, 2); Controls.Add(layout);
            Theme(this);
            editor.AccessibleName = "設定檔編輯區"; search.AccessibleName = "搜尋參數"; status.AccessibleName = "操作結果";
            cancel.Click += delegate { if (cancellation != null) { cancellation.Cancel(); status.Text = "正在取消；傳輸部分可能已完成，請等待結果。"; } };
            editor.TextChanged += delegate { if (!assigning) dirty = true; };
            FormClosing += delegate(object sender, FormClosingEventArgs e) {
                if (busy) { e.Cancel = true; status.Text = "操作仍在進行，請先按取消操作，等待結果後再關閉。"; return; }
                if (!DiscardDraft()) e.Cancel = true;
            };
        }
        static FlowLayoutPanel Row(params Control[] children) { var row = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = false, Height = 48, Width = 800, WrapContents = true, Margin = new Padding(0), Padding = new Padding(2) }; row.Controls.AddRange(children); return row; }
        static Button Button(string label, Action action) { var b = new Button { Text = label, AutoSize = true, Padding = new Padding(4, 2, 4, 2) }; b.Click += delegate { action(); }; return b; }
        static void Theme(Control root) { foreach (Control c in root.Controls) { c.ForeColor = Ink; c.BackColor = c is TextBox || c is ComboBox ? Input : Surface; var b = c as Button; if (b != null) { b.FlatStyle = FlatStyle.Flat; b.FlatAppearance.BorderColor = Color.FromArgb(82, 96, 117); } Theme(c); } }
        bool DiscardDraft() { return !dirty || MessageBox.Show(this, "有尚未寫回的草稿。確定放棄？可先另存本機草稿。", "設定檔", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes; }
        AdbFiles Client(string serial, string executable, CancellationToken token) { return new AdbFiles(executable, serial, Path.Combine(ConfigStore.DataFolder, "device-file-backups"), token); }
        async void Work(string label, Func<CancellationToken, Action> operation)
        {
            if (busy) return;
            busy = true; connection.Enabled = tabs.Enabled = false; cancel.Enabled = progress.Visible = true; status.Text = label;
            using (cancellation = new CancellationTokenSource()) {
                try { var done = await Task.Run(() => operation(cancellation.Token)); if (!IsDisposed) done(); }
                catch (OperationCanceledException) { if (!IsDisposed) status.Text = "已取消。"; }
                catch (Exception ex) { if (!IsDisposed) status.Text = ex.GetBaseException().Message == ex.Message ? ex.Message : ex.Message + "\r\n" + ex.GetBaseException().Message; }
                finally { busy = false; if (!IsDisposed) { connection.Enabled = tabs.Enabled = true; cancel.Enabled = progress.Visible = false; } }
            }
            cancellation = null;
        }
        bool Target(out string serial, out string path, out string executable, bool file)
        {
            serial = device.Text.Trim(); path = null; executable = null;
            try { if (serial.Length == 0) throw new Exception("請選擇或填入手機序號。"); path = AdbFiles.RemotePath(file ? remoteFile.Text : transferPath.Text); executable = AdbFiles.FindAdb(toolsFolder.Text.Trim()); return true; }
            catch (Exception ex) { status.Text = ex.Message; return false; }
        }
        void Discover()
        {
            string folder = toolsFolder.Text.Trim();
            Work("正在偵測手機…", token => { AdbFiles.FindAdb(folder); var result = TargetDiscovery.Discover(folder); token.ThrowIfCancellationRequested(); return delegate {
                string previous = device.Text; device.Items.Clear(); foreach (var item in result.candidates.Where(c => c.kind == "device")) device.Items.Add(item.value);
                device.Text = previous; if (device.Items.Count == 1 && previous.Length == 0) device.SelectedIndex = 0;
                status.Text = "偵測到 " + device.Items.Count + " 台已授權手機。 " + result.message;
            }; });
        }
        void ReadConfig()
        {
            string serial, path, executable; if (!Target(out serial, out path, out executable, true) || !DiscardDraft()) return;
            Work("讀取 " + serial + " · " + path, token => { byte[] bytes = Client(serial, executable, token).ReadOptional(path); string text = AdbFiles.Decode(bytes); return delegate {
                original = bytes; loadedSerial = serial; loadedPath = path; loadedAdb = executable; loaded = true;
                assigning = true; editor.Text = text.Replace("\r\n", "\n").Replace("\n", "\r\n"); assigning = false; dirty = false;
                remoteFile.Text = path; status.Text = bytes == null ? "目標不存在；可編輯後建立新檔。" : "已讀取 " + bytes.Length + " bytes。可搜尋、編輯，或載入 RD 檔案取代內容。";
            }; });
        }
        void FindText() { if (search.Text.Length == 0) return; int start = editor.SelectionStart + editor.SelectionLength; int at = editor.Text.IndexOf(search.Text, Math.Min(start, editor.Text.Length), StringComparison.OrdinalIgnoreCase); if (at < 0) at = editor.Text.IndexOf(search.Text, StringComparison.OrdinalIgnoreCase); if (at < 0) { status.Text = "找不到：" + search.Text; return; } editor.Select(at, search.Text.Length); editor.ScrollToCaret(); editor.Focus(); }
        void ImportConfig()
        {
            if (!loaded) { status.Text = "請先讀取／準備手機目標檔，再載入 RD 檔案。"; return; }
            if (!DiscardDraft()) return;
            using (var d = new OpenFileDialog { Filter = "設定檔 (*.cfg;*.conf;*.ini;*.txt)|*.cfg;*.conf;*.ini;*.txt|所有檔案|*.*", CheckFileExists = true }) if (d.ShowDialog(this) == DialogResult.OK) {
                try { if (new FileInfo(d.FileName).Length > AdbFiles.TextLimit) throw new IOException("設定檔超過 2 MB。"); editor.Text = AdbFiles.Decode(File.ReadAllBytes(d.FileName)).Replace("\r\n", "\n").Replace("\n", "\r\n"); dirty = true; status.Text = "已載入本機草稿，尚未寫入手機。"; }
                catch (Exception ex) { status.Text = ex.Message; }
            }
        }
        void ExportDraft()
        {
            using (var d = new SaveFileDialog { FileName = "wifi.cfg", Filter = "設定檔|*.cfg|所有檔案|*.*" }) if (d.ShowDialog(this) == DialogResult.OK) try { File.WriteAllBytes(d.FileName, AdbFiles.Encode(editor.Text, original)); status.Text = "草稿已存：" + d.FileName; } catch (Exception ex) { status.Text = ex.Message; }
        }
        void SaveConfig()
        {
            string serial, path, executable; if (!Target(out serial, out path, out executable, true)) return;
            if (!loaded || serial != loadedSerial || path != loadedPath || executable != loadedAdb) { status.Text = "目標手機／路徑已改變。請先另存草稿，再重新讀取目標。"; return; }
            byte[] bytes; try { bytes = AdbFiles.Encode(editor.Text, original); } catch (Exception ex) { status.Text = ex.Message; return; }
            if (MessageBox.Show(this, "手機：" + serial + "\n目標：" + path + "\n" + (original == null ? "建立新檔" : "備份原檔後覆寫") + "，共 " + bytes.Length + " bytes。\n寫入後會讀回驗證。確認寫入？", "寫回手機設定", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            byte[] expected = original;
            Work("備份並寫回 " + path + "…", token => { string backup = Client(serial, executable, token).Save(path, expected, bytes); return delegate { original = bytes; dirty = false; status.Text = "寫入並讀回驗證成功。備份／草稿：" + backup; }; });
        }
        void ListRemote()
        {
            string serial, path, executable; if (!Target(out serial, out path, out executable, false)) return;
            Work("讀取目錄…", token => { string listing = Encoding.UTF8.GetString(Client(serial, executable, token).Run(new[] { "shell", "-T", "ls -la " + AdbFiles.ShellQuote(path) })); return delegate { status.Text = listing; }; });
        }
        void Pull()
        {
            string serial, path, executable; if (!Target(out serial, out path, out executable, false)) return;
            string folder = localFolder.Text;
            Work("正在抓取 " + serial + " · " + path + "，大型 Log 可能需要數分鐘…", token => { string output = Client(serial, executable, token).Pull(path, folder); return delegate { status.Text = "抓取完成：" + output; }; });
        }
        void Push()
        {
            string serial, path, executable; if (!Target(out serial, out path, out executable, false)) return;
            string local = localFile.Text;
            if (!File.Exists(local)) { status.Text = "請先選擇本機上傳檔案。"; return; }
            if (path.EndsWith("/")) path += Path.GetFileName(local);
            if (MessageBox.Show(this, "手機：" + serial + "\n本機：" + local + "\n目的：" + path + "\n一般 Push 可能覆寫同名檔案，未自動備份。設定檔建議用左頁的備份寫回。", "確認 Push", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            Work("正在推送檔案…", token => { Client(serial, executable, token).Push(local, path); return delegate { status.Text = "推送完成：" + path; }; });
        }
    }
}
