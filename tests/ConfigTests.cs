using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using TerminalGridIntegrated;

static class ConfigTests
{
    static int assertions;
    static void Check(bool value, string label)
    {
        assertions++;
        if (!value) throw new Exception("FAIL: " + label);
        Console.WriteLine("PASS: " + label);
    }
    public static int Main(string[] args)
    {
        try
        {
            LayoutConfig empty = LayoutConfig.Normalize(null);
            Check(empty.slots.Count == 16 && empty.rows == 2 && empty.cols == 2, "null config gets 16 slots and 2x2 layout");
            Check(empty.slots[15].name == "終端 16", "default names keep fixed slot identity");
            LayoutConfig raw = new LayoutConfig { rows = -10, cols = 99, fontSize = 99 };
            raw.slots.Add(null);
            raw.slots.Add(new PaneConfig { name = new string('a', 100), shell = "invalid", command = new string('x', 20000) });
            for (int i=2; i<20; i++) raw.slots.Add(new PaneConfig());
            LayoutConfig normalized = LayoutConfig.Normalize(raw);
            Check(normalized.rows == 1 && normalized.cols == 4 && normalized.fontSize == 24, "layout and font limits are enforced");
            Check(normalized.slots.Count == 16 && normalized.slots[0] != null, "oversized and null slots normalize");
            Check(normalized.slots[1].name.Length == 80 && normalized.slots[1].shell == "PowerShell" && normalized.slots[1].command.Length == 16000, "slot fields and invalid shell normalize");
            LayoutConfig parsed = ConfigStore.Parse("{\"version\":99,\"rows\":4,\"cols\":4,\"fontSize\":1,\"slots\":null}");
            Check(parsed.version == 1 && parsed.fontSize == 10 && parsed.slots.Count == 16, "JSON schema normalizes imported values without launching");
            ShellCommand cmd = ShellBuilder.Build(new PaneConfig { shell = "CMD" });
            Check(cmd.Arguments == "/D /Q /K" && cmd.TemporaryScript == null, "blank CMD startup opens interactive shell with no generated script");
            string command = "Write-Host '中文 & % $ ` \"測試\"'\nGet-Date";
            ShellCommand ps = ShellBuilder.Build(new PaneConfig { shell = "PowerShell", command = command });
            string marker = " -EncodedCommand ";
            int start = ps.Arguments.IndexOf(marker, StringComparison.Ordinal);
            Check(start > 0 && Encoding.Unicode.GetString(Convert.FromBase64String(ps.Arguments.Substring(start + marker.Length))) == command, "PowerShell command round-trips as UTF16 encoded command");
            Check(ps.Arguments.Contains("-NoExit") && ps.Arguments.Contains("-NoProfile"), "PowerShell remains interactive and omits profiles");
            ShellCommand custom = ShellBuilder.Build(new PaneConfig { shell = "Custom", exe = Path.Combine(Environment.SystemDirectory, "cmd.exe"), args = "/D /K" });
            Check(custom.Arguments == "/D /K" && custom.Executable.EndsWith("cmd.exe", StringComparison.OrdinalIgnoreCase), "custom executable resolves without altering supplied args");
            Check(ShellBuilder.FindExecutable("missing-terminal-grid-7E7C723E.exe") == null, "missing custom shell is rejected");
            bool invalidCwd = false;
            try { ShellBuilder.Build(new PaneConfig { shell = "CMD", cwd = "C:\\missing-terminal-grid-7E7C723E" }); }
            catch (DirectoryNotFoundException) { invalidCwd = true; }
            Check(invalidCwd, "missing working directory is rejected before process creation");
            Check(ShellBuilder.Quote("C:\\folder with space\\") == "\"C:\\folder with space\\\\\"", "Windows argument quoting preserves trailing slash");
            if (args.Length > 0)
            {
                LayoutConfig example = ConfigStore.Read(args[0]);
                Check(example.rows == 2 && example.cols == 2 && example.slots.Count == 16, "four-pane example imports into fixed slots");
                Check(example.slots[0].command == "ping -t 127.0.0.1" && example.slots[3].command == "tracert example.com", "example commands are literal configuration data");
            }
            Console.WriteLine("OK: " + assertions + " assertions; no terminal process or network traffic was started.");
            return 0;
        }
        catch(Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }
}
