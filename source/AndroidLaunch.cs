using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace TerminalGridIntegrated
{
    internal static class AndroidLaunch
    {
        const string Launcher = "-a android.intent.action.MAIN -c android.intent.category.LAUNCHER";
        const string ComponentPattern = @"\A[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/\.?[A-Za-z_][A-Za-z0-9_.]*\z";
        static readonly Dictionary<string, Process> mirrors = new Dictionary<string, Process>(StringComparer.Ordinal);

        public static string WakeCommand { get { return "input keyevent KEYCODE_WAKEUP"; } }

        public static ProcessStartInfo MirrorStartInfo(string adb, string serial)
        {
            if (!ValidSerial(serial)) throw new ArgumentException("請選擇已授權的 ADB 裝置。");
            string adjacent = Path.Combine(Path.GetDirectoryName(adb), "scrcpy.exe");
            string scrcpy = File.Exists(adjacent) ? adjacent : ShellBuilder.FindExecutable("scrcpy.exe");
            if (scrcpy == null) throw new FileNotFoundException("找不到 scrcpy.exe。請選擇同時包含 adb.exe 和 scrcpy.exe 的資料夾，或將 scrcpy 加入 PATH。");
            var info = new ProcessStartInfo(scrcpy, "-s " + ShellBuilder.Quote(serial))
            {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(scrcpy)
            };
            info.EnvironmentVariables["ADB"] = adb;
            return info;
        }

        public static bool OpenMirror(string adb, string serial)
        {
            lock (mirrors)
            {
                foreach (string ended in mirrors.Where(pair => pair.Value.HasExited).Select(pair => pair.Key).ToArray())
                {
                    mirrors[ended].Dispose();
                    mirrors.Remove(ended);
                }
                if (mirrors.ContainsKey(serial)) return false;
                var process = Process.Start(MirrorStartInfo(adb, serial));
                if (process == null) throw new InvalidOperationException("無法啟動 scrcpy。");
                mirrors.Add(serial, process);
            }
            return true;
        }

        public static bool ValidSerial(string serial)
        {
            return Regex.IsMatch(serial, @"\A[A-Za-z0-9_.:\[\]%-]{1,128}\z");
        }
        public static string[] Components(string output)
        {
            return output.Split('\n').Select(line => line.Trim()).Where(ValidComponent)
                .Distinct(StringComparer.Ordinal).OrderBy(line => line, StringComparer.OrdinalIgnoreCase).Take(2000).ToArray();
        }
        static bool ValidComponent(string component)
        {
            return component.Length <= 512 && Regex.IsMatch(component, ComponentPattern);
        }
        public static string ListCommand { get { return "cmd package query-activities --components --user current " + Launcher; } }
        public static string StartCommand(string component, bool sysdump)
        {
            if (sysdump) return "am start -W --user current -a android.intent.action.DIAL -d 'tel:%2A%239900%23'";
            if (!ValidComponent(component)) throw new ArgumentException("請選擇有效的 App 啟動元件。");
            return "am start -W --user current " + Launcher + " -n " + component;
        }
        public static void CheckStartResult(string output)
        {
            var lines = output.Split('\n').Select(line => line.Trim()).ToArray();
            if (!lines.Contains("Status: ok", StringComparer.OrdinalIgnoreCase) ||
                lines.Any(line => line.StartsWith("Error", StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException(String.IsNullOrWhiteSpace(output) ? "ADB 沒有回報啟動結果。" : output.Trim());
        }
    }
}
