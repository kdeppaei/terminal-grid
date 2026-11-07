using System;
using System.Diagnostics;
using System.Linq;
using TerminalGridIntegrated;
class NanRunnerTests {
    static int count;
    static void Check(bool pass, string label) { if (!pass) throw new Exception(label); count++; }
    static void Reject(Action action) { try { action(); } catch (Exception) { count++; return; } throw new Exception("Expected rejection"); }
    static void Run(string runner, string folder, string mode, string tool, string scenario, string expected, int code) {
        string[] args = { "--mode", mode, "--dut1", "DUT_ONE", "--dut2", "DUT_TWO", "--if1", "aware_data1", "--if2", "aware_data0", "--tool", tool, "--bin1", "/data/local/tmp/" + tool, "--bin2", "/data/local/tmp/" + tool, "--amount", "1300M", "--port", tool == "iperf3" ? "5201" : "5001", "--folder", folder };
        var si = new ProcessStartInfo(runner, String.Join(" ", args.Select(ShellBuilder.Quote))) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        si.EnvironmentVariables["TGRID_NAN_CASE"] = scenario;
        using (var p = Process.Start(si)) {
            var output = p.StandardOutput.ReadToEndAsync(); var error = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(15000)) { p.Kill(); throw new Exception("Runner hung"); }
            string text = output.Result + error.Result;
            Check(p.ExitCode == code && text.Contains(expected), mode + " " + scenario + " " + text);
            if (scenario == "offline") Check(!text.Contains("EXEC"), "Offline query executed traffic");
        }
    }
    public static int Main(string[] args) {
        Check(NanRunner.SelectAddress("7: aware_data0: <UP>\n inet6 fe80::1234%77/64 scope link\n inet6 2001:db8::1/64 scope global\n8: wlan0: <UP>\n inet6 fe80::9999/64", "aware_data0") == "fe80::1234", "Wrong source interface or scope");
        Check(NanRunner.SelectAddress("aware_data0 Link encap:Ethernet\n inet6 addr: fe80::abcd/64 Scope: Link", "aware_data0") == "fe80::abcd", "ifconfig parse");
        Check(NanRunner.Scope("fe80::1234%99", "aware_data0") == "fe80::1234%aware_data0", "Destination scope");
        Reject(() => NanRunner.SelectAddress("inet6 fe80::1/64 tentative", "aware_data0"));
        Reject(() => NanRunner.SelectAddress("inet6 fe80::1/64\n inet6 fe80::2/64", "aware_data0"));
        Reject(() => NanRunner.SelectAddress("", "aware_data0"));
        Reject(() => NanRunner.Scope("fe80::1", "aware_data0;reboot"));
        Run(args[0], args[1], "ping", "iperf3", "ok", "EXEC DUT_TWO -tt ping6 -i 1 fe80::1111%aware_data0", 0);
        Run(args[0], args[1], "ping", "iperf3", "changed", "EXEC DUT_TWO -tt ping6 -i 1 fe80::2222%aware_data0", 0);
        Run(args[0], args[1], "ping", "iperf3", "fallback", "EXEC DUT_TWO -tt ping6 -i 1 fe80::1111%aware_data0", 0);
        Run(args[0], args[1], "traffic", "iperf3", "ok", "EXEC DUT_TWO -tt /data/local/tmp/iperf3 -6 -c fe80::1111%aware_data0 -p 5201 -f m -n 1300M", 0);
        Run(args[0], args[1], "traffic", "iperf", "ok", "EXEC DUT_TWO -tt /data/local/tmp/iperf -V -c fe80::1111%aware_data0 -p 5001 -f m -n 1300M", 0);
        Run(args[0], args[1], "server", "iperf3", "ok", "EXEC DUT_ONE -tt /data/local/tmp/iperf3 -6 -s -p 5201", 0);
        Run(args[0], args[1], "traffic", "iperf3", "offline", "device offline", 1);
        Run(args[0], args[1], "ping", "iperf3", "exit", "EXEC DUT_TWO", 7);
        Console.WriteLine("NAN: " + count + " assertions; fixture ADB processes, no phones or network used."); return 0;
    }
}
