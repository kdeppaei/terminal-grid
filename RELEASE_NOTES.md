# Terminal Grid 3.0.0

Terminal Grid 3.0 adds named workspaces, stacked terminal tabs in each grid cell, reusable automation flows, and portable command packs.

- Create up to 12 named workspaces. Each workspace keeps its own 1–4 by 1–4 layout.
- Add up to 8 terminal tabs inside any cell. Switching tabs stays inside that cell; sessions keep running when hidden.
- Build ordered flows from start, send command, wait, and stop steps, targeting a specific cell and terminal tab. Review the full target and command list before each run.
- Save and share automation as .tgridflow files. Imported flows create a separate workspace and do not execute until the user runs them.
- Manage command snippets in local packs and import/export .tgridcmd files. Right-click, click Insert, or drag a snippet into a running terminal; insertion never presses Enter.
- Keep existing folder-based startup, custom shell settings, copy/paste, and 1–16 cell layouts.
- Upgrade prior JSON layout files automatically. Configuration remains local under %LOCALAPPDATA%\TerminalGridIntegrated.

## Download and update

Download the Windows x64 ZIP from the GitHub Releases page, extract all files to a folder, and run TerminalGridIntegrated.exe. Keep the WebView2 DLLs and ui folder beside the executable.

For this working copy, UpdateAndLaunch.ps1 builds the new version to a staging path, asks the previous process to close, replaces the executable, and starts the new version. It does not force-terminate the old process; if an active terminal prompts for confirmation, confirm in the app so the update can continue.

Requires 64-bit Windows 10 1809 or later, .NET Framework 4.8, and Microsoft Edge WebView2 Runtime. The .sha256 file contains the release ZIP checksum.

## License and company environment

The project-authored source is provided under the MIT License; third-party components retain their own licenses and notices. The executable is not Authenticode-signed. Public availability and MIT licensing do not constitute internal security approval. The application does not elevate privileges; child shells inherit the permissions of the launching user. Follow company software and endpoint approval requirements before use.

Closing the main window ends the integrated terminal sessions and their child processes after confirmation. The application does not attach to pre-existing CMD, PowerShell, Windows Terminal, ADB, or scrcpy windows; start commands in a managed terminal tab when you need that tab's output and input.
