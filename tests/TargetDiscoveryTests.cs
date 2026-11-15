using System;
using System.Linq;
using TerminalGridIntegrated;
class TargetDiscoveryTests {
    public static int Main() {
        var items = TargetDiscovery.ParseAdb("List of devices attached\nUSB1 device product:test model:Phone_A transport_id:1\nUSB2 unauthorized\nUSB3 offline\n192.0.2.55:5555 device model:Phone_B\n[fe80::1234%12]:5555 device model:Phone_C\n* daemon started successfully *\n");
        if (items.Count(i => i.kind == "device") != 3 || items.Any(i => i.value == "USB2" || i.value == "USB3")) throw new Exception("Unusable devices included");
        if (!items.Any(i => i.kind == "remote" && i.value == "192.0.2.55") || !items.Any(i => i.kind == "remote" && i.value == "fe80::1234%12")) throw new Exception("TCP/IP targets or scope missing");
        if (TargetDiscovery.ParseAdb("").Count != 0) throw new Exception("Empty list");
        var apps = AndroidLaunch.Components("3 activities found:\r\n  com.android.settings/.Settings\r\ncom.test.app/com.test.Main\ncom.test.app/com.test.Main\ncom.bad/.App;reboot");
        if (!apps.SequenceEqual(new[] { "com.android.settings/.Settings", "com.test.app/com.test.Main" })) throw new Exception("Wrong launcher components");
        if (!AndroidLaunch.StartCommand(apps[0], false).EndsWith("-n com.android.settings/.Settings")) throw new Exception("Wrong app target");
        if (!AndroidLaunch.StartCommand("", true).EndsWith("-a android.intent.action.DIAL -d 'tel:%2A%239900%23'")) throw new Exception("Wrong SysDump URI");
        if (AndroidLaunch.ValidSerial("device;reboot") || !AndroidLaunch.ValidSerial("[fe80::1%12]:5555")) throw new Exception("Wrong serial validation");
        AndroidLaunch.CheckStartResult("Starting: Intent { ... }\r\nStatus: ok\r\nComplete\r\n");
        try {
            AndroidLaunch.CheckStartResult("Error: Activity not started\nStatus: timeout");
            throw new Exception("Launch failure was accepted");
        } catch (InvalidOperationException) { }
        Console.WriteLine("Target discovery: authorized USB/TCP devices, model labels, IPv4/IPv6 scopes, offline rejection passed."); return 0;
    }
}
