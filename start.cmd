@echo off
cd /d "%~dp0"
set "CUSTOM_SUBTITLES_NODE=node"
if exist "%~dp0runtime\node.exe" (
  set "CUSTOM_SUBTITLES_NODE=%~dp0runtime\node.exe"
  goto run_server
)
where node >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    set "CUSTOM_SUBTITLES_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  ) else (
    echo Install Node.js 24 LTS from https://nodejs.org/ and run this file again.
    pause
    exit /b 1
  )
)
:run_server
"%CUSTOM_SUBTITLES_NODE%" --env-file-if-exists=.env src/launcher.js
if errorlevel 1 pause
