using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace TerminalGridIntegrated
{
    public sealed class TargetCandidate
    {
        public string value { get; set; }
        public string label { get; set; }
        public string kind { get; set; }
        // For local IPv6 candidates the command value uses the Windows zone
        // index (for example %12), while the friendly adapter name remains
        // visible in the picker. Windows ping requires the numeric zone id;
        // the name is metadata for humans and is never substituted into the
        // command as an invalid scope.
        public string interfaceName { get; set; }
        public int interfaceIndex { get; set; }
        public string serial { get; set; }
        public bool usb { get; set; }
    }
    public sealed class TargetDiscoveryResult
    {
        public List<TargetCandidate> candidates = new List<TargetCandidate>();
        public string message = "";
        public string adbPath = "";
    }
    public static class TargetDiscovery
    {
        const uint PresentUsbFlags = 0x00000101; // CM_GETIDLIST_FILTER_PRESENT | CM_GETIDLIST_FILTER_ENUMERATOR
        const uint BufferSmall = 0x1A; // CR_BUFFER_SMALL

        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        static extern uint CM_Get_Device_ID_List_SizeW(out uint length, string filter, uint flags);

        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        static extern uint CM_Get_Device_ID_ListW(string filter, [Out] char[] buffer, uint length, uint flags);

        static IEnumerable<string> PresentUsbIds()
        {
            for (int attempt = 0; attempt < 3; attempt++)
            {
                uint length;
                if (CM_Get_Device_ID_List_SizeW(out length, "USB", PresentUsbFlags) != 0 || length == 0 || length > 1048576) break;
                var buffer = new char[length];
                uint status = CM_Get_Device_ID_ListW("USB", buffer, length, PresentUsbFlags);
                if (status == 0) return new string(buffer).Split(new[] { '\0' }, StringSplitOptions.RemoveEmptyEntries);
                if (status != BufferSmall) break;
            }
            return new string[0];
        }

        internal static void MatchPresentUsb(IEnumerable<TargetCandidate> candidates, IEnumerable<string> instanceIds)
        {
            var serials = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string id in instanceIds)
            {
                // Use the parent device's instance serial. Composite interface
                // children use MI_nn and can carry a generated instance ID.
                var match = Regex.Match(id, @"^USB\\VID_[0-9a-f]{4}&PID_[0-9a-f]{4}\\([A-Za-z0-9_.-]{1,128})$", RegexOptions.IgnoreCase);
                if (match.Success) serials.Add(match.Groups[1].Value);
            }
            foreach (var candidate in candidates)
                if (candidate.kind == "device" && serials.Contains(candidate.value)) candidate.usb = true;
        }

        public static List<TargetCandidate> AndroidAddresses(string text, string serial)
        {
            var result = new List<TargetCandidate>();
            string iface = null;
            foreach (string line in (text ?? "").Split('\n').Take(4096))
            {
                var heading = Regex.Match(line, @"^\s*\d+:\s+([A-Za-z0-9_.-]{1,32})(?:@[^:\s]+)?:");
                if (heading.Success) iface = heading.Groups[1].Value;
                if (String.IsNullOrEmpty(iface) || iface == "lo" || Regex.IsMatch(line, @"\b(tentative|dadfailed)\b")) continue;
                var address = Regex.Match(line, @"\binet6?\s+([0-9a-fA-F:.]+)/\d+");
                IPAddress ip;
                if (!address.Success || !IPAddress.TryParse(address.Groups[1].Value, out ip) || IPAddress.IsLoopback(ip) || ip.Equals(IPAddress.IPv6Any)) continue;
                result.Add(new TargetCandidate { value = ip.ToString(), interfaceName = iface, serial = serial,
                    kind = "android", label = serial + " · " + iface + " · " + ip });
            }
            return result;
        }
        public static string AdbShell(string adb, string serial, string command, int timeoutMs = 5000)
        {
            string args = String.Join(" ", new[] { "-s", serial, "shell", command }.Select(ShellBuilder.Quote));
            using (var process = new Process { StartInfo = new ProcessStartInfo(adb, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true } })
            {
                process.Start();
                var output = process.StandardOutput.ReadToEndAsync();
                var error = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(timeoutMs)) { try { process.Kill(); } catch (InvalidOperationException) { } throw new TimeoutException("ADB 操作逾時，請確認裝置畫面及 USB 連線。"); }
                if (!Task.WaitAll(new Task[] { output, error }, 1000)) throw new TimeoutException("ADB output timed out.");
                if (process.ExitCode != 0) throw new InvalidOperationException("ADB query failed: " + error.Result.Trim());
                return output.Result;
            }
        }
        public static List<TargetCandidate> ParseAdb(string text)
        {
            var result = new List<TargetCandidate>();
            foreach (string line in (text ?? "").Split('\n').Take(256)) {
                string[] parts = line.Trim().Split(new[] { ' ', '\t', '\r' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 2 || parts[1] != "device") continue;
                string model = parts.FirstOrDefault(p => p.StartsWith("model:", StringComparison.Ordinal)) ?? "";
                result.Add(new TargetCandidate { value = parts[0], label = parts[0] + " · " + model.Replace("model:", ""), kind = "device",
                    usb = parts.Skip(2).Any(p => p.StartsWith("usb:", StringComparison.Ordinal) && p.Length > 4) });
                string address = parts[0]; int port = address.LastIndexOf(':');
                System.Net.IPAddress ip;
                if (port > 0 && System.Net.IPAddress.TryParse(address.Substring(0, port).Trim('[', ']'), out ip))
                    result.Add(new TargetCandidate { value = ip.ToString(), label = "ADB 網路裝置 · " + ip, kind = "remote" });
            }
            return result;
        }
        public static string FindAdb(string cwd)
        {
            if (!String.IsNullOrWhiteSpace(cwd)) {
                try { string file = Path.Combine(cwd, "adb.exe"); if (File.Exists(file)) return Path.GetFullPath(file); } catch (ArgumentException) { }
            }
            return ShellBuilder.FindExecutable("adb.exe");
        }
        public static TargetDiscoveryResult Discover(string cwd, bool android = false, string pathFolder = null)
        {
            var result = new TargetDiscoveryResult();
            try {
                foreach (NetworkInterface adapter in NetworkInterface.GetAllNetworkInterfaces()) {
                    if (adapter.OperationalStatus != OperationalStatus.Up || adapter.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                    IPInterfaceProperties properties = adapter.GetIPProperties();
                    int ipv6Index = 0;
                    try { ipv6Index = properties.GetIPv6Properties() == null ? 0 : properties.GetIPv6Properties().Index; } catch (Exception) { }
                    foreach (UnicastIPAddressInformation info in properties.UnicastAddresses) {
                        if (info.Address.AddressFamily != AddressFamily.InterNetwork && info.Address.AddressFamily != AddressFamily.InterNetworkV6) continue;
                        string value = info.Address.ToString();
                        bool scoped = info.Address.AddressFamily == AddressFamily.InterNetworkV6 && info.Address.IsIPv6LinkLocal;
                        // NetworkInterface normally exposes a link-local address
                        // without its zone. Add the interface index required by
                        // Windows ping, while keeping the adapter name in label.
                        if (scoped && value.IndexOf('%') < 0 && ipv6Index > 0) value += "%" + ipv6Index;
                        string label = "本機 · " + adapter.Name + " · " + value;
                        if (scoped && ipv6Index > 0) label += "（IPv6 介面 " + ipv6Index + "）";
                        result.candidates.Add(new TargetCandidate {
                            value = value, label = label, kind = "local",
                            interfaceName = adapter.Name,
                            interfaceIndex = info.Address.AddressFamily == AddressFamily.InterNetworkV6 ? ipv6Index : 0
                        });
                    }
                }
            } catch (Exception) { result.message = "部分網卡資訊無法讀取。"; }
            if (!String.IsNullOrWhiteSpace(pathFolder) && Directory.Exists(pathFolder))
            {
                try
                {
                    foreach (var path in Directory.EnumerateFileSystemEntries(pathFolder).Take(80))
                        result.candidates.Add(new TargetCandidate { value = path, label = Path.GetFileName(path),
                            kind = Directory.Exists(path) ? "folder" : Path.GetExtension(path).Equals(".apk", StringComparison.OrdinalIgnoreCase) ? "apk" : "file" });
                    result.candidates.Add(new TargetCandidate { value = pathFolder, label = "終端啟動資料夾", kind = "folder" });
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            string adb = FindAdb(cwd);
            if (adb == null) { result.message += " 找不到 adb.exe；請安裝 Platform Tools，加入 PATH 或放在終端啟動資料夾。"; return result; }
            result.adbPath = adb;
            try {
                using (var process = new Process { StartInfo = new ProcessStartInfo(adb, "devices -l") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true } }) {
                    process.Start(); Task<string> output = process.StandardOutput.ReadToEndAsync(), error = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(5000)) { try { process.Kill(); } catch (InvalidOperationException) { } result.message += " ADB 偵測逾時，可重新偵測或手動輸入。"; return result; }
                    if (!Task.WaitAll(new Task[] { output, error }, 1000)) { result.message += " ADB 輸出逾時。"; return result; }
                    if (process.ExitCode == 0) {
                        var devices = ParseAdb(output.Result);
                        if (devices.Any(c => c.kind == "device" && !c.usb) &&
                            String.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("ADB_SERVER_SOCKET")) &&
                            String.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("ANDROID_ADB_SERVER_ADDRESS")))
                            MatchPresentUsb(devices, PresentUsbIds());
                        result.candidates.AddRange(devices);
                        if (!devices.Any(c => c.kind == "device")) result.message += " 沒有已授權且在線的 ADB 裝置，請確認 USB 偵錯授權或重新偵測。";
                    }
                    else result.message += " ADB 無法列出裝置，請確認偵錯授權或手動輸入。";
                }
                if (android) {
                    var devices = result.candidates.Where(c => c.kind == "device").Select(c => c.value).Distinct().Take(8).ToArray();
                    var queries = devices.Select(serial => Task.Run(delegate {
                        try { return AndroidAddresses(AdbShell(adb, serial, "ip addr show"), serial); }
                        catch (Exception) { return new List<TargetCandidate>(); }
                    })).ToArray();
                    Task.WaitAll(queries);
                    foreach (var query in queries) result.candidates.AddRange(query.Result.Take(60));
                }
            } catch (Exception) { result.message += " ADB 偵測失敗，可手動輸入或重新偵測。"; }
            return result;
        }
    }
}
