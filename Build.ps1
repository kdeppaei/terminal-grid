$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler was not found.' }
$sources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'source') -Filter '*.cs' | ForEach-Object { $_.FullName })
$arguments = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001', "/out:$PSScriptRoot\TerminalGridIntegrated.exe", "/win32manifest:$PSScriptRoot\source\app.manifest", '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', "/r:$PSScriptRoot\Microsoft.Web.WebView2.Core.dll", "/r:$PSScriptRoot\Microsoft.Web.WebView2.WinForms.dll")
& $compiler $arguments $sources
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
Write-Host "Built: $PSScriptRoot\TerminalGridIntegrated.exe"
