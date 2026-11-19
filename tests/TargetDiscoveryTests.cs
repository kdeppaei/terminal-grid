using System;
using System.IO;
using System.Linq;
using TerminalGridIntegrated;
class TargetDiscoveryTests {
    public static int Main() {
        var items = TargetDiscovery.ParseAdb("List of devices attached\nUSB1 device usb:1-2 product:test model:Phone_A transport_id:1\nUSB2 unauthorized usb:1-3\nUSB3 offline usb:1-4\n192.0.2.55:5555 device model:Phone_B\n[fe80::1234%12]:5555 device model:Phone_C\n* daemon started successfully *\n");
        if (items.Count(i => i.kind == "device") != 3 || items.Any(i => i.value == "USB2" || i.value == "USB3")) throw new Exception("Unusable devices included");
        if (!items.Any(i => i.kind == "remote" && i.value == "192.0.2.55") || !items.Any(i => i.kind == "remote" && i.value == "fe80::1234%12")) throw new Exception("TCP/IP targets or scope missing");
        if (!items.Where(i => i.usb).Select(i => i.value).SequenceEqual(new[] { "USB1" })) throw new Exception("USB transport inferred incorrectly");
        if (TargetDiscovery.ParseAdb("").Count != 0) throw new Exception("Empty list");
        var apps = AndroidLaunch.Components("3 activities found:\r\n  com.android.settings/.Settings\r\ncom.test.app/com.test.Main\ncom.test.app/com.test.Main\ncom.bad/.App;reboot");
        if (!apps.SequenceEqual(new[] { "com.android.settings/.Settings", "com.test.app/com.test.Main" })) throw new Exception("Wrong launcher components");
        if (!AndroidLaunch.StartCommand(apps[0], false).EndsWith("-n com.android.settings/.Settings")) throw new Exception("Wrong app target");
        if (!AndroidLaunch.StartCommand("", true).EndsWith("-a android.intent.action.DIAL -d 'tel:%2A%239900%23'")) throw new Exception("Wrong SysDump URI");
        if (AndroidLaunch.ValidSerial("device;reboot") || !AndroidLaunch.ValidSerial("[fe80::1%12]:5555")) throw new Exception("Wrong serial validation");
        if (AndroidLaunch.WakeCommand != "input keyevent KEYCODE_WAKEUP") throw new Exception("Wake must not toggle the screen");
        string mirrorFolder = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "mirror fixture " + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(mirrorFolder);
        string mirror = Path.Combine(mirrorFolder, "scrcpy.exe");
        string fakeAdb = Path.Combine(mirrorFolder, "adb.exe");
        try {
            File.WriteAllText(mirror, "fixture only");
            var info = AndroidLaunch.MirrorStartInfo(fakeAdb, "USB1");
            if (info.FileName != mirror || info.WorkingDirectory != mirrorFolder || info.EnvironmentVariables["ADB"] != fakeAdb ||
                info.Arguments != "-s " + ShellBuilder.Quote("USB1") || info.UseShellExecute || !info.CreateNoWindow)
                throw new Exception("Mirror must target only the selected device and use the selected tools");
        } finally {
            File.Delete(mirror);
            Directory.Delete(mirrorFolder);
        }
        AndroidLaunch.CheckStartResult("Starting: Intent { ... }\r\nStatus: ok\r\nComplete\r\n");
        try {
            AndroidLaunch.CheckStartResult("Error: Activity not started\nStatus: timeout");
            throw new Exception("Launch failure was accepted");
        } catch (InvalidOperationException) { }
        Console.WriteLine("Target discovery: authorized USB/TCP devices, model labels, IPv4/IPv6 scopes, offline rejection passed."); return 0;
    }
}
