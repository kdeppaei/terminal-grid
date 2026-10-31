[CmdletBinding()]
param(
    [switch]$ConfigOnly,
    [switch]$Stress
)

$ErrorActionPreference = 'Stop'
$testRoot = $PSScriptRoot
$testWork = Join-Path $testRoot '.test-work'
$testResults = Join-Path $testWork 'test-results'
$testCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$previousDataDirectory = [Environment]::GetEnvironmentVariable('TERMINALGRID_DATA_DIR', 'Process')
$locationPushed = $false

function Invoke-CheckedNative {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Native command failed with exit code ${LASTEXITCODE}: $Executable"
    }
}

function Build-Test {
    param([string]$Name, [string[]]$Sources, [string[]]$References)
    $testBinary = Join-Path $testWork ($Name + '.exe')
    $compilerArguments = @('/nologo', '/target:exe', '/platform:x64', '/optimize+', '/codepage:65001', "/out:$testBinary")
    $compilerArguments += @($References | ForEach-Object { '/r:' + $_ })
    $compilerArguments += $Sources
    Invoke-CheckedNative -Executable $testCompiler -Arguments $compilerArguments | Out-Host
    return $testBinary
}

try {
    if ($ConfigOnly -and $Stress) { throw 'Choose either -ConfigOnly or -Stress.' }
    if (-not (Test-Path -LiteralPath $testCompiler -PathType Leaf)) {
        throw 'The 64-bit .NET Framework C# compiler was not found. Run on supported 64-bit Windows with .NET Framework 4.8.'
    }
    New-Item -ItemType Directory -Path $testResults -Force | Out-Null
    $env:TERMINALGRID_DATA_DIR = Join-Path $testWork 'profile'
    Push-Location -LiteralPath $testRoot
    $locationPushed = $true

    $exampleFiles = @(Get-ChildItem -LiteralPath (Join-Path $testRoot 'examples') -Filter '*.json' -File)
    if ($exampleFiles.Count -ne 1) { throw 'Expected exactly one bundled JSON example.' }
    $configTest = Build-Test -Name 'ConfigTests' -Sources @('source\Config.cs', 'tests\ConfigTests.cs') -References @('System.dll', 'System.Core.dll', 'System.Web.Extensions.dll')
    Invoke-CheckedNative -Executable $configTest -Arguments @($exampleFiles[0].FullName)

    if (-not $ConfigOnly) {
        $folderTest = Build-Test -Name 'FolderStartupTests' -Sources @('source\Config.cs', 'source\FolderPicker.cs', 'source\PtySession.cs', 'tests\FolderStartupTests.cs') -References @('System.dll', 'System.Core.dll', 'System.Web.Extensions.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll')
        Invoke-CheckedNative -Executable $folderTest -Arguments @($testResults)
        $nativeTest = Build-Test -Name 'PtySelfTest' -Sources @('source\PtySession.cs', 'tests\PtySelfTest.cs') -References @('System.dll', 'System.Core.dll')
        Invoke-CheckedNative -Executable $nativeTest -Arguments @($testResults)
        $liveReplaceTest = Build-Test -Name 'LiveReplaceNativeTests' -Sources @('source\PtySession.cs', 'tests\LiveReplaceNativeTests.cs') -References @('System.dll', 'System.Core.dll')
        Invoke-CheckedNative -Executable $liveReplaceTest -Arguments @((Join-Path $testResults 'live-replace'))
        if ($Stress) {
            $stressTest = Build-Test -Name 'PtyStressTest' -Sources @('source\PtySession.cs', 'tests\PtyStressTest.cs') -References @('System.dll', 'System.Core.dll')
            Invoke-CheckedNative -Executable $stressTest -Arguments @()
        }
    }
    Write-Host "Tests passed. Local diagnostic files: $testResults"
}
catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
finally {
    [Environment]::SetEnvironmentVariable('TERMINALGRID_DATA_DIR', $previousDataDirectory, 'Process')
    if ($locationPushed) { Pop-Location }
}
