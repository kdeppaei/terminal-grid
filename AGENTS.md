# Terminal Grid release requirements

- Keep the product a Windows GUI application; `ui/` is an embedded runtime asset.
- Every release must update `ui/help.js`: version, date, new behavior, relevant shortcuts and limitations. Keep the in-app “本版操作／快捷說明” consistent with README, 使用說明 and release notes.
- Preserve existing workspaces, custom commands and flows in ConfigStore.DataFolder. Never ship personal layout, WebView2 profile, captures, logs or device-file backups in public artifacts.
- Generate and validate the release file manifest. Updating may replace only packaged application files, must back up existing configuration/application files, and must retain unrelated files.
- BAT/CMD drops run the original local file in a new CMD tab in the selected cell. Imported tgridflow/tgridcmd files and restored configuration must never auto-run.
- Run relevant native/UI checks, update/reopen the exact local installation, and publish the public MIT GitHub release when authorized by the conversation. Do not force-terminate unrelated processes.
