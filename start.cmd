@echo off
cd /d "%~dp0"
set "CUSTOM_SUBTITLES_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    set "CUSTOM_SUBTITLES_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  ) else (
    echo Nainstalujte Node.js 24 LTS z https://nodejs.org/ a spustite tento subor znova.
    pause
    exit /b 1
  )
)
"%CUSTOM_SUBTITLES_NODE%" --env-file-if-exists=.env src/launcher.js
if errorlevel 1 pause
