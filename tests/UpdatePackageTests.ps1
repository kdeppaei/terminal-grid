param([Parameter(Mandatory=$true)][string]$Package)
$ErrorActionPreference = 'Stop'
$testBase = Join-Path (Split-Path $PSScriptRoot -Parent) ('.test-work\update-' + [Guid]::NewGuid().ToString('N'))
$source = Join-Path $testBase 'package'
$target = Join-Path $testBase 'installed'
$profile = Join-Path $testBase 'profile'
New-Item -ItemType Directory -Path $source,$target,$profile -Force | Out-Null
Expand-Archive -LiteralPath $Package -DestinationPath $source
$source = Join-Path $source 'TerminalGrid'
Copy-Item -LiteralPath (Join-Path $source 'TerminalGridIntegrated.exe') -Destination $target
New-Item -ItemType Directory -Path (Join-Path $target 'ui'),(Join-Path $profile 'WebView2') -Force | Out-Null
$oldUi = Join-Path $target 'ui\app.js'
[IO.File]::WriteAllText($oldUi, 'OLD_APPLICATION')
$layout = Join-Path $profile 'layout.json'
$extra = Join-Path $target 'my-personal.tgridcmd'
$preference = Join-Path $profile 'WebView2\preferences.fixture'
[IO.File]::WriteAllText($layout, '{"workspaces":[{"name":"keep workspace"}],"commandPacks":[{"name":"keep commands"}],"automations":[{"name":"keep flow"}]}')
[IO.File]::WriteAllText($extra, 'PERSONAL_FILE')
[IO.File]::WriteAllText($preference, 'KEEP_UI_PREFERENCES')
$before = (Get-FileHash -LiteralPath $layout).Hash
$previousData = $env:TERMINALGRID_DATA_DIR
function Assert-Update([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message }; Write-Host "PASS $Message" }
try {
    $env:TERMINALGRID_DATA_DIR = $profile
    & (Join-Path $source 'UpdateFromPackage.ps1') -TargetDirectory $target -NoLaunch
    Assert-Update ((Get-FileHash -LiteralPath $oldUi).Hash -eq (Get-FileHash -LiteralPath (Join-Path $source 'ui\app.js')).Hash) 'application files replaced'
    Assert-Update (((Get-FileHash -LiteralPath $layout).Hash -eq $before) -and (Get-Content -LiteralPath $extra -Raw) -eq 'PERSONAL_FILE' -and (Get-Content -LiteralPath $preference -Raw) -eq 'KEEP_UI_PREFERENCES') 'workspace, commands, flows, preferences and extra files preserved'
    Assert-Update (@(Get-ChildItem -LiteralPath (Join-Path $profile 'backups') -File).Count -eq 1) 'configuration backed up before update'
    Assert-Update (@(Get-ChildItem -LiteralPath (Join-Path $target '.updates') -File -Recurse | Where-Object { $_.Name -eq 'app.js' -and (Get-Content -LiteralPath $_.FullName -Raw) -eq 'OLD_APPLICATION' }).Count -eq 1) 'previous application files backed up'
    [IO.File]::WriteAllText($oldUi, 'ROLLBACK_EXPECTED')
    $lock = [IO.File]::Open((Join-Path $target 'ui\help.js'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    $rejected = $false
    try { & (Join-Path $source 'UpdateFromPackage.ps1') -TargetDirectory $target -NoLaunch } catch { $rejected = $true } finally { $lock.Dispose() }
    Assert-Update ($rejected -and (Get-Content -LiteralPath $oldUi -Raw) -eq 'ROLLBACK_EXPECTED' -and (Get-FileHash -LiteralPath $layout).Hash -eq $before) 'failed overwrite restores touched files and retains personal data'
    $manifestPath = Join-Path $source 'package-files.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifest.files[0].path = 'ui/../../outside.txt'
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5))
    $rejected = $false
    try { & (Join-Path $source 'UpdateFromPackage.ps1') -TargetDirectory $target -NoLaunch } catch { $rejected = $true }
    Assert-Update ($rejected -and (Get-Content -LiteralPath $oldUi -Raw) -eq 'ROLLBACK_EXPECTED') 'invalid package path rejected before replacement'
    Write-Host 'Update package: 6 checks passed in isolated installation/profile; no application launched.'
} finally { $env:TERMINALGRID_DATA_DIR = $previousData }
