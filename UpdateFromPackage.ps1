[CmdletBinding()]
param([string]$TargetDirectory, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$updateSource = [IO.Path]::GetFullPath($PSScriptRoot)
$updateManifest = Join-Path $updateSource 'package-files.json'
$updateTouched = @()
$updateBackups = $null

function Get-UpdatePath([string]$Root, [string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative) -or $Relative -match '(^|[\/])\.\.?([\/]|$)|:' ) { throw 'Invalid package path.' }
    $absolute = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if (-not $absolute.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Package path leaves target folder.' }
    # Do not write through an existing directory link into unrelated data.
    $probe = Split-Path -Parent $absolute
    while ($probe -and $probe.Length -ge $Root.Length) {
        if ((Test-Path -LiteralPath $probe) -and ((Get-Item -LiteralPath $probe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Linked folder is not an update target: $probe" }
        $probe = Split-Path -Parent $probe
    }
    if ((Test-Path -LiteralPath $absolute) -and ((Get-Item -LiteralPath $absolute -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Linked file is not an update target: $absolute" }
    return $absolute
}

try {
    if (-not (Test-Path -LiteralPath $updateManifest)) { throw 'Please extract the complete release ZIP before running Update.cmd.' }
    $manifest = Get-Content -LiteralPath $updateManifest -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.format -ne 'terminal-grid-package' -or @($manifest.files).Count -eq 0) { throw 'Invalid package manifest.' }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($item in $manifest.files) {
        if ($item.path -notmatch '^(ui[\/]|source[\/]|tests[\/]|licenses[\/]|examples[\/]|(?:TerminalGridIntegrated\.exe|TerminalGridNan\.exe|Microsoft\.Web\.WebView2\.(?:Core|WinForms)\.dll|WebView2Loader\.dll|LICENSE|THIRD_PARTY_NOTICES\.md|AGENTS\.md|README\.md|RELEASE_NOTES\.md|使用說明\.md|驗證紀錄\.md|SCRCPY_INTEGRATION_SPIKE\.md|預覽\.png|dependencies\.json|Build\.ps1|UpdateAndLaunch\.ps1|UpdateFromPackage\.ps1|Update\.cmd|Package\.ps1|Test\.ps1)$)' -or -not $seen.Add($item.path.Replace('/','\'))) { throw 'Unexpected or duplicate package file.' }
        $file = Get-UpdatePath $updateSource $item.path
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $item.sha256) { throw "Package file failed validation: $($item.path)" }
    }
    if (-not $TargetDirectory) {
        Add-Type -AssemblyName System.Windows.Forms
        $picker = New-Object System.Windows.Forms.FolderBrowserDialog
        $picker.Description = '選擇原本 TerminalGridIntegrated.exe 所在資料夾；更新會保留個人配置。'
        $picker.ShowNewFolderButton = $false
        $running = @(Get-CimInstance Win32_Process -Filter "Name='TerminalGridIntegrated.exe'" | Where-Object ExecutablePath)
        if ($running.Count -eq 1) { $picker.SelectedPath = Split-Path -Parent $running[0].ExecutablePath }
        try { if ($picker.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { return }; $TargetDirectory = $picker.SelectedPath } finally { $picker.Dispose() }
    }
    $updateTarget = [IO.Path]::GetFullPath($TargetDirectory).TrimEnd('\')
    $targetExe = Get-UpdatePath $updateTarget 'TerminalGridIntegrated.exe'
    if (-not (Test-Path -LiteralPath $targetExe -PathType Leaf)) { throw 'The selected folder does not contain TerminalGridIntegrated.exe.' }
    if ([StringComparer]::OrdinalIgnoreCase.Equals($updateTarget, $updateSource.TrimEnd('\'))) { throw 'Extract the new ZIP into a separate folder, then select the OLD application folder.' }
    if ([version](Get-Item -LiteralPath $targetExe).VersionInfo.FileVersion -gt [version]("$($manifest.version).0")) { throw 'The installed version is newer than this package.' }
    $plan = @($manifest.files | ForEach-Object { [pscustomobject]@{ source=(Get-UpdatePath $updateSource $_.path); target=(Get-UpdatePath $updateTarget $_.path); relative=$_.path; existed=(Test-Path -LiteralPath (Get-UpdatePath $updateTarget $_.path)) } })
    foreach ($item in $plan) { if (Test-Path -LiteralPath $item.target -PathType Container) { throw "A folder conflicts with an application file: $($item.target)" } }
    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,6)
    $updateBackups = Get-UpdatePath $updateTarget ('.updates\' + $stamp)
    New-Item -ItemType Directory -Path $updateBackups -Force | Out-Null
    foreach ($item in @(Get-CimInstance Win32_Process -Filter "Name='TerminalGridIntegrated.exe'" | Where-Object { $_.ExecutablePath -and [StringComparer]::OrdinalIgnoreCase.Equals($_.ExecutablePath, $targetExe) })) {
        $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow(); if (-not $process.WaitForExit(35000)) { throw 'Close the existing Terminal Grid window first. No files have been replaced.' } }
    }
    $dataFolder = if ($env:TERMINALGRID_DATA_DIR) { [IO.Path]::GetFullPath($env:TERMINALGRID_DATA_DIR) } else { Join-Path $env:LOCALAPPDATA 'TerminalGridIntegrated' }
    $layout = Join-Path $dataFolder 'layout.json'
    if (Test-Path -LiteralPath $layout -PathType Leaf) {
        $dataBackup = Join-Path $dataFolder 'backups'; New-Item -ItemType Directory -Path $dataBackup -Force | Out-Null
        Copy-Item -LiteralPath $layout -Destination (Join-Path $dataBackup ("layout-update-$stamp.json"))
    }
    foreach ($item in $plan) {
        if ($item.existed) {
            $backup = Get-UpdatePath $updateBackups $item.relative
            New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
            Copy-Item -LiteralPath $item.target -Destination $backup
        }
        $updateTouched += $item
        New-Item -ItemType Directory -Path (Split-Path -Parent $item.target) -Force | Out-Null
        Copy-Item -LiteralPath $item.source -Destination $item.target -Force
    }
    Write-Host "Updated to $($manifest.version). Previous application files: $updateBackups"
    if (-not $NoLaunch) { Start-Process -FilePath $targetExe -WorkingDirectory $updateTarget | Out-Null }
}
catch {
    # Restore only files this attempt touched. Never remove user folders/data.
    foreach ($item in $updateTouched) {
        if ($item.existed) { Copy-Item -LiteralPath (Get-UpdatePath $updateBackups $item.relative) -Destination $item.target -Force }
        elseif (Test-Path -LiteralPath $item.target -PathType Leaf) { Remove-Item -LiteralPath $item.target -Force }
    }
    if (-not $NoLaunch) { Add-Type -AssemblyName System.Windows.Forms; [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Terminal Grid update') }
    throw
}
