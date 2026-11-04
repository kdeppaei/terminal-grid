using System;
using System.IO;
using System.Text;
using System.Threading;
using TerminalGridIntegrated;

internal static class LiveReplaceNativeTests
{
    static string Move(string direction, int count)
    {
        return String.Concat(System.Linq.Enumerable.Repeat("\x1b[" + direction, count));
    }

    static string Replace(string command, int start, int end, int cursor, string value)
    {
        string suffix = command.Substring(end);
        // Rebuild from the end so CMD's Insert/overwrite setting cannot consume
        // the suffix. Leave the caret immediately after the replacement.
        return Move("C", command.Length - cursor) + new String('\x7f', command.Length - start) + value + suffix + Move("D", suffix.Length);
    }

    static void Check(string shell, string args, string directory, bool powershell, string replacement, bool overwrite, bool middle, bool repeat, bool trailingSpaces = false)
    {
        string name = (powershell ? "ps" : "cmd") + "-" + replacement + (overwrite ? "-overwrite" : "-insert") + (middle ? "-middle" : "") + (repeat ? "-repeat" : "") + (trailingSpaces ? "-spaces" : "") + ".txt";
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
            if (trailingSpaces) command = ">" + name + " echo 000111000   ";
            session.Write(Encoding.UTF8.GetBytes(command));
            Thread.Sleep(500);
            int end = command.IndexOf("111", StringComparison.Ordinal) + 3;
            if (overwrite) {
                session.Write(Encoding.ASCII.GetBytes("\x1b[2~"));
                Thread.Sleep(150);
            }
            int cursor = command.Length;
            if (middle) {
                cursor = end - 5;
                session.Write(Encoding.ASCII.GetBytes(Move("D", command.Length - cursor)));
                Thread.Sleep(150);
            }
            session.Write(Encoding.UTF8.GetBytes(Replace(command, end - 3, end, cursor, replacement)));
            Thread.Sleep(500);
            if (repeat) {
                command = command.Substring(0, end - 3) + replacement + command.Substring(end);
                cursor = end - 3 + replacement.Length;
                session.Write(Encoding.UTF8.GetBytes(Replace(command, end - 3, cursor, cursor, "66")));
                replacement = "66";
                Thread.Sleep(500);
            }
            if (File.Exists(file)) throw new Exception("Replacement unexpectedly executed command: " + name);
            session.Write(Encoding.ASCII.GetBytes("\r"));
            for (int n = 0; n < 100 && !File.Exists(file); n++) Thread.Sleep(80);
            if (!File.Exists(file)) { lock(gate) throw new Exception("Command did not write file: " + output.ToString()); }
            Thread.Sleep(100);
            string actual = File.ReadAllText(file).TrimEnd('\r', '\n');
            string expected = "000" + replacement + "000" + (trailingSpaces ? "   " : "");
            if (actual != expected) throw new Exception(name + " wrong result: [" + actual + "] expected [" + expected + "]");
            Console.WriteLine("PASS " + name + "; prefix/suffix preserved; no execution before Enter");
        }
    }
    public static int Main(string[] args)
    {
        try {
            string directory = Path.GetFullPath(args[0]); Directory.CreateDirectory(directory);
            foreach (bool powershell in new [] { false, true }) {
                string shell = Path.Combine(Environment.SystemDirectory, powershell ? @"WindowsPowerShell\v1.0\powershell.exe" : "cmd.exe");
                string arguments = powershell ? "-NoLogo -NoProfile -NoExit" : "/D /Q";
                foreach (string value in new [] { "222", "44", "55555", "" }) {
                    Check(shell, arguments, directory, powershell, value, false, false, false);
                    Check(shell, arguments, directory, powershell, value, true, false, false);
                }
                Check(shell, arguments, directory, powershell, "222", false, true, false);
                Check(shell, arguments, directory, powershell, "222", false, false, true);
                Check(shell, arguments, directory, powershell, "222", true, true, true);
                if (!powershell) {
                    Check(shell, arguments, directory, false, "222", false, true, false, true);
                    Check(shell, arguments, directory, false, "222", true, true, false, true);
                }
            }
            return 0;
        } catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }
}
