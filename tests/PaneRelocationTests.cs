using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using TerminalGridIntegrated;
class PaneRelocationTests {
 static void Check(bool value,string label) { if(!value) throw new Exception(label); Console.WriteLine("PASS "+label); }
 static PaneAddress At(int slot) { return new PaneAddress { workspaceId="w",slot=slot,tabId="t" }; }
 public static int Main() {
  var config=AppConfig.Normalize(null);config.workspaces[0].id="w";
  for(int i=0;i<2;i++){config.workspaces[0].slots[i].tabs[0].id="t";config.workspaces[0].slots[i].activeTabId="t";}
  var states=new Dictionary<string,PaneState>(StringComparer.OrdinalIgnoreCase);
  var a=new PaneState {WorkspaceId="w",Slot=0,TabId="t",RouteId="a",Generation=5,InFlight=12};
  var b=new PaneState {WorkspaceId="w",Slot=1,TabId="t",RouteId="b",Generation=9};a.Output.Add(new byte[]{1,2});
  states.Add(At(0).Key,a);states.Add(At(1).Key,b);
  var moves=new[]{new PaneMove{from=At(0),to=At(1)},new PaneMove{from=At(1),to=At(0)}};
  try{PaneRelocation.Apply(states,config,config,moves,()=>{throw new IOException("disk failure");});throw new Exception("accepted failure");}catch(IOException){}
  Check(states[At(0).Key]==a && a.Slot==0,"failed persistence keeps runtime and routes unchanged");
  a.Starting=true;try{PaneRelocation.Apply(states,config,config,moves,()=>{});throw new Exception("accepted busy");}catch(InvalidOperationException){}a.Starting=false;
  Check(states[At(0).Key]==a,"busy terminal cannot be moved");
  PaneRelocation.Apply(states,config,config,moves,()=>{});
  Check(states[At(1).Key]==a && states[At(0).Key]==b && a.Slot==1 && b.Slot==0,"atomic swap with colliding tab IDs");
  Check(a.RouteId=="a" && a.Generation==5 && a.InFlight==12 && a.Output.Take()[1]==2,"route, generation, queued output and acknowledgements survive move");
  try{PaneRelocation.Apply(states,config,config,new[]{moves[0],moves[0]},()=>{});throw new Exception("accepted duplicates");}catch(ArgumentException){}
  Check(states[At(1).Key]==a,"duplicate movement rejected without side effects");
  using(var session=new PtySession()) {
   var output=new StringBuilder();var gate=new object();
   session.Output+=data=>{lock(gate)output.Append(Encoding.UTF8.GetString(data));};
   session.Start(Environment.GetEnvironmentVariable("COMSPEC"),"/D /Q /K",Path.GetTempPath(),100,24);
   int pid=session.ProcessId;a.Session=session;
   session.Write(Encoding.UTF8.GetBytes("set GRID_MOVE=before-move\r"));Thread.Sleep(300);
   PaneRelocation.Apply(states,config,config,moves,()=>{});
   states[At(0).Key].Session.Write(Encoding.UTF8.GetBytes("echo CHECK-%GRID_MOVE%\r"));
   bool found=false;var until=DateTime.UtcNow.AddSeconds(8);
   while(DateTime.UtcNow<until){lock(gate)found=output.ToString().Contains("CHECK-before-move");if(found)break;Thread.Sleep(50);}
   Check(found && a.Session.ProcessId==pid,"actual CMD retains PID and environment after moving");a.Session=null;
  }
  return 0;
 }
}
