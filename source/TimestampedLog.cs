using System;
using System.Globalization;
using System.IO;
using System.Text;

namespace TerminalGridIntegrated
{
    internal sealed class TimestampedLog : IDisposable
    {
        readonly StreamWriter writer;
        readonly Decoder decoder = new UTF8Encoding(false).GetDecoder();
        readonly StringBuilder line = new StringBuilder();
        char[] decoded = new char[4096];
        int escape;
        bool carriageReturn;

        public TimestampedLog(string path)
        {
            writer = new StreamWriter(new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read), new UTF8Encoding(false));
        }

        public void Write(byte[] bytes)
        {
            int capacity = Encoding.UTF8.GetMaxCharCount(bytes.Length);
            if (decoded.Length < capacity) decoded = new char[capacity];
            int length = decoder.GetChars(bytes, 0, bytes.Length, decoded, 0, false);
            for (int index = 0; index < length; index++) Consume(decoded[index]);
            writer.Flush();
        }

        void Consume(char value)
        {
            if (escape == 1) { escape = value == '[' ? 2 : "]P^_".IndexOf(value) >= 0 ? 3 : 0; return; }
            if (escape == 2) { if (value >= '@' && value <= '~') escape = 0; return; }
            if (escape == 3) { if (value == '\a') escape = 0; else if (value == '\x1b') escape = 4; return; }
            if (escape == 4) { escape = value == '\\' ? 0 : 3; return; }
            if (value == '\x1b') { escape = 1; return; }
            if (value == '\n' || value == '\r')
            {
                if (value != '\n' || !carriageReturn) WriteLine();
                carriageReturn = value == '\r';
                return;
            }
            carriageReturn = false;
            if (value == '\b') { if (line.Length > 0) line.Length--; return; }
            if (value >= ' ' || value == '\t') line.Append(value);
            if (line.Length >= 65536) WriteLine();
        }

        void WriteLine()
        {
            writer.Write(DateTimeOffset.Now.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz", CultureInfo.InvariantCulture));
            writer.Write("  ");
            writer.WriteLine(line.ToString());
            line.Clear();
        }

        public void Dispose()
        {
            try
            {
                int length = decoder.GetChars(new byte[0], 0, 0, decoded, 0, true);
                for (int index = 0; index < length; index++) Consume(decoded[index]);
                if (line.Length != 0) WriteLine();
            }
            finally { writer.Dispose(); }
        }
    }
}
