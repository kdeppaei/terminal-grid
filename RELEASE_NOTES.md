# Terminal Grid 3.2.0

3.2.0 adds a local value shelf and editable command drafts for repeated network and device tests.

- Automatically capture IPv6 from recognized `inet6` / `IPv6` output lines, including common ifconfig, Android/ADB, ip -6 addr and ipconfig formats. Records include source workspace, terminal slot, interface and time.
- Keep the latest 80 records in memory, deduplicate repeated source/address pairs, copy from a context menu or button, and drag values into an active terminal without pressing Enter. Older records may no longer be valid.
- Manually save a selected device name, IPv4 address or other single-line value to the same shelf.
- Bring a selected command into a draft, select A in `ping A`, and replace only that selection with saved B via drag, context menu or Replace. Review the result before pasting it into the original terminal.
- Keep the draft target fixed even when focus moves to another terminal. Reject sends after the target terminal is stopped, removed or restarted.
- Retain explicit IPv6 scope suffixes, remove CIDR prefix lengths, and never infer a ping scope from a remote source interface.
- Handle split UTF-8 output and ANSI control sequences with bounded parsing; captures and drafts are excluded from saved/exported configuration.

Terminal history itself is read-only; replacement happens in the draft. Pasting appends at the destination terminal cursor and does not clear existing input or execute it. Automatic capture is format-based, not a live inventory of device connectivity. Real Wi-Fi Aware reconnection testing remains device-dependent.

## Download and update

Download the Windows x64 ZIP from the GitHub Releases page, extract all files to a folder, and run `TerminalGridIntegrated.exe`. Keep the WebView2 DLLs and `ui` folder beside the executable.

For this working copy, `UpdateAndLaunch.ps1` builds the new version to a staging path, asks the previous process to close, replaces the executable, and starts the new version. It does not force-terminate the old process; if an active terminal prompts for confirmation, confirm in the app so the update can continue.

Requires 64-bit Windows 10 1809 or later, .NET Framework 4.8, and Microsoft Edge WebView2 Runtime. The `.sha256` file contains the release ZIP checksum.

## License and company environment

The project-authored source is provided under the MIT License; third-party components retain their own licenses and notices. The executable is not Authenticode-signed. Public availability and MIT licensing do not constitute internal security approval. The application does not elevate privileges; child shells inherit the permissions of the launching user. Follow company software and endpoint approval requirements before use.

Closing the main window ends the integrated terminal sessions and their child processes after confirmation. The application does not attach to pre-existing CMD, PowerShell, Windows Terminal, ADB, or scrcpy windows.
