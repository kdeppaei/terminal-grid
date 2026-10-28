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
