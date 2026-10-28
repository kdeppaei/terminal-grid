# Terminal Grid 2.0.0

在單一 Windows 主視窗操作多個獨立 CMD／PowerShell 終端，固定網格最多 16 格。

- 每格獨立名稱、Shell、工作目錄與選用啟動指令。
- 直接輸入、Ctrl+C、中斷後繼續操作、中文輸出、調整字級與單格放大。
- 縮小格數保留隱藏工作階段；停止終端後保留畫面。
- JSON 配置匯入／匯出；載入配置不自動執行指令。

## 下載

下載 Windows x64 ZIP，完整解壓縮後開啟 `TerminalGridIntegrated.exe`。請保留 DLL 和 `ui` 資料夾。

需要 Windows 10 1809 以上、.NET Framework 4.8 與已安裝的 WebView2 Runtime。`*.sha256` 提供 SHA-256 校驗值。

## 驗證

已實測 CMD／PowerShell 互動、中文、Ctrl+C、尺寸同步與工作階段子程序清理；原生層通過四輪各 16 格並行測試。可攜式 `Test.ps1` 隨原始碼提供。

## 授權與公司環境

原始程式碼採 MIT；第三方元件維持原授權並隨附 notices。本版 EXE 未簽署 Authenticode，不代表已通過公司內部資安、端點或軟體核准。程式沒有內建提權，Shell 仍繼承啟動者的權限。請依公司核准流程執行。

關閉主視窗並確認後，會結束本工具內建的終端與測試工作。
