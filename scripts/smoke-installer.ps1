param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$taskInstallDir = Join-Path $env:RUNNER_TEMP 'CustomSubtitles-InstallerSmoke'
if (!$env:RUNNER_TEMP) { throw 'Run the installer smoke test on an isolated GitHub Actions runner.' }
$taskSetup = Start-Process -FilePath $Installer -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/MERGETASKS="!tailscale,!desktopicon"', ('/DIR="' + $taskInstallDir + '"')) -PassThru -Wait -WindowStyle Hidden
if ($taskSetup.ExitCode -ne 0) { throw 'Silent installer test failed.' }
$taskNode = Join-Path $taskInstallDir 'runtime\node.exe'
if (!(Test-Path -LiteralPath $taskNode)) { throw 'The installed Node.js runtime is missing.' }
if ((& $taskNode --version) -notmatch '^v24\.') { throw 'The installed Node.js runtime version is incorrect.' }
$env:PORT = '18700'
$env:PUBLIC_PORT = '18701'
$env:DATA_DIR = Join-Path $env:RUNNER_TEMP 'CustomSubtitles-InstallerSmokeData'
$env:OPEN_BROWSER = 'false'
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList @('src/server.js') -WorkingDirectory $taskInstallDir -PassThru -WindowStyle Hidden
try {
  $taskReady = $false
  for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
    if ($taskProcess.HasExited) { throw 'The installed server exited before becoming ready.' }
    try {
      $taskSession = Invoke-RestMethod -Uri 'http://127.0.0.1:18700/api/session'
      $taskReady = $taskSession.needsSetup -and $taskSession.setupAllowed
      if ($taskReady) { break }
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if (!$taskReady) { throw 'The installed server did not become ready.' }
  $taskGatewaySession = Invoke-RestMethod -Uri 'http://127.0.0.1:18701/api/session'
  if ($taskGatewaySession.setupAllowed) { throw 'Owner setup must not be available through the public gateway.' }
  $taskPage = Invoke-WebRequest -Uri 'http://127.0.0.1:18700/'
  if ($taskPage.Content -notmatch 'confirm-password-group') { throw 'The installed web interface is missing.' }
  $taskOwner = Invoke-RestMethod -Uri 'http://127.0.0.1:18700/api/setup' -Method Post -ContentType 'application/json' -Headers @{ Origin = 'http://127.0.0.1:18700' } -Body '{"password":"isolated-installer-smoke-password"}' -SessionVariable taskWebSession
  if (!$taskOwner.ok) { throw 'First-run password setup failed in the installed application.' }
  $taskConfig = Invoke-RestMethod -Uri 'http://127.0.0.1:18700/api/config' -WebSession $taskWebSession
  $taskExpectedVersion = (Get-Content -Raw -LiteralPath (Join-Path $taskInstallDir 'package.json') | ConvertFrom-Json).version
  if ($taskConfig.version -ne $taskExpectedVersion -or !$taskConfig.passwordEnabled) { throw 'The installed API configuration is incorrect.' }
  Write-Output 'Installer smoke test passed: bundled runtime, local server, web interface, and protected public gateway.'
} finally {
  if (!$taskProcess.HasExited) { Stop-Process -Id $taskProcess.Id -Force }
}
