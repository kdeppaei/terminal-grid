# Third-party notices

The MIT license at the repository root covers the original Terminal Grid code and documentation. The bundled third-party components retain their own licenses and copyright notices.

| Component | Version | License | Bundled notice |
| --- | --- | --- | --- |
| xterm.js (`@xterm/xterm`) | 6.0.0 | MIT | [xterm license](licenses/xterm-xterm-LICENSE) |
| xterm fit addon (`@xterm/addon-fit`) | 0.11.0 | MIT | [addon license](licenses/xterm-addon-fit-LICENSE) |
| Microsoft WebView2 SDK | 1.0.4314.35 | BSD 3-Clause | [SDK license](licenses/WebView2-LICENSE.txt), [package notices](licenses/WebView2-NOTICE.txt) |

WebView2 SDK files distributed with this application are `Microsoft.Web.WebView2.Core.dll`, `Microsoft.Web.WebView2.WinForms.dll`, and the x64 `WebView2Loader.dll`. The original package's `NOTICE.txt`, including its Antlr and StringTemplate notices, is preserved without modification.

Microsoft Edge WebView2 Runtime is a separate system dependency. It is not bundled with this repository or the release ZIP and is not relicensed by this project's MIT license.

Upstream sources:

- [xterm.js 6.0.0](https://github.com/xtermjs/xterm.js/tree/6.0.0)
- [xterm fit addon](https://github.com/xtermjs/xterm.js/tree/6.0.0/addons/addon-fit)
- [Microsoft WebView2 SDK NuGet package](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4314.35)
- [WebView2 Runtime distribution](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution)

Pinned download URLs, versions, and package integrity values are recorded in [dependencies.json](dependencies.json).
