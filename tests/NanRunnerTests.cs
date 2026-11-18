using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using TerminalGridIntegrated;
class NanRunnerTests {
    static int count;
    static void Check(bool pass, string label) { if (!pass) throw new Exception(label); count++; }
    static void Reject(Action action) { try { action(); } catch (Exception) { count++; return; } throw new Exception("Expected rejection"); }
    static void Run(string runner, string folder, string mode, string tool, string scenario, string expected, int code, bool auto = false, string python = null, string amount = "1300M") {
        string[] args = { "--mode", mode, "--dut1", "DUT_ONE", "--dut2", "DUT_TWO", "--if1", auto ? "auto" : "aware_data1", "--if2", auto ? "auto" : "aware_data0", "--tool", tool, "--bin1", "/data/local/tmp/" + tool, "--bin2", "/data/local/tmp/" + tool, "--amount", amount, "--port", tool == "iperf3" ? "5201" : "5001", "--folder", folder };
        if (python != null) args = args.Concat(new[] { "--python", python }).ToArray();
        var si = new ProcessStartInfo(runner, String.Join(" ", args.Select(ShellBuilder.Quote))) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        si.EnvironmentVariables["TGRID_NAN_CASE"] = scenario;
        if (mode == "python-probe") si.EnvironmentVariables["PATH"] = folder;
        using (var p = Process.Start(si)) {
            var output = p.StandardOutput.ReadToEndAsync(); var error = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(15000)) { p.Kill(); throw new Exception("Runner hung"); }
            string text = output.Result + error.Result;
            Check(p.ExitCode == code && text.Contains(expected), mode + " " + scenario + " " + text);
            if (scenario == "offline") Check(!text.Contains("EXEC"), "Offline query executed traffic");
            if (scenario == "python-ok") Check(text.Contains("NAN_PING_OK"), "Native runner did not relay the Python verifier output");
            if (scenario == "python-exit") Check(!text.Contains("NAN_PING_OK"), "Failed Python run reported a ping reply");
        }
    }
    static void CheckPythonProbe(string runner, string fixtureFolder)
    {
        string root = Path.Combine(Path.GetDirectoryName(runner), "NAN Python fixture " + Guid.NewGuid().ToString("N"));
        string tools = Path.Combine(root, "tools");
        string app = Path.Combine(root, Path.GetFileName(runner));
        string adb = Path.Combine(tools, "adb.exe");
        string python = Path.Combine(tools, "python.exe");
        string script = Path.Combine(tools, "nan_verify.py");
        Directory.CreateDirectory(tools);
        try {
            File.Copy(runner, app);
            File.Copy(Path.Combine(fixtureFolder, "adb.exe"), adb);
            File.Copy(adb, python);
            File.WriteAllText(script, "# Fixture: the mock executable reports its arguments.");
            string invocation = "PYTHON -u|" + script + "|--adb|" + adb + "|--dut1|DUT_ONE|--dut2|DUT_TWO";
            Run(app, tools, "python-probe", "iperf3", "python-ok", invocation + "|--if1|auto|--if2|auto|--ping|--terminal-grid", 0, true);
            Run(app, tools, "python-probe", "iperf3", "python-exit", invocation + "|--if1|aware_data1|--if2|aware_data0|--ping|--terminal-grid", 7, python: python);
            Run(app, tools, "python-probe", "iperf3", "missing-python", "Cannot find Python.", 1, python: Path.Combine(tools, "missing-python.exe"));
        } finally {
            foreach (string fixture in new[] { script, python, adb, app }) File.Delete(fixture);
            Directory.Delete(tools);
            Directory.Delete(root);
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
        Run(args[0], args[1], "traffic", "iperf3", "ok", "EXEC DUT_TWO -tt /data/local/tmp/iperf3 -6 -c fe80::1111%aware_data0 -p 5201 -f m -n 1300000000", 0, amount: "1300000000");
        Run(args[0], args[1], "server", "iperf3", "ok", "EXEC DUT_ONE -tt /data/local/tmp/iperf3 -6 -s -p 5201", 0);
        Run(args[0], args[1], "traffic", "iperf3", "offline", "device offline", 1);
        Run(args[0], args[1], "ping", "iperf3", "exit", "EXEC DUT_TWO", 7);
        Run(args[0], args[1], "traffic", "iperf3", "changed", "EXEC DUT_TWO -tt /data/local/tmp/iperf3 -6 -c fe80::2222%aware_data7", 0, true);
        Run(args[0], args[1], "traffic", "iperf3", "ambiguous", "Multiple Wi-Fi Aware interfaces", 1, true);
        CheckPythonProbe(args[0], args[1]);
        Console.WriteLine("NAN: " + count + " assertions; fixture ADB processes, no phones or network used."); return 0;
    }
}
