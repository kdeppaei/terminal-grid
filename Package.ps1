param(
    [string]$Version = '2.1.0',
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+([-.][A-Za-z0-9.-]+)?$') { throw 'Invalid package version.' }
if (-not $SkipBuild) { & (Join-Path $PSScriptRoot 'Build.ps1') }
$applicationFile = Join-Path $PSScriptRoot 'TerminalGridIntegrated.exe'
if (-not (Test-Path -LiteralPath $applicationFile)) { throw 'Build the application first.' }
$releaseFolder = Join-Path $PSScriptRoot '.release'
$stageFolder = Join-Path $releaseFolder ('stage-' + [Guid]::NewGuid().ToString('N'))
$payloadFolder = Join-Path $stageFolder 'TerminalGrid'
New-Item -ItemType Directory -Path $payloadFolder -Force | Out-Null
$payloadItems = @('TerminalGridIntegrated.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'ui', 'licenses', 'source', 'examples', 'tests', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', '使用說明.md', '驗證紀錄.md', '預覽.png', 'dependencies.json', 'Build.ps1', 'Package.ps1', 'Test.ps1')
foreach ($item in $payloadItems) {
    $sourceItem = Join-Path $PSScriptRoot $item
    if (-not (Test-Path -LiteralPath $sourceItem)) { throw "Missing package item: $item" }
    Copy-Item -LiteralPath $sourceItem -Destination $payloadFolder -Recurse
}
$packageName = "TerminalGrid-Windows-x64-v$Version.zip"
$packagePath = Join-Path $releaseFolder $packageName
Compress-Archive -LiteralPath $payloadFolder -DestinationPath $packagePath -Force
$checksum = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumPath = Join-Path $releaseFolder ($packageName + '.sha256')
[System.IO.File]::WriteAllText($checksumPath, "$checksum  $packageName`n", (New-Object System.Text.UTF8Encoding($false)))
# Remove only the verified staging directory created in this invocation.
$resolvedStage = [System.IO.Path]::GetFullPath($stageFolder)
$resolvedRelease = [System.IO.Path]::GetFullPath($releaseFolder) + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedStage.StartsWith($resolvedRelease, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid staging location.' }
Remove-Item -LiteralPath $resolvedStage -Recurse -Force
Write-Host "Package: $packagePath"
Write-Host "SHA256: $checksum"
