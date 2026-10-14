param([switch]$PayloadOnly)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskBuild = Join-Path $taskRoot '.build'
$taskPayload = Join-Path $taskBuild 'payload'
$taskVendor = Join-Path $taskBuild 'vendor'
$taskDist = Join-Path $taskRoot 'dist'
if ($env:OS -ne 'Windows_NT') { throw 'The Windows installer must be built on Windows.' }
if (Test-Path -LiteralPath $taskBuild) { throw 'A .build directory already exists. Use a fresh checkout for a reproducible build.' }
foreach ($taskDirectory in @($taskPayload, $taskVendor, $taskDist, (Join-Path $taskPayload 'runtime'), (Join-Path $taskPayload 'assets'), (Join-Path $taskPayload 'licenses'))) { [IO.Directory]::CreateDirectory($taskDirectory) | Out-Null }
$taskPackage = Get-Content -Raw -LiteralPath (Join-Path $taskRoot 'package.json') | ConvertFrom-Json
$taskNode = (Get-Command node -ErrorAction Stop).Source
$taskNodeVersion = (& $taskNode --version).TrimStart('v')
if ($taskNodeVersion -notmatch '^24\.') { throw 'Build with the official Node.js 24 LTS runtime.' }

foreach ($taskItem in @('src', 'public', 'package.json', 'README.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', '.env.example', 'start.cmd')) {
  Copy-Item -LiteralPath (Join-Path $taskRoot $taskItem) -Destination $taskPayload -Recurse
}
Copy-Item -LiteralPath $taskNode -Destination (Join-Path $taskPayload 'runtime\node.exe')
Copy-Item -LiteralPath (Join-Path $taskRoot 'packaging\app.ico') -Destination (Join-Path $taskPayload 'assets\app.ico')
Set-Content -LiteralPath (Join-Path $taskPayload '.installed') -Value 'Store user data outside the installation directory.' -Encoding ascii

# Verify the bundled runtime against the checksum published by Node.js.
$taskNodeChecksums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/v$taskNodeVersion/SHASUMS256.txt").Content
$taskNodeMatch = [regex]::Match($taskNodeChecksums, '(?m)^([a-f0-9]{64})\s+win-x64/node\.exe\r?$')
if (!$taskNodeMatch.Success) { throw 'Cannot find the official Windows Node.js runtime checksum.' }
$taskNodeHash = (Get-FileHash -LiteralPath (Join-Path $taskPayload 'runtime\node.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
if ($taskNodeHash -ne $taskNodeMatch.Groups[1].Value) { throw 'The Node.js runtime does not match the official checksum.' }
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/v$taskNodeVersion/LICENSE" -OutFile (Join-Path $taskPayload 'licenses\Node-LICENSE.txt')

# Pin the Tailscale installer version and verify its vendor-published checksum.
$taskTailscaleVersion = '1.104.1'
$taskMsiUrl = "https://pkgs.tailscale.com/stable/tailscale-setup-$taskTailscaleVersion-amd64.msi"
$taskMsi = Join-Path $taskVendor 'tailscale.msi'
Invoke-WebRequest -Uri $taskMsiUrl -OutFile $taskMsi
$taskMsiChecksumText = (Invoke-WebRequest -Uri ($taskMsiUrl + '.sha256')).Content
$taskMsiChecksum = [regex]::Match($taskMsiChecksumText, '[a-fA-F0-9]{64}').Value.ToLowerInvariant()
if (!$taskMsiChecksum -or (Get-FileHash -LiteralPath $taskMsi -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskMsiChecksum) { throw 'The Tailscale installer checksum is invalid.' }
$taskSignature = Get-AuthenticodeSignature -LiteralPath $taskMsi
if ($taskSignature.Status -ne 'Valid' -or $taskSignature.SignerCertificate.Subject -notmatch 'Tailscale') { throw 'The Tailscale installer must have a valid Tailscale signature.' }
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/tailscale/tailscale/v$taskTailscaleVersion/LICENSE" -OutFile (Join-Path $taskPayload 'licenses\Tailscale-LICENSE.txt')

[pscustomobject]@{
  version = $taskPackage.version
  commit = $env:GITHUB_SHA
  nodeVersion = $taskNodeVersion
  nodeSha256 = $taskNodeHash
  tailscaleVersion = $taskTailscaleVersion
  tailscaleSha256 = $taskMsiChecksum
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskPayload 'build-info.json') -Encoding utf8

# No local environment files, credentials, or subtitle databases belong in a release.
foreach ($taskFile in Get-ChildItem -LiteralPath $taskPayload -Recurse -File -Force) {
  if ($taskFile.Name -eq '.env' -or $taskFile.Extension -in @('.sqlite', '.db') -or $taskFile.Name -match 'sqlite-(wal|shm)$') { throw 'Private data was found in the release payload.' }
}
if ($PayloadOnly) { Write-Output ('Payload prepared: ' + $taskPayload); exit 0 }
$taskCompiler = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if (!$taskCompiler) {
  $taskCompilerPath = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
  if (!(Test-Path -LiteralPath $taskCompilerPath)) { throw 'Install Inno Setup 6 to build the Windows installer.' }
} else { $taskCompilerPath = $taskCompiler.Source }
& $taskCompilerPath ("/DAppVersion=" + $taskPackage.version) ("/DPayloadDir=" + $taskPayload) ("/DVendorDir=" + $taskVendor) ("/DOutputDir=" + $taskDist) (Join-Path $taskRoot 'packaging\windows.iss')
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
$taskInstaller = Join-Path $taskDist ("CustomSubtitles-" + $taskPackage.version + '-Setup-x64.exe')
if (!(Test-Path -LiteralPath $taskInstaller)) { throw 'The installer artifact is missing.' }
$taskHash = (Get-FileHash -LiteralPath $taskInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath (Join-Path $taskDist 'SHA256SUMS.txt') -Value ($taskHash + '  ' + [IO.Path]::GetFileName($taskInstaller)) -Encoding ascii
Write-Output ('Installer built: ' + $taskInstaller)
