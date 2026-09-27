; Chattering for Windows: a per-person Setup (design/71). Built by
; scripts/build-installer.js with Inno Setup, which passes:
;   /DVersion=0.1.0 /DArch=x64|arm64 /DPayload=<unpacked download> /DStage=<folder with Chattering.exe and bin\>
;   /DIcon=<chattering.ico> /DOutDir=<dist> /DOutName=Chattering-Setup-x64
;
; It installs where the command-line install does (%LOCALAPPDATA%\Programs\
; Chattering, versions\<v> beside earlier ones), with no administrator
; rights: the Start menu entry, optionally a desktop icon and a start at
; sign-in, the commands chattering-app and chattering on the PATH, and an
; uninstaller in Settings -> Apps. Conversations, settings and notes are
; the person's and stay when Chattering is uninstalled.

#ifndef Version
  #error Pass /DVersion
#endif

[Setup]
AppId={{6B1C7E52-3F0A-4C9E-9D5B-0C8F2A1E7D41}
AppName=Chattering
AppVersion={#Version}
AppVerName=Chattering {#Version}
AppPublisher=Rockfrog
AppPublisherURL=https://rockfrog.ai
AppSupportURL=https://github.com/MaximeRivest/chattering
DefaultDirName={localappdata}\Programs\Chattering
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
UsedUserAreasWarning=no
#if Arch == "arm64"
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#else
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif
MinVersion=10.0.17763
OutputDir={#OutDir}
OutputBaseFilename={#OutName}
SetupIconFile={#Icon}
UninstallDisplayIcon={app}\chattering.ico
UninstallDisplayName=Chattering
WizardStyle=modern
; Two copies of Node (node.exe and Chattering.exe) compress to one with a
; dictionary larger than the file.
Compression=lzma2/max
LZMADictionarySize=262144
SolidCompression=yes
ChangesEnvironment=yes
CloseApplications=no
VersionInfoVersion={#Version}
VersionInfoProductName=Chattering
VersionInfoCompany=Rockfrog
VersionInfoDescription=Chattering Setup

[Tasks]
Name: desktopicon; Description: "Put Chattering on the desktop"; Flags: unchecked
Name: autostart; Description: "Start Chattering when I sign in to Windows"; Flags: unchecked

[Files]
Source: "{#Payload}\*"; DestDir: "{app}\versions\{#Version}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#Stage}\Chattering.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Stage}\bin\*"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "{#Icon}"; DestDir: "{app}"; DestName: "chattering.ico"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\Chattering"; Filename: "{app}\Chattering.exe"; Parameters: """{app}\bin\open.js"""; WorkingDir: "{%USERPROFILE}"; IconFilename: "{app}\chattering.ico"; Comment: "Chattering, by Rockfrog"
Name: "{userdesktop}\Chattering"; Filename: "{app}\Chattering.exe"; Parameters: """{app}\bin\open.js"""; WorkingDir: "{%USERPROFILE}"; IconFilename: "{app}\chattering.ico"; Tasks: desktopicon
Name: "{userstartup}\Chattering"; Filename: "{app}\Chattering.exe"; Parameters: """{app}\bin\open.js"" start"; WorkingDir: "{%USERPROFILE}"; IconFilename: "{app}\chattering.ico"; Tasks: autostart

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}\bin"; Check: NeedsAddPath(ExpandConstant('{app}\bin'))

[Run]
Filename: "{app}\Chattering.exe"; Parameters: """{app}\bin\open.js"""; Description: "Open Chattering"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{app}\bin\chattering-app.cmd"; Parameters: "stop --force"; Flags: runhidden waituntilterminated; RunOnceId: "StopChattering"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\versions"
Type: files; Name: "{app}\current.txt"
Type: files; Name: "{app}\previous.txt"
Type: dirifempty; Name: "{app}\bin"
Type: dirifempty; Name: "{app}"

[Code]
function NeedsAddPath(Dir: string): Boolean;
var Path: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Path) then begin Result := True; exit; end;
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Path) + ';') = 0;
end;

// A Chattering already running is stopped before its files change, but not
// in the middle of someone's work: then Setup says so and changes nothing.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer; Cmd: string;
begin
  Result := '';
  Cmd := ExpandConstant('{app}\bin\chattering-app.cmd');
  if FileExists(Cmd) then begin
    if Exec(ExpandConstant('{cmd}'), '/c ""' + Cmd + '" stop"', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code <> 0) then
      Result := 'Chattering is still working on something. Let it finish (or stop it: chattering-app stop --force), then run this Setup again.';
  end;
end;

// This version becomes the current one; the one it replaces stays, for
// chattering-app rollback.
procedure CurStepChanged(CurStep: TSetupStep);
var Old: AnsiString;
begin
  if CurStep = ssPostInstall then begin
    if LoadStringFromFile(ExpandConstant('{app}\current.txt'), Old) and (Trim(Old) <> '{#Version}') then
      SaveStringToFile(ExpandConstant('{app}\previous.txt'), Trim(Old) + #13#10, False);
    SaveStringToFile(ExpandConstant('{app}\current.txt'), '{#Version}', False);
  end;
end;

// Uninstalling takes the commands off the PATH again.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var Path, Dir: string; P: Integer;
begin
  if CurUninstallStep = usPostUninstall then begin
    Dir := ExpandConstant('{app}\bin');
    if RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Path) then begin
      P := Pos(';' + Uppercase(Dir), Uppercase(Path));
      if P > 0 then begin
        Delete(Path, P, Length(Dir) + 1);
        RegWriteExpandStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Path);
      end;
    end;
  end;
end;
