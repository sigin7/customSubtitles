#ifndef AppVersion
  #define AppVersion "1.1.0"
#endif

[Setup]
AppId={{EEBC9D4F-0262-45DF-9D9F-2AE89EB13868}
AppName=Custom Subtitles
AppVersion={#AppVersion}
AppPublisher=sigin7
AppPublisherURL=https://github.com/sigin7/customSubtitles
AppSupportURL=https://github.com/sigin7/customSubtitles/issues
DefaultDirName={localappdata}\Programs\CustomSubtitles
DefaultGroupName=Custom Subtitles
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.17763
OutputDir={#OutputDir}
OutputBaseFilename=CustomSubtitles-{#AppVersion}-Setup-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=app.ico
UninstallDisplayIcon={app}\assets\app.ico
LicenseFile=INSTALLER-NOTICE.txt
CloseApplications=yes
RestartApplications=no
DisableProgramGroupPage=yes
UninstallDisplayName=Custom Subtitles

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: checkedonce
Name: "tailscale"; Description: "Install Tailscale on this server if missing (requires administrator approval)"; GroupDescription: "Required for public HTTPS access:"; Check: NeedsTailscale

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#VendorDir}\tailscale.msi"; DestDir: "{tmp}"; Flags: dontcopy

[Icons]
Name: "{group}\Custom Subtitles"; Filename: "{app}\runtime\node.exe"; Parameters: "--env-file-if-exists=.env src/launcher.js"; WorkingDir: "{app}"; IconFilename: "{app}\assets\app.ico"
Name: "{autodesktop}\Custom Subtitles"; Filename: "{app}\runtime\node.exe"; Parameters: "--env-file-if-exists=.env src/launcher.js"; WorkingDir: "{app}"; IconFilename: "{app}\assets\app.ico"; Tasks: desktopicon
Name: "{group}\Uninstall Custom Subtitles"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\runtime\node.exe"; Parameters: "--env-file-if-exists=.env src/launcher.js"; WorkingDir: "{app}"; Description: "Start Custom Subtitles"; Flags: nowait postinstall skipifsilent

[Code]
function NeedsTailscale: Boolean;
begin
  Result := not FileExists(ExpandConstant('{pf64}\Tailscale\tailscale.exe'));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
begin
  Result := '';
  ExitCode := 0;
  if NeedsTailscale and WizardIsTaskSelected('tailscale') then
  begin
    ExtractTemporaryFile('tailscale.msi');
    if not ShellExec('runas', ExpandConstant('{sys}\msiexec.exe'), '/i "' + ExpandConstant('{tmp}\tailscale.msi') + '" /passive /norestart', '', SW_SHOWNORMAL, ewWaitUntilTerminated, ExitCode) then
      Result := 'Tailscale installation was not approved. Allow the administrator prompt or deselect the Tailscale task to install the application only.'
    else if (ExitCode <> 0) and (ExitCode <> 3010) then
      Result := 'Tailscale installation failed (exit code ' + IntToStr(ExitCode) + '). Install Tailscale from https://tailscale.com/download/windows and retry.';
    if ExitCode = 3010 then NeedsRestart := True;
  end;
end;
