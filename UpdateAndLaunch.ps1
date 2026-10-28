$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$target = Join-Path $root 'TerminalGridIntegrated.exe'
$release = Join-Path $root '.release'
New-Item -ItemType Directory -Path $release -Force | Out-Null
$stage = Join-Path $release 'TerminalGridIntegrated.update.exe'
$backup = Join-Path $release ('TerminalGridIntegrated.previous-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.exe')
$replaced = $false
$newProcess = $null

try {
    & (Join-Path $root 'Build.ps1') -OutputPath $stage
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $stage -PathType Leaf)) { throw '新版建置失敗，舊版尚未變更。' }

    $running = @(Get-CimInstance Win32_Process -Filter "Name='TerminalGridIntegrated.exe'" |
        Where-Object { $_.ExecutablePath -and [System.StringComparer]::OrdinalIgnoreCase.Equals([System.IO.Path]::GetFullPath($_.ExecutablePath), $target) })
    foreach ($item in $running) {
        $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
        if ($process -and -not $process.HasExited) { [void]$process.CloseMainWindow() }
    }
    foreach ($item in $running) {
        try { Wait-Process -Id $item.ProcessId -Timeout 35 -ErrorAction Stop }
        catch { throw '舊版尚未關閉。若有執行中的終端，請在 Terminal Grid 主視窗確認結束；更新未強制終止任何程序。' }
    }

    if (Test-Path -LiteralPath $target -PathType Leaf) {
        [System.IO.File]::Replace($stage, $target, $backup)
    } else {
        [System.IO.File]::Move($stage, $target)
    }
    $replaced = $true
    $newProcess = Start-Process -FilePath $target -WorkingDirectory $root -PassThru
    Start-Sleep -Milliseconds 1800
    $newProcess.Refresh()
    if ($newProcess.HasExited) { throw '新版啟動後立即結束。' }
    Write-Host "已替換並啟動：$target"
    Write-Host "備份：$backup"
}
catch {
    if ($replaced -and $newProcess -and -not $newProcess.HasExited) {
        [void]$newProcess.CloseMainWindow()
        try { Wait-Process -Id $newProcess.Id -Timeout 10 -ErrorAction Stop } catch { }
    }
    if ($replaced -and (Test-Path -LiteralPath $backup -PathType Leaf)) {
        Copy-Item -LiteralPath $backup -Destination $target -Force
        Write-Warning '已還原先前版本。'
    }
    throw
}
