using System;
using System.Linq;
using System.Text.RegularExpressions;

namespace TerminalGridIntegrated
{
    internal static class AndroidLaunch
    {
        const string Launcher = "-a android.intent.action.MAIN -c android.intent.category.LAUNCHER";
        const string ComponentPattern = @"\A[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/\.?[A-Za-z_][A-Za-z0-9_.]*\z";

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
