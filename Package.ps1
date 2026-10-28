param(
    [string]$Version = '3.0.1',
    [switch]$SkipBuild,
    [string]$ApplicationPath = (Join-Path $PSScriptRoot 'TerminalGridIntegrated.exe')
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+([-.][A-Za-z0-9.-]+)?$') { throw 'Invalid package version.' }
$ApplicationPath = [System.IO.Path]::GetFullPath($ApplicationPath)
if (-not $SkipBuild) { & (Join-Path $PSScriptRoot 'Build.ps1') -OutputPath $ApplicationPath }
$applicationFile = $ApplicationPath
if (-not (Test-Path -LiteralPath $applicationFile -PathType Leaf)) { throw 'Build the application first.' }
$releaseFolder = Join-Path $PSScriptRoot '.release'
$stageFolder = Join-Path $releaseFolder ('stage-' + [Guid]::NewGuid().ToString('N'))
$payloadFolder = Join-Path $stageFolder 'TerminalGrid'
New-Item -ItemType Directory -Path $payloadFolder -Force | Out-Null
$payloadItems = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'ui', 'licenses', 'source', 'examples', 'tests', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'RELEASE_NOTES.md', '使用說明.md', '驗證紀錄.md', '預覽.png', 'dependencies.json', 'Build.ps1', 'UpdateAndLaunch.ps1', 'Package.ps1', 'Test.ps1')
foreach ($item in $payloadItems) {
    $sourceItem = Join-Path $PSScriptRoot $item
    if (-not (Test-Path -LiteralPath $sourceItem)) { throw "Missing package item: $item" }
    Copy-Item -LiteralPath $sourceItem -Destination $payloadFolder -Recurse
}
Copy-Item -LiteralPath $applicationFile -Destination (Join-Path $payloadFolder 'TerminalGridIntegrated.exe')
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
