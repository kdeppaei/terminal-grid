using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using TerminalGridIntegrated;
class AdbFilesTests {
    static int count;
    static void Check(bool ok, string label) { if (!ok) throw new Exception(label); count++; }
    static string Reject(Action action) { try { action(); } catch (Exception ex) { count++; return ex.Message; } throw new Exception("Expected rejection"); }
    public static int Main(string[] args) {
        string root = Path.Combine(args[1], "files-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        Environment.SetEnvironmentVariable("TGRID_FILES_FIXTURE", root);
        string remote = Path.Combine(root, "remote.cfg"), backups = Path.Combine(root, "backups");
        var client = new AdbFiles(args[0], "PHONE_TEST", backups, CancellationToken.None);
        string path = "/vendor/firmware/wifi 4's.cfg";
        Check(AdbFiles.RemotePath("vendor/firmware/wifi 4.cfg") == "/vendor/firmware/wifi 4.cfg", "normalize path with spaces");
        Check(AdbFiles.ShellQuote("/x/a'b") == "'/x/a'\"'\"'b'", "shell quoting");
        Reject(() => AdbFiles.RemotePath("/")); Reject(() => AdbFiles.RemotePath("/data/../wifi.cfg")); Reject(() => AdbFiles.RemotePath("/x\nreboot"));
        byte[] initial = Encoding.UTF8.GetBytes("# 設定\nkey=1\n"); File.WriteAllBytes(remote, initial);
        Check(client.ReadOptional(path).SequenceEqual(initial), "raw UTF8 read");
        byte[] next = AdbFiles.Encode("# 設定\r\nkey=2\r\n", initial);
        string backup = client.Save(path, initial, next);
        Check(File.ReadAllBytes(Path.Combine(backup, "original.cfg")).SequenceEqual(initial), "exact backup");
        Check(File.ReadAllBytes(remote).SequenceEqual(next) && Encoding.UTF8.GetString(next).Contains("key=2\n"), "write verification and LF preservation");
        Check(File.ReadAllText(Path.Combine(root, "calls.txt")).Contains("cat > '/vendor/firmware/wifi 4'\"'\"'s.cfg'"), "remote filename quoting reaches process intact");
        int before = File.ReadAllLines(Path.Combine(root, "calls.txt")).Count(l => l.Contains("cat >"));
        Reject(() => client.Save(path, initial, next));
        Check(before == File.ReadAllLines(Path.Combine(root, "calls.txt")).Count(l => l.Contains("cat >")), "stale snapshot never writes");
        File.WriteAllText(Path.Combine(root, "deny"), "yes");
        string denied = Reject(() => client.Save(path, next, initial));
        Check(denied.Contains("備份") && denied.Contains("Read-only file system"), "permission failure reports recoverable backup and native error");
        Check(File.ReadAllBytes(remote).SequenceEqual(next), "denied write preserves phone fixture");
        File.Delete(Path.Combine(root, "deny")); File.WriteAllText(Path.Combine(root, "corrupt"), "yes");
        Check(Reject(() => client.Save(path, next, initial)).Contains("讀回"), "readback mismatch detected");
        File.Delete(Path.Combine(root, "corrupt")); File.Delete(remote);
        Check(client.ReadOptional(path) == null, "new file state"); client.Save(path, null, initial); Check(File.ReadAllBytes(remote).SequenceEqual(initial), "new file creation");
        string download = client.Pull("/sdcard/log/", root), second = client.Pull("/data/debuglogger", root);
        Check(download != second && File.Exists(Path.Combine(download, "log.txt")) && File.Exists(Path.Combine(second, "log.txt")), "pull isolation");
        string local = Path.Combine(root, "tool space.bin"); File.WriteAllBytes(local, new byte[] { 0, 1, 255 }); client.Push(local, "/data/local/tmp/tool space.bin");
        Check(File.ReadAllBytes(Path.Combine(root, "pushed.bin")).SequenceEqual(new byte[] { 0, 1, 255 }), "binary push with spaces");
        byte[] bom = new UTF8Encoding(true).GetPreamble().Concat(Encoding.UTF8.GetBytes("x=1\r\n")).ToArray();
        Check(AdbFiles.Encode("x=2\n", bom).Take(3).SequenceEqual(bom.Take(3)) && AdbFiles.Decode(AdbFiles.Encode("x=2\n", bom)) == "x=2\r\n", "BOM and CRLF preservation");
        Reject(() => AdbFiles.Decode(new byte[] { 0 })); Reject(() => AdbFiles.Decode(new byte[] { 255 }));
        File.WriteAllBytes(remote, new byte[AdbFiles.TextLimit + 1]); Reject(() => client.Read(path));
        using (var cancel = new CancellationTokenSource()) { cancel.CancelAfter(200); Reject(() => new AdbFiles(args[0], "PHONE_TEST", backups, cancel.Token).Run(new[] { "shell", "-T", "hang" })); }
        Console.WriteLine("ADB files: " + count + " checks passed; fixture subprocesses only, no physical device."); return 0;
    }
}
