using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using TerminalGridIntegrated;

internal static class TimestampedLogTests
{
    static int Main()
    {
        string path = Path.Combine(Path.GetTempPath(), "terminal-grid-" + Guid.NewGuid().ToString("N") + ".log");
        try
        {
            using (var log = new TimestampedLog(path))
            {
                foreach (byte value in Encoding.UTF8.GetBytes("\x1b[32m日誌\x1b[0m\r\noutput\nnod\be\rprogress"))
                    log.Write(new[] { value });
                using (var reader = new StreamReader(new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)))
                    if (!reader.ReadToEnd().Contains("  output")) throw new Exception("Complete lines were not flushed");
            }
            string[] lines = File.ReadAllLines(path);
            string[] expected = { "日誌", "output", "noe", "progress" };
            if (lines.Length != expected.Length) throw new Exception("Wrong newline handling");
            for (int i = 0; i < lines.Length; i++)
                if (!Regex.IsMatch(lines[i], @"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d  " + expected[i] + "$"))
                    throw new Exception("Unexpected timestamp or text");
            Console.WriteLine("Timestamped log: UTF-8, ANSI, chunked lines, flushing and final partial line passed.");
            return 0;
        }
        finally { File.Delete(path); }
    }
}
