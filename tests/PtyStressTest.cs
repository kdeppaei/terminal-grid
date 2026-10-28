using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using TerminalGridIntegrated;

internal static class PtyStressTest
{
    private static long bytes;
    private static int exits;
    private static int Main()
    {
        try
        {
            string cmd=Path.Combine(Environment.SystemDirectory,"cmd.exe");
            int initial=Process.GetCurrentProcess().HandleCount;
            int warmed=0;
            for(int round=0;round<4;round++)
            {
                List<PtySession> sessions=new List<PtySession>();
                List<int> pids=new List<int>();
                for(int i=0;i<16;i++)
                {
                    PtySession p=new PtySession();
                    p.Output += delegate(byte[] b) { Interlocked.Add(ref bytes,b.Length); };
                    p.Exited += delegate(int code) { Interlocked.Increment(ref exits); };
                    sessions.Add(p);
                    p.Start(cmd,"/D /Q /C \"for /L %i in (1,1,999999999) do @echo terminal-stress-test-%i-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\"",Environment.CurrentDirectory,80,24);
                    pids.Add(p.ProcessId);
                }
                Thread.Sleep(400);
                foreach(PtySession p in sessions) p.Resize(100,30);
                foreach(PtySession p in sessions) p.Resize(50,12);
                CountdownEvent stopped=new CountdownEvent(sessions.Count);
                Stopwatch timer=Stopwatch.StartNew();
                foreach(PtySession p in sessions)
                {
                    PtySession captured=p;
                    ThreadPool.QueueUserWorkItem(delegate(object state) { try { captured.Dispose(); } finally { stopped.Signal(); } });
                }
                if(!stopped.Wait(5000)) throw new Exception("Parallel Dispose did not return.");
                int target=(round+1)*16;
                Stopwatch exitTimer=Stopwatch.StartNew();
                while(exits<target && exitTimer.ElapsedMilliseconds<10000) Thread.Sleep(20);
                if(exits!=target) throw new Exception("Missing exit events: "+exits+" vs "+target);
                foreach(int pid in pids)
                {
                    try { using(Process child=Process.GetProcessById(pid)) if(!child.HasExited) throw new Exception("Leaked process "+pid); }
                    catch(ArgumentException) { }
                }
                stopped.Dispose();
                sessions.Clear();
                GC.Collect();
                GC.WaitForPendingFinalizers();
                GC.Collect();
                Thread.Sleep(200);
                int current=Process.GetCurrentProcess().HandleCount;
                if(round==1) warmed=current;
                Console.WriteLine("PASS 16 simultaneous streaming sessions, resize + concurrent disposal round "+(round+1)+", "+timer.ElapsedMilliseconds+"ms");
                Console.WriteLine("Handles after round: "+current);
            }
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            Thread.Sleep(200);
            int final=Process.GetCurrentProcess().HandleCount;
            Console.WriteLine("Drained "+bytes+" bytes; exited "+exits+" processes; host handle count "+initial+" -> "+final+".");
            if(final-warmed>8) throw new Exception("Unexpected retained handle growth after warm-up.");
            return 0;
        }
        catch(Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }
}
