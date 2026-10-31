using System;
using System.IO;
using System.Text;
using System.Threading;
using TerminalGridIntegrated;

internal static class LiveReplaceNativeTests
{
    static void Check(string shell, string args, string directory, bool powershell, string replacement)
    {
        string name = (powershell ? "ps" : "cmd") + "-" + replacement + ".txt";
        string file = Path.Combine(directory, name);
        if (File.Exists(file)) File.Delete(file);
        using (PtySession session = new PtySession())
        {
            StringBuilder output = new StringBuilder();
            object gate = new object();
            session.Output += delegate(byte[] bytes) {
                string text = Encoding.UTF8.GetString(bytes);
                lock (gate) output.Append(text);
                if (text.Contains("\x1b[6n")) session.Write(Encoding.ASCII.GetBytes("\x1b[1;1R"));
            };
            session.Start(shell, args, directory, 160, 30);
            Thread.Sleep(powershell ? 1800 : 500);
            string command = powershell ? "Set-Content " + name + " '000111000'" : "echo 000111000>" + name;
            session.Write(Encoding.UTF8.GetBytes(command));
            Thread.Sleep(500);
            int end = command.IndexOf("111", StringComparison.Ordinal) + 3;
            string keys = String.Concat(System.Linq.Enumerable.Repeat("\x1b[D", command.Length - end)) + "\x7f\x7f\x7f" + replacement;
            session.Write(Encoding.UTF8.GetBytes(keys));
            Thread.Sleep(500);
            if (File.Exists(file)) throw new Exception("Replacement unexpectedly executed command: " + name);
            session.Write(Encoding.ASCII.GetBytes("\r"));
            for (int n = 0; n < 100 && !File.Exists(file); n++) Thread.Sleep(80);
            if (!File.Exists(file)) { lock(gate) throw new Exception("Command did not write file: " + output.ToString()); }
            Thread.Sleep(100);
            string actual = File.ReadAllText(file).Trim();
            if (actual != "000" + replacement + "000") throw new Exception(name + " wrong result: " + actual);
            Console.WriteLine("PASS " + (powershell ? "PowerShell" : "CMD") + " live 111 -> " + replacement + "; suffix preserved; no execution before Enter");
        }
    }
    public static int Main(string[] args)
    {
        try {
            string directory = Path.GetFullPath(args[0]); Directory.CreateDirectory(directory);
            foreach (string value in new [] { "222", "44", "55555", "" }) {
                Check(Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/D /Q", directory, false, value);
                Check(Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"), "-NoLogo -NoProfile -NoExit", directory, true, value);
            }
            return 0;
        } catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }
}
