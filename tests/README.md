# Local verification

Run from a normal PowerShell session on supported 64-bit Windows with .NET Framework 4.8:

```powershell
.\Test.ps1 -ConfigOnly # Configuration checks; no child shells or network traffic
.\Test.ps1             # Configuration and native terminal smoke checks
.\Test.ps1 -Stress     # Also run four rounds of 16 simultaneous terminals
```

The native checks start local CMD and Windows PowerShell processes, send interactive input, ping only `127.0.0.1`, resize the terminal, and check that closing a session ends its shell and child process. They do not execute the external-network example commands. No administrator rights, execution policy changes, or downloaded test dependencies are required. Existing company execution controls still apply.

The script compiles the test source files into `.test-work/` and isolates application configuration in `.test-work/profile/`. Diagnostic text and a temporary child PID file stay under `.test-work/test-results/`; do not add these local files to Git or release ZIPs. The script restores its previous working directory and `TERMINALGRID_DATA_DIR` environment value on completion or failure. Compiler and test failures return a nonzero exit code.

These checks cover configuration and the native ConPTY layer. They do not replace a manual UI check or company software approval.

## Capture and command draft checks

With Node.js available, run `node tests/Ipv6CaptureTests.js`. This dependency-free suite covers IPv6 formats, interface metadata, explicit scope preservation, invalid inputs, every chunk boundary, ANSI control strings, and bounded buffering. GitHub Actions runs it on each build.

Optional frontend integration checks require a separately installed Playwright module and Microsoft Edge (no browser download is performed):

```powershell
node tests/CaptureUiTests.js
node tests/EditingUiTests.js
```

Use the normal Node module resolution or set `NODE_PATH` to an existing approved module directory. These checks use isolated headless browser profiles and mock host/clipboard objects. They verify the real UI scripts, real xterm input integration, selection replacement, source/generation isolation and no-Enter paste behavior, but do not verify native WebView2 clipboard access or real Wi-Fi Aware devices. Local diagnostic screenshots remain in `.test-work/` and are excluded from release packages.

## 3.3.0 輸入與替換測試

`EditingUiTests.js` 使用真實 Edge／xterm、模擬原生訊息橋與剪貼簿，檢查快捷鍵是否取消瀏覽器預設重複貼上、連按與按住的差異、複製與中斷、工作階段切換期間的非同步貼上，以及單行輸入列的選取刪除、游標插入、手動替換、暫存建議與拖入。也涵蓋分頁隔離、Enter 與「貼入」的送出差異，以及較小視窗的操作。

此測試不會改寫 Windows 系統剪貼簿，也不能代替實際 WebView2／作業系統剪貼簿驗收。執行結果記錄於 [驗證紀錄](../驗證紀錄.md)。
