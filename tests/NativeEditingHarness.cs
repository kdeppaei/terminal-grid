using System;
using System.Collections.Generic;
using System.Text;
using System.Web.Script.Serialization;
using TerminalGridIntegrated;
class NativeEditingHarness {
    static readonly object gate = new object();
    static JavaScriptSerializer json = new JavaScriptSerializer();
    static void Send(object message) { lock(gate) Console.WriteLine(json.Serialize(message)); }
    public static int Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        using(var pty = new PtySession()) {
            bool ready = false; var pending = new List<byte[]>();
            pty.Output += bytes => { lock(gate) { if(!ready) pending.Add(bytes); else Send(new {type="output",data=Convert.ToBase64String(bytes)}); } };
            pty.Exited += code => Send(new {type="exited",exitCode=code});
            string line;
            while((line=Console.ReadLine())!=null) {
                var m=json.Deserialize<Dictionary<string,object>>(line); string type=(string)m["type"];
                if(type=="start") {
                    var command=ShellBuilder.Build(new PaneConfig {shell=args[1],cwd=args[0]});
                    pty.Start(command.Executable,command.Arguments,command.Directory,Convert.ToInt32(m["cols"]),Convert.ToInt32(m["rows"]));
                    lock(gate) {Send(new {type="started",pid=pty.ProcessId}); ready=true; foreach(var bytes in pending) Send(new {type="output",data=Convert.ToBase64String(bytes)}); pending.Clear();}
                } else if(type=="input") pty.Write(Encoding.UTF8.GetBytes((string)m["data"]));
                else if(type=="resize" && ready) pty.Resize(Convert.ToInt32(m["cols"]),Convert.ToInt32(m["rows"]));
                else if(type=="stop") break;
            }
        } return 0;
    }
}
