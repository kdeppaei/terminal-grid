using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace TerminalGridIntegrated
{
    public sealed class AdbFiles
    {
        public const int TextLimit = 2 * 1024 * 1024;
        readonly string adb, serial, backups;
        readonly CancellationToken cancel;
        public AdbFiles(string executable, string device, string backupFolder, CancellationToken token)
        {
            if (String.IsNullOrWhiteSpace(device) || device.Any(c => Char.IsControl(c))) throw new ArgumentException("請選擇手機序號。");
            adb = executable; serial = device; backups = backupFolder; cancel = token;
        }
        public static string RemotePath(string path)
        {
            path = (path ?? "").Trim();
            if (path.Length == 0 || path.Length > 2048 || path.Any(c => Char.IsControl(c)) || path.Contains("\\")) throw new ArgumentException("請輸入 Android 路徑，例如 /vendor/firmware/wifi.cfg。");
            if (!path.StartsWith("/")) path = "/" + path;
            if (path.Split('/').Any(p => p == ".." || p == ".")) throw new ArgumentException("路徑不可含 . 或 ..。");
            if (path.Trim('/') == "") throw new ArgumentException("請指定檔案或資料夾，不可使用根目錄。");
            return path;
        }
        public static string ShellQuote(string text) { return "'" + text.Replace("'", "'\"'\"'") + "'"; }
        public static string FindAdb(string folder)
        {
            if (!String.IsNullOrWhiteSpace(folder)) {
                string path = Path.Combine(folder, "adb.exe");
                if (!File.Exists(path)) throw new FileNotFoundException("此工具資料夾找不到 adb.exe。", path);
                return Path.GetFullPath(path);
            }
            string found = ShellBuilder.FindExecutable("adb.exe");
            if (found == null) throw new FileNotFoundException("找不到 adb.exe，請選擇工具資料夾或加入 PATH。");
            return found;
        }
        static async Task<byte[]> ReadBounded(Stream stream, int limit)
        {
            using (var data = new MemoryStream()) {
                var block = new byte[8192]; int count;
                while ((count = await stream.ReadAsync(block, 0, block.Length).ConfigureAwait(false)) > 0) {
                    if (data.Length + count > limit) throw new IOException("輸出過大；文字編輯器限 2 MB，大檔請使用檔案傳輸。");
                    data.Write(block, 0, count);
                }
                return data.ToArray();
            }
        }
        static async Task<string> ReadTail(StreamReader reader)
        {
            var text = new StringBuilder(); var chars = new char[2048]; int count;
            while ((count = await reader.ReadAsync(chars, 0, chars.Length).ConfigureAwait(false)) > 0) {
                text.Append(chars, 0, count); if (text.Length > 16384) text.Remove(0, text.Length - 16384);
            }
            return text.ToString();
        }
        public byte[] Run(string[] arguments, byte[] input = null, int timeoutMs = 15000, bool transfer = false)
        {
            cancel.ThrowIfCancellationRequested();
            var args = new[] { "-s", serial }.Concat(arguments);
            using (var process = AdbProcess.Start(adb, String.Join(" ", args.Select(ShellBuilder.Quote)))) {
                Action kill = delegate { try { if (!process.HasExited) process.Kill(); } catch (InvalidOperationException) { } };
                using (cancel.Register(kill)) {
                    Task<byte[]> output = transfer ? null : ReadBounded(process.StandardOutput, TextLimit);
                    Task<string> summary = transfer ? ReadTail(new StreamReader(process.StandardOutput, Encoding.UTF8)) : null;
                    Task<string> errors = ReadTail(process.StandardError);
                    Stream stdin = process.StandardInput;
                    Task writer = Task.Run(delegate { try { if (input != null) stdin.Write(input, 0, input.Length); } finally { stdin.Close(); } });
                    writer.ContinueWith(t => { var observed = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
                    var timer = Stopwatch.StartNew();
                    try {
                        while (!process.WaitForExit(100)) {
                            cancel.ThrowIfCancellationRequested();
                            if (output != null && output.IsFaulted) output.GetAwaiter().GetResult();
                            if (timer.ElapsedMilliseconds > timeoutMs) throw new TimeoutException("ADB 操作逾時；請檢查 USB、授權與手機狀態。");
                        }
                        cancel.ThrowIfCancellationRequested();
                        if (!Task.WaitAll(new Task[] { transfer ? (Task)summary : output, errors }, 5000)) throw new TimeoutException("ADB 輸出逾時。");
                        if (process.ExitCode != 0) throw new IOException("ADB 失敗（" + process.ExitCode + "）：" + errors.Result + (transfer ? summary.Result : "") + "\n若顯示 Permission denied／Read-only file system，請由 RD 確認韌體與寫入權限。");
                        if (!writer.Wait(5000)) throw new TimeoutException("ADB 輸入逾時。");
                        return transfer ? Encoding.UTF8.GetBytes(summary.Result) : output.Result;
                    } finally {
                        kill();
                        // A timed-out child may have a writer blocked in the
                        // pipe. Let it unwind before disposing its stream;
                        // broken-pipe cleanup must not mask the original error.
                        try { writer.Wait(5000); } catch (AggregateException) { }
                    }
                }
            }
        }
        public byte[] Read(string path) { return Run(new[] { "shell", "-T", "cat " + ShellQuote(RemotePath(path)) }); }
        public byte[] ReadOptional(string path)
        {
            path = RemotePath(path);
            string q = ShellQuote(path);
            string exists = Encoding.UTF8.GetString(Run(new[] { "shell", "-T", "if [ -f " + q + " ]; then printf FILE; elif [ -e " + q + " ]; then printf OTHER; else printf MISSING; fi" })).Trim();
            if (exists == "FILE") return Read(path);
            if (exists == "MISSING") return null;
            throw new IOException("目標不是一般檔案，或無法判定檔案狀態。");
        }
        public static string Decode(byte[] bytes)
        {
            if (bytes == null) return "";
            if (bytes.Length > TextLimit || bytes.Contains((byte)0)) throw new IOException("不是可編輯的 UTF-8 文字檔，請使用檔案傳輸。");
            int skip = bytes.Length >= 3 && bytes[0] == 239 && bytes[1] == 187 && bytes[2] == 191 ? 3 : 0;
            return new UTF8Encoding(false, true).GetString(bytes, skip, bytes.Length - skip);
        }
        public static byte[] Encode(string text, byte[] original)
        {
            string newline = original != null && Decode(original).Contains("\r\n") ? "\r\n" : "\n";
            text = text.Replace("\r\n", "\n").Replace("\r", "\n").Replace("\n", newline);
            bool bom = original != null && original.Length >= 3 && original[0] == 239 && original[1] == 187 && original[2] == 191;
            var encoding = new UTF8Encoding(bom, true);
            byte[] bytes = encoding.GetPreamble().Concat(encoding.GetBytes(text)).ToArray();
            if (bytes.Length > TextLimit || bytes.Contains((byte)0)) throw new IOException("文字檔必須小於 2 MB，且不能含 NUL。");
            return bytes;
        }
        public string Save(string path, byte[] expected, byte[] proposed)
        {
            path = RemotePath(path); Decode(proposed);
            byte[] current = ReadOptional(path);
            if (expected == null ? current != null : current == null || !expected.SequenceEqual(current)) throw new IOException("手機檔案自讀取後已改變。請先保留本機草稿，再重新讀取與比較。");
            string folder = Path.Combine(backups, DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(folder);
            if (current != null) File.WriteAllBytes(Path.Combine(folder, "original.cfg"), current);
            File.WriteAllBytes(Path.Combine(folder, "proposed.cfg"), proposed);
            File.WriteAllText(Path.Combine(folder, "target.txt"), "Device: " + serial + "\r\nPath: " + path + "\r\nOriginal existed: " + (current != null), new UTF8Encoding(false));
            try {
                // Write stdin into the existing inode: retain its mode/owner/SELinux
                // label. Config text is never embedded in shell command syntax.
                Run(new[] { "shell", "-T", "cat > " + ShellQuote(path) }, proposed);
                if (!Read(path).SequenceEqual(proposed)) throw new IOException("寫後讀回內容不一致。");
            } catch (Exception ex) { throw new IOException("寫入未完成或驗證失敗，手機檔案可能已部分改變。備份／草稿：" + folder + "\n" + ex.Message, ex); }
            return folder;
        }
        public string Pull(string remote, string destination)
        {
            remote = RemotePath(remote);
            if (!Directory.Exists(destination)) throw new DirectoryNotFoundException("請選擇本機目的資料夾。");
            string safeSerial = String.Concat(serial.Select(c => Char.IsLetterOrDigit(c) || c == '-' ? c : '_'));
            string folder = Path.Combine(destination, "TerminalGrid-" + safeSerial + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 6));
            Directory.CreateDirectory(folder);
            try { Run(new[] { "pull", remote, folder }, null, 30 * 60 * 1000, true); }
            catch (Exception ex) { throw new IOException("抓取未完成；已下載部分保留在：" + folder + "\n" + ex.Message, ex); }
            return folder;
        }
        public void Push(string local, string remote)
        {
            if (!File.Exists(local)) throw new FileNotFoundException("請選擇本機檔案。", local);
            Run(new[] { "push", Path.GetFullPath(local), RemotePath(remote) }, null, 30 * 60 * 1000, true);
        }
    }
}
