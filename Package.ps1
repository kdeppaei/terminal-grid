param(
    [string]$Version = '3.19.2',
    [switch]$SkipBuild,
    [string]$ApplicationPath = (Join-Path $PSScriptRoot 'TerminalGridIntegrated.exe')
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+([-.][A-Za-z0-9.-]+)?$') { throw 'Invalid package version.' }
$ApplicationPath = [System.IO.Path]::GetFullPath($ApplicationPath)
if (-not $SkipBuild) { & (Join-Path $PSScriptRoot 'Build.ps1') -OutputPath $ApplicationPath }
$applicationFile = $ApplicationPath
if (-not (Test-Path -LiteralPath $applicationFile -PathType Leaf)) { throw 'Build the application first.' }
if ((Get-Item -LiteralPath $applicationFile).VersionInfo.FileVersion -ne "$Version.0") { throw 'Application version does not match package version.' }
if ((Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ui\help.js') -Raw) -notmatch ("version: '" + [regex]::Escape($Version) + "'")) { throw 'Update the in-app help before packaging this version.' }
$releaseFolder = Join-Path $PSScriptRoot '.release'
$stageFolder = Join-Path $releaseFolder ('stage-' + [Guid]::NewGuid().ToString('N'))
$payloadFolder = Join-Path $stageFolder 'TerminalGrid'
New-Item -ItemType Directory -Path $payloadFolder -Force | Out-Null
# The ui folder is an internal WebView2 runtime asset. Releases expose only the
# Windows GUI executable; no standalone HTML package is produced.
$payloadItems = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'ui', 'licenses', 'source', 'examples', 'tests', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'AGENTS.md', 'README.md', 'RELEASE_NOTES.md', '使用說明.md', '驗證紀錄.md', 'SCRCPY_INTEGRATION_SPIKE.md', '預覽.png', 'dependencies.json', 'Build.ps1', 'UpdateAndLaunch.ps1', 'UpdateFromPackage.ps1', 'Update.cmd', 'Package.ps1', 'Test.ps1')
foreach ($item in $payloadItems) {
    $sourceItem = Join-Path $PSScriptRoot $item
    if (-not (Test-Path -LiteralPath $sourceItem)) { throw "Missing package item: $item" }
    Copy-Item -LiteralPath $sourceItem -Destination $payloadFolder -Recurse
}
New-Item -ItemType Directory -Path (Join-Path $payloadFolder 'tools') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'tools\nan_verify.py') -Destination (Join-Path $payloadFolder 'tools\nan_verify.py')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'tools\wait_wifi_ap.py') -Destination (Join-Path $payloadFolder 'tools\wait_wifi_ap.py')
Copy-Item -LiteralPath $applicationFile -Destination (Join-Path $payloadFolder 'TerminalGridIntegrated.exe')
Copy-Item -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($applicationFile)) 'TerminalGridNan.exe') -Destination $payloadFolder
$packageFiles = @(Get-ChildItem -LiteralPath $payloadFolder -File -Recurse | Sort-Object FullName | ForEach-Object {
    $relativePath = $_.FullName.Substring($payloadFolder.Length + 1).Replace('\','/')
    if ($relativePath -match '(^|/)(WebView2|startup|backups|evidence|captures|runs|terminal-logs|layout\.json|\.env[^/]*)(/|$)|\.(apk|apks|pcap|pcapng|log|tgridflow|tgridcmd)$') {
        throw 'Package includes a private file type or user data directory.'
    }
    [ordered]@{ path=$relativePath; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$manifest = [ordered]@{ format='terminal-grid-package'; version=$Version; files=$packageFiles } | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText((Join-Path $payloadFolder 'package-files.json'), $manifest, [Text.UTF8Encoding]::new($false))
$packageName = "TerminalGrid-Windows-x64-v$Version.zip"
$packagePath = Join-Path $releaseFolder $packageName
Compress-Archive -LiteralPath $payloadFolder -DestinationPath $packagePath -Force
$checksum = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumPath = Join-Path $releaseFolder ($packageName + '.sha256')
$checksumContent = "$checksum  $packageName" + [Environment]::NewLine
[System.IO.File]::WriteAllText($checksumPath, $checksumContent, (New-Object System.Text.UTF8Encoding($false)))
$resolvedStage = [System.IO.Path]::GetFullPath($stageFolder)
$resolvedRelease = [System.IO.Path]::GetFullPath($releaseFolder) + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedStage.StartsWith($resolvedRelease, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid staging location.' }
Remove-Item -LiteralPath $resolvedStage -Recurse -Force
Write-Host "Package: $packagePath"
Write-Host "SHA256: $checksum"
