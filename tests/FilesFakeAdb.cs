using System;
using System.IO;
using System.Text;
using System.Threading;
class FilesFakeAdb {
    public static int Main(string[] args) {
        string root = Environment.GetEnvironmentVariable("TGRID_FILES_FIXTURE");
        if (String.IsNullOrEmpty(root) || args.Length < 4 || args[0] != "-s" || args[1] != "PHONE_TEST") return 9;
        string file = Path.Combine(root, "remote.cfg");
        File.AppendAllText(Path.Combine(root, "calls.txt"), String.Join("|", args) + "\n");
        if (args[2] == "pull") { File.WriteAllText(Path.Combine(args[4], "log.txt"), "fixture log"); Console.WriteLine("1 file pulled"); return 0; }
        if (args[2] == "push") { File.Copy(args[3], Path.Combine(root, "pushed.bin"), true); return 0; }
        string command = args[4];
        if (command == "hang") { Thread.Sleep(30000); return 0; }
        if (command.StartsWith("if [")) { Console.Write(File.Exists(file) ? "FILE" : "MISSING"); return 0; }
        if (command.StartsWith("cat >")) {
            if (File.Exists(Path.Combine(root, "deny"))) { Console.Error.Write("Read-only file system"); return 1; }
            using (var stream = File.Create(file)) Console.OpenStandardInput().CopyTo(stream);
            if (File.Exists(Path.Combine(root, "corrupt"))) File.AppendAllText(file, "CORRUPT");
            return 0;
        }
        if (command.StartsWith("cat ")) {
            if (!File.Exists(file)) { Console.Error.Write("not found"); return 1; }
            byte[] bytes = File.ReadAllBytes(file); Console.OpenStandardOutput().Write(bytes, 0, bytes.Length); return 0;
        }
        return 8;
    }
}
