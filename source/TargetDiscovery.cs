using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.NetworkInformation;
using System.Net.Sockets;
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
    }
    public sealed class TargetDiscoveryResult
    {
        public List<TargetCandidate> candidates = new List<TargetCandidate>();
        public string message = "";
    }
    public static class TargetDiscovery
    {
        public static List<TargetCandidate> ParseAdb(string text)
        {
            var result = new List<TargetCandidate>();
            foreach (string line in (text ?? "").Split('\n').Take(256)) {
                string[] parts = line.Trim().Split(new[] { ' ', '\t', '\r' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 2 || parts[1] != "device") continue;
                string model = parts.FirstOrDefault(p => p.StartsWith("model:", StringComparison.Ordinal)) ?? "";
                result.Add(new TargetCandidate { value = parts[0], label = parts[0] + " · " + model.Replace("model:", ""), kind = "device" });
                string address = parts[0]; int port = address.LastIndexOf(':');
                System.Net.IPAddress ip;
                if (port > 0 && System.Net.IPAddress.TryParse(address.Substring(0, port).Trim('[', ']'), out ip))
                    result.Add(new TargetCandidate { value = ip.ToString(), label = "ADB 網路裝置 · " + ip, kind = "remote" });
            }
            return result;
        }
        public static TargetDiscoveryResult Discover(string cwd)
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
            string adb = ShellBuilder.FindExecutable("adb.exe");
            if (adb == null && !String.IsNullOrWhiteSpace(cwd)) {
                try { string file = Path.Combine(cwd, "adb.exe"); if (File.Exists(file)) adb = Path.GetFullPath(file); } catch (ArgumentException) { }
            }
            if (adb == null) { result.message += " 找不到 adb.exe；請安裝 Platform Tools，加入 PATH 或放在終端啟動資料夾。"; return result; }
            try {
                using (var process = new Process { StartInfo = new ProcessStartInfo(adb, "devices -l") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true } }) {
                    process.Start(); Task<string> output = process.StandardOutput.ReadToEndAsync(), error = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(5000)) { try { process.Kill(); } catch (InvalidOperationException) { } result.message += " ADB 偵測逾時，可重新偵測或手動輸入。"; return result; }
                    if (!Task.WaitAll(new Task[] { output, error }, 1000)) { result.message += " ADB 輸出逾時。"; return result; }
                    if (process.ExitCode == 0) {
                        result.candidates.AddRange(ParseAdb(output.Result));
                        if (!result.candidates.Any(c => c.kind == "device")) result.message += " 沒有已授權且在線的 ADB 裝置，請確認 USB 偵錯授權或重新偵測。";
                    }
                    else result.message += " ADB 無法列出裝置，請確認偵錯授權或手動輸入。";
                }
            } catch (Exception) { result.message += " ADB 偵測失敗，可手動輸入或重新偵測。"; }
            return result;
        }
    }
}
