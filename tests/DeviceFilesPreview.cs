using System;
using System.Windows.Forms;
using TerminalGridIntegrated;
class DeviceFilesPreview {
    [STAThread] public static void Main() { Application.EnableVisualStyles(); Application.Run(new DeviceFilesForm()); }
}
