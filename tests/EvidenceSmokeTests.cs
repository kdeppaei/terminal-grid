using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;
using TerminalGridIntegrated;

class EvidenceSmokeTests
{
    [STAThread]
    public static int Main(string[] args)
    {
        int code = 1;
        Application.EnableVisualStyles();
        using (var form = new TerminalForm())
        using (var timer = new Timer { Interval = 45000 })
        {
            form.ShowInTaskbar = false;
            form.Opacity = 0;
            timer.Tick += (sender, eventArgs) => { Console.Error.WriteLine("Evidence smoke timed out."); form.Close(); };
            timer.Start();
            form.Shown += async (sender, eventArgs) =>
            {
                try
                {
                    var browser = (WebView2)form.Controls[0];
                    while (browser.CoreWebView2 == null) await Task.Delay(100);
                    var core = browser.CoreWebView2;
                    while (await core.ExecuteScriptAsync("document.querySelector('.connection-dot.connected') !== null") != "true")
                        await Task.Delay(100);
                    var config = AppConfig.Normalize(null);
                    var workspace = config.workspaces[0];
                    var tab = workspace.slots[0].tabs[0];
                    var json = ConfigStore.Serializer();
                    core.PostWebMessageAsJson(json.Serialize(new { type = "init", config = config }));
                    string output = args.Length == 0
                        ? "[  5] 0.00-10.00 sec 1.1 GBytes 941 Mbits/sec receiver\r\niperf Done.\r\n"
                        : File.ReadAllText(args[0]);
                    core.PostWebMessageAsJson(json.Serialize(new {
                        type = "output", workspaceId = workspace.id, slot = 0, tabId = tab.id,
                        data = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(output))
                    }));
                    await Task.Delay(250);
                    await core.ExecuteScriptAsync(
                        "document.querySelector('.terminal-grid:not([hidden]) .pane-title-row').click();" +
                        "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'F8',bubbles:true}));");
                    while (await core.ExecuteScriptAsync("document.getElementById('evidenceDialog').open") != "true") await Task.Delay(100);
                    string rate = json.Deserialize<string>(await core.ExecuteScriptAsync("document.getElementById('evidenceRate').value"));
                    if (!rate.EndsWith("bits/sec") || (args.Length == 0 && rate != "941 Mbits/sec"))
                        throw new Exception("Receiver rate did not populate.");
                    await core.ExecuteScriptAsync(
                        "document.getElementById('evidenceSheet').value='WiFi-Aware';" +
                        "document.getElementById('evidenceTc').value='TC-014';" +
                        "document.getElementById('evidenceResult').value='PASS';" +
                        "document.getElementById('evidenceForm').requestSubmit();");
                    string folder = Path.Combine(ConfigStore.DataFolder, "evidence");
                    while (!Directory.Exists(folder) || !Directory.GetFiles(folder, "*.log").Any()) await Task.Delay(100);
                    string log = Directory.GetFiles(folder, "*.log").Single();
                    string text = File.ReadAllText(log);
                    if (!new[] { "WiFi-Aware", "TC-014", "PASS", rate, "iperf Done." }.All(text.Contains))
                        throw new Exception("Paired log lacks test identity or result evidence.");
                    using (var image = new Bitmap(Path.ChangeExtension(log, ".png")))
                    {
                        bool green = false;
                        for (int y = 0; y < 65; y++)
                            for (int x = 0; x < 300; x++)
                            {
                                var pixel = image.GetPixel(x, y);
                                if (pixel.G > 120 && pixel.G > pixel.R + 35 && pixel.G > pixel.B + 30) green = true;
                            }
                        if (!green || image.Width < 720 || image.Height < 100) throw new Exception("PNG lacks the expected PASS heading or dimensions.");
                    }
                    Console.WriteLine("Native WebView2 F8 smoke passed: pane image, green PASS, receiver rate, same-stem log and completion evidence.");
                    code = 0;
                }
                catch (Exception ex) { Console.Error.WriteLine(ex); }
                form.Close();
            };
            Application.Run(form);
        }
        return code;
    }
}
