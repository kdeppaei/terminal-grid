using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using TerminalGridIntegrated;

// Runs inside a normal ConPTY cell. Each long-running adb command owns an
// Android PTY (-tt), so Ctrl+C / closing this cell also hangs up that command.
public static class NanRunner
{
    public static string SelectAddress(string output, string iface)
    {
        var addresses = new List<IPAddress>();
        string current = iface;
        foreach (string line in (output ?? "").Split('\n')) {
            var heading = Regex.Match(line, @"^\s*(?:\d+:\s+)?([\w.-]+)(?:@\S+)?:?\s+(?:<|flags|Link encap)");
            if (heading.Success) current = heading.Groups[1].Value;
            if (current != iface || Regex.IsMatch(line, @"\b(tentative|dadfailed)\b")) continue;
            var match = Regex.Match(line, @"\binet6\s+(?:addr:\s*)?([0-9a-fA-F:]+)(?:%[\w.-]+)?(?:/\d+)?(?=\s|$)");
            IPAddress ip;
            if (match.Success && IPAddress.TryParse(match.Groups[1].Value, out ip) && ip.AddressFamily == AddressFamily.InterNetworkV6 && !IPAddress.IsLoopback(ip) && !ip.Equals(IPAddress.IPv6Any)) addresses.Add(ip);
        }
        var unique = addresses.GroupBy(a => a.ToString()).Select(g => g.First()).ToList();
        var local = unique.Where(a => a.IsIPv6LinkLocal).ToList();
        var choices = local.Count > 0 ? local : unique;
        if (choices.Count != 1) throw new InvalidOperationException(choices.Count == 0 ? "No ready IPv6 on " + iface + ". Establish NDP, then restart this cell." : "Multiple IPv6 addresses on " + iface + "; select the intended address manually in an ADB shell.");
        return choices[0].ToString();
    }
    public static string Scope(string address, string destinationInterface)
    {
        if (!Regex.IsMatch(destinationInterface ?? "", @"^[A-Za-z0-9_.-]{1,32}$")) throw new ArgumentException("Invalid DUT2 interface.");
        return IPAddress.Parse(address.Split('%')[0]).ToString() + "%" + destinationInterface;
    }
    public static Dictionary<string, string> Parse(string[] args)
    {
        var values = new Dictionary<string, string>();
        if (args.Length % 2 != 0) throw new ArgumentException("Expected --name value pairs.");
        for (int i = 0; i < args.Length; i += 2) {
            if (!new[] { "mode", "dut1", "dut2", "if1", "if2", "tool", "bin1", "bin2", "amount", "port", "folder" }.Contains(args[i].TrimStart('-')) || !args[i].StartsWith("--")) throw new ArgumentException("Unknown option: " + args[i]);
            values.Add(args[i].Substring(2), args[i + 1]);
        }
        foreach (string key in new[] { "mode", "dut1", "dut2", "if1", "if2", "tool", "bin1", "bin2", "amount", "port", "folder" }) if (!values.ContainsKey(key)) throw new ArgumentException("Missing --" + key);
        if (!new[] { "mirror1", "mirror2", "shell1", "shell2", "server", "ping", "traffic" }.Contains(values["mode"])) throw new ArgumentException("Unknown mode.");
        foreach (string key in new[] { "dut1", "dut2" }) if (!Regex.IsMatch(values[key], @"^[A-Za-z0-9_.:\[\]%-]{1,128}$")) throw new ArgumentException("Invalid serial.");
        if (values["dut1"] == values["dut2"]) throw new ArgumentException("DUT1 and DUT2 must be different devices.");
        foreach (string key in new[] { "if1", "if2" }) if (!Regex.IsMatch(values[key], @"^[A-Za-z0-9_.-]{1,32}$")) throw new ArgumentException("Invalid interface.");
        foreach (string key in new[] { "bin1", "bin2" }) if (!Regex.IsMatch(values[key], @"^(?:/[A-Za-z0-9_.-]+)+$|^[A-Za-z0-9_][A-Za-z0-9_.-]*$")) throw new ArgumentException("Use a tool name or absolute Android executable path.");
        if (values["tool"] != "iperf3" && values["tool"] != "iperf") throw new ArgumentException("Choose iperf3 or iperf 2.");
        if (!Regex.IsMatch(values["amount"], @"^[1-9][0-9]{0,11}[KMG]?$")) throw new ArgumentException("Invalid transfer amount (example 1300M or 1300000000).");
        int port; if (!Int32.TryParse(values["port"], out port) || port < 1 || port > 65535) throw new ArgumentException("Invalid port.");
        return values;
    }
    static string FindTool(string name, string folder)
    {
        if (!String.IsNullOrWhiteSpace(folder)) {
            string candidate = Path.Combine(folder, name + ".exe");
            if (File.Exists(candidate)) return Path.GetFullPath(candidate);
        }
        string found = ShellBuilder.FindExecutable(name + ".exe");
        if (found == null) throw new FileNotFoundException("Cannot find " + name + ".exe. Set the tools folder or PATH.");
        return found;
    }
    static string Arguments(IEnumerable<string> args) { return String.Join(" ", args.Select(ShellBuilder.Quote)); }
    static string Query(string adb, string serial, string command)
    {
        using (var p = new Process { StartInfo = new ProcessStartInfo(adb, Arguments(new[] { "-s", serial, "shell", command })) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true } }) {
            p.Start(); var output = p.StandardOutput.ReadToEndAsync(); var error = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(5000)) { try { p.Kill(); } catch (InvalidOperationException) { } throw new TimeoutException("ADB query timed out. Check USB and authorization."); }
            if (!Task.WaitAll(new Task[] { output, error }, 1000)) throw new TimeoutException("ADB output timed out.");
            if (p.ExitCode != 0) throw new InvalidOperationException("ADB query failed: " + error.Result.Trim());
            return output.Result;
        }
    }
    static string ReadAddress(string adb, string serial, string iface)
    {
        string output;
        try { output = Query(adb, serial, "ip -6 addr show dev " + iface); }
        catch (InvalidOperationException) { output = Query(adb, serial, "ifconfig " + iface); }
        return SelectAddress(output, iface);
    }
    static int Run(string executable, string[] args)
    {
        using (var p = new Process { StartInfo = new ProcessStartInfo(executable, Arguments(args)) { UseShellExecute = false } }) {
            p.Start(); p.WaitForExit(); return p.ExitCode;
        }
    }
    public static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            var v = Parse(args); string mode = v["mode"], folder = v["folder"];
            if (mode.StartsWith("mirror")) return Run(FindTool("scrcpy", folder), new[] { "-s", v[mode == "mirror1" ? "dut1" : "dut2"], "--window-title", mode == "mirror1" ? "DUT1 - NAN" : "DUT2 - NAN" });
            string adb = FindTool("adb", folder);
            if (mode.StartsWith("shell")) return Run(adb, new[] { "-s", v[mode == "shell1" ? "dut1" : "dut2"], "shell", "-tt" });
            string serial, command;
            string ipv6Flag = v["tool"] == "iperf3" ? "-6" : "-V";
            if (mode == "server") {
                serial = v["dut1"]; command = v["bin1"] + " " + ipv6Flag + " -s -p " + v["port"];
            } else {
                Console.WriteLine("Reading current DUT1 IPv6 on " + v["if1"] + " ...");
                string address = ReadAddress(adb, v["dut1"], v["if1"]);
                string target = Scope(address, v["if2"]);
                Console.WriteLine("IPv6: " + address + " | DUT2 target: " + target);
                serial = v["dut2"];
                command = mode == "ping" ? "ping6 -i 1 " + target : v["bin2"] + " " + ipv6Flag + " -c " + target + " -p " + v["port"] + " -f m -n " + v["amount"];
            }
            Console.WriteLine("adb -s " + serial + " shell: " + command);
            Console.WriteLine("Ctrl+C stops this test. Restart this cell after rebuilding NDP to read the new IPv6.");
            return Run(adb, new[] { "-s", serial, "shell", "-tt", command });
        } catch (Exception e) { Console.Error.WriteLine("NAN: " + e.Message); return 1; }
    }
}
