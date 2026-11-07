using System;
class NanFakeAdb {
    public static int Main(string[] args) {
        string scenario = Environment.GetEnvironmentVariable("TGRID_NAN_CASE") ?? "ok";
        if (args.Length < 4 || args[0] != "-s" || args[2] != "shell") return 9;
        if (args[3] == "-tt") { Console.WriteLine("EXEC " + args[1] + " " + String.Join(" ", args, 3, args.Length - 3)); return scenario == "exit" ? 7 : 0; }
        if (args[1] != "DUT_ONE") return 8;
        if (scenario == "offline") { Console.Error.WriteLine("device offline"); return 1; }
        if (scenario == "fallback" && args[3].StartsWith("ip ")) return 1;
        Console.WriteLine("7: aware_data1: <UP> mtu 1500\n    inet6 " + (scenario == "changed" ? "fe80::2222" : "fe80::1111") + "/64 scope link");
        return 0;
    }
}
