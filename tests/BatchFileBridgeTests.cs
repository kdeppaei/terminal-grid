// Optional installed-WebView2 smoke test. Uses an inert file input and CDP;
// no TerminalForm, batch script or terminal process is launched.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
class BatchFileBridgeTests : Form
{
    readonly WebView2 browser = new WebView2 { Dock = DockStyle.Fill };
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly string fixture;
    readonly Timer timeout = new Timer { Interval = 45000 };
    int code = 1;
    BatchFileBridgeTests(string path)
    {
        fixture = path; Opacity = 0; ShowInTaskbar = false; Controls.Add(browser);
        timeout.Tick += (s,e) => { Console.Error.WriteLine("WebView2 file bridge timed out"); Close(); }; timeout.Start();
        Shown += async (s,e) => { try { await Run(); } catch (Exception ex) { Console.Error.WriteLine(ex); Close(); } };
    }
    async Task Run()
    {
        var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Path.GetDirectoryName(fixture), "profile"));
        await browser.EnsureCoreWebView2Async(env);
        browser.CoreWebView2.WebMessageReceived += (s,e) => {
            try {
                var file = e.AdditionalObjects.Single() as CoreWebView2File;
                if (file == null || file.Path != fixture) throw new Exception("Native File path differs from selected local file");
                code = 0; Console.WriteLine("WebView2 File bridge passed: actual DOM File resolves exact local BAT path; no BAT executed.");
            } catch (Exception ex) { Console.Error.WriteLine(ex); }
            Close();
        };
        var loaded = new TaskCompletionSource<bool>();
        browser.CoreWebView2.NavigationCompleted += (s,e) => loaded.TrySetResult(e.IsSuccess);
        browser.NavigateToString("<!doctype html><html><body><input id='file' type='file'></body></html>");
        if (!await loaded.Task) throw new Exception("Fixture navigation failed");
        var document = json.Deserialize<Dictionary<string,object>>(await browser.CoreWebView2.CallDevToolsProtocolMethodAsync("DOM.getDocument", "{}"));
        var node = (Dictionary<string,object>)document["root"];
        var selected = json.Deserialize<Dictionary<string,object>>(await browser.CoreWebView2.CallDevToolsProtocolMethodAsync("DOM.querySelector", json.Serialize(new { nodeId=node["nodeId"], selector="#file" })));
        await browser.CoreWebView2.CallDevToolsProtocolMethodAsync("DOM.setFileInputFiles", json.Serialize(new { nodeId=selected["nodeId"], files=new[] { fixture } }));
        await browser.CoreWebView2.ExecuteScriptAsync("chrome.webview.postMessageWithAdditionalObjects({type:'batchDrop'}, [document.getElementById('file').files[0]]);");
    }
    [STAThread] public static int Main(string[] args)
    {
        string dir = Path.GetFullPath(args[0]); Directory.CreateDirectory(dir);
        string file = Path.Combine(dir, "中文 & ! %FILE% fixture.bat"); File.WriteAllText(file, "@rem inert fixture - never executed");
        Application.EnableVisualStyles(); using (var form = new BatchFileBridgeTests(file)) { Application.Run(form); return form.code; }
    }
}
