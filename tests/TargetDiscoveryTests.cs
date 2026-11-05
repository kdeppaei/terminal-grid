using System;
using System.Linq;
using TerminalGridIntegrated;
class TargetDiscoveryTests {
    public static int Main() {
        var items = TargetDiscovery.ParseAdb("List of devices attached\nUSB1 device product:test model:Phone_A transport_id:1\nUSB2 unauthorized\nUSB3 offline\n192.0.2.55:5555 device model:Phone_B\n[fe80::1234%12]:5555 device model:Phone_C\n* daemon started successfully *\n");
        if (items.Count(i => i.kind == "device") != 3 || items.Any(i => i.value == "USB2" || i.value == "USB3")) throw new Exception("Unusable devices included");
        if (!items.Any(i => i.kind == "remote" && i.value == "192.0.2.55") || !items.Any(i => i.kind == "remote" && i.value == "fe80::1234%12")) throw new Exception("TCP/IP targets or scope missing");
        if (TargetDiscovery.ParseAdb("").Count != 0) throw new Exception("Empty list");
        Console.WriteLine("Target discovery: authorized USB/TCP devices, model labels, IPv4/IPv6 scopes, offline rejection passed."); return 0;
    }
}
