# Terminal Grid 3.1.0

3.1.0 makes workspace, command-pack, and automation editing easier to manage. Automation flows can pause for a person to finish a task and continue only after the user chooses Continue.

- Add, rename, duplicate, and delete workspaces with in-app dialogs. Duplicated workspaces retain layout and terminal settings; their terminals do not start automatically.
- Add, edit, delete, rename, and duplicate command packs and snippets without browser prompt dialogs.
- Drag multiple `.tgridflow` and `.tgridcmd` files onto the application to import them. Imported flows still require review and an explicit run action.
- Add an automation step that pauses with a user-written instruction. Continue resumes later steps; Stop Flow cancels the remaining automation without closing running terminals.
- Preserve the existing command insertion safety behavior: inserting or dragging a snippet fills the terminal but does not press Enter.
- Document the scrcpy same-cell integration architecture and its test requirements. This release does not embed scrcpy windows; live-device validation remains outstanding because scrcpy and ADB were unavailable in the development environment.

## Download and update

Download the Windows x64 ZIP from the GitHub Releases page, extract all files to a folder, and run `TerminalGridIntegrated.exe`. Keep the WebView2 DLLs and `ui` folder beside the executable.

For this working copy, `UpdateAndLaunch.ps1` builds the new version to a staging path, asks the previous process to close, replaces the executable, and starts the new version. It does not force-terminate the old process; if an active terminal prompts for confirmation, confirm in the app so the update can continue.

Requires 64-bit Windows 10 1809 or later, .NET Framework 4.8, and Microsoft Edge WebView2 Runtime. The `.sha256` file contains the release ZIP checksum.

## License and company environment

The project-authored source is provided under the MIT License; third-party components retain their own licenses and notices. The executable is not Authenticode-signed. Public availability and MIT licensing do not constitute internal security approval. The application does not elevate privileges; child shells inherit the permissions of the launching user. Follow company software and endpoint approval requirements before use.

Closing the main window ends the integrated terminal sessions and their child processes after confirmation. The application does not attach to pre-existing CMD, PowerShell, Windows Terminal, ADB, or scrcpy windows.
