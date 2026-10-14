param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$taskInstallDir = Join-Path $env:RUNNER_TEMP 'Custom Subtitles Installer Smoke'
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
  $taskSubtitleFixture = Join-Path $env:RUNNER_TEMP 'custom-subtitles-update-smoke.srt'
  Set-Content -LiteralPath $taskSubtitleFixture -Value "1`n00:00:01,000 --> 00:00:03,000`nPreserve this subtitle across the automatic update.`n" -Encoding utf8
  $taskUploaded = Invoke-RestMethod -Uri 'http://127.0.0.1:18700/api/subtitles' -Method Post -WebSession $taskWebSession -Form @{ type = 'movie'; title = 'Inception'; imdbId = 'tt1375666'; lang = 'eng'; encoding = 'utf-8'; file = (Get-Item -LiteralPath $taskSubtitleFixture) }
  if (!$taskUploaded.subtitle.id) { throw 'The update preservation fixture was not uploaded.' }
  Write-Output 'Installer smoke test passed: bundled runtime, local server, web interface, and protected public gateway.'
} finally {
  if (!$taskProcess.HasExited) { Stop-Process -Id $taskProcess.Id -Force }
}

$taskUpdateCache = Join-Path $env:RUNNER_TEMP 'CustomSubtitles-UpdateSmoke'
$taskUpdateScript = Join-Path $PSScriptRoot 'smoke-update.mjs'
$taskUpdateProcess = Start-Process -FilePath $taskNode -ArgumentList @(('"' + $taskUpdateScript + '"'), ('"' + $taskInstallDir + '"'), ('"' + $Installer + '"')) -WorkingDirectory $taskInstallDir -PassThru -WindowStyle Hidden
try {
  if (!$taskUpdateProcess.WaitForExit(45000) -or $taskUpdateProcess.ExitCode -ne 0) { throw 'The automatic update launcher did not hand over successfully.' }
  $taskUpdated = $false
  for ($taskAttempt = 0; $taskAttempt -lt 180; $taskAttempt++) {
    $taskStatusPath = Join-Path $taskUpdateCache 'last-update.json'
    if (Test-Path -LiteralPath $taskStatusPath) {
      $taskUpdateStatus = Get-Content -Raw -LiteralPath $taskStatusPath | ConvertFrom-Json
      if (!$taskUpdateStatus.success) { throw ('The automatic update failed: ' + $taskUpdateStatus.error) }
      try {
        $taskNewLogin = Invoke-RestMethod -Uri 'http://127.0.0.1:18700/api/login' -Method Post -ContentType 'application/json' -Body '{"password":"isolated-installer-smoke-password"}' -SessionVariable taskUpdatedSession
        if ($taskNewLogin.ok) { $taskUpdated = $true; break }
      } catch { }
    }
    Start-Sleep -Milliseconds 500
  }
  if (!$taskUpdated) { throw 'The application did not reopen after the automatic update.' }
  $taskUpdatedConfig = Invoke-RestMethod -Uri 'http://127.0.0.1:18700/api/config' -WebSession $taskUpdatedSession
  $taskUpdatedLibrary = Invoke-RestMethod -Uri 'http://127.0.0.1:18700/api/subtitles' -WebSession $taskUpdatedSession
  if ($taskUpdatedConfig.version -ne $taskExpectedVersion -or $taskUpdatedConfig.addonUrl -ne $taskConfig.addonUrl -or $taskUpdatedLibrary.subtitles.Count -ne 1 -or $taskUpdatedLibrary.subtitles[0].id -ne $taskUploaded.subtitle.id) { throw 'Automatic update did not preserve the library, addon key, or settings.' }
  Write-Output 'Automatic-update smoke test passed: verified download, parent exit, silent installation, automatic reopen, and preserved password, addon key, and subtitles.'
} finally {
  if (!$taskUpdateProcess.HasExited) { Stop-Process -Id $taskUpdateProcess.Id -Force }
  $taskServerConnections = Get-NetTCPConnection -LocalPort 18700 -State Listen -ErrorAction SilentlyContinue
  foreach ($taskOwnerId in @($taskServerConnections.OwningProcess | Select-Object -Unique)) {
    if ($taskOwnerId) {
      $taskOwnedServer = Get-Process -Id $taskOwnerId -ErrorAction SilentlyContinue
      if ($taskOwnedServer.Path -eq $taskNode) { Stop-Process -Id $taskOwnerId -Force }
    }
  }
}
