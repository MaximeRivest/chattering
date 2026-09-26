# Install Chattering on Windows, for the person running this (no
# administrator rights, nothing outside their profile):
#
#   irm https://raw.githubusercontent.com/MaximeRivest/chattering/master/install/install.ps1 | iex
#
# It downloads the release for this PC from GitHub, checks its SHA-256
# against the release's SHA256SUMS, unpacks it beside earlier versions
# (kept: chattering-app rollback), adds the commands chattering-app (start,
# stop, update) and chattering (search your conversations) to your PATH,
# a Start menu entry, and starts Chattering in the browser.
#
#   $env:CHATTERING_VERSION = '0.1.0'   a given release instead of the latest
#   $env:CHATTERING_NO_START = '1'      install without starting
#   $env:CHATTERING_DOWNLOAD_BASE        where the files are (a mirror, or a test)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = if ($env:CHATTERING_REPO) { $env:CHATTERING_REPO } else { 'MaximeRivest/chattering' }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
$version = $env:CHATTERING_VERSION
if (-not $version) {
  $release = Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$repo/releases/latest"
  $version = ($release.tag_name -replace '^v', '')
}
if (-not $version) { throw "Could not find the latest release of $repo." }
$name = "chattering-$version-win-$arch"
$base = if ($env:CHATTERING_DOWNLOAD_BASE) { $env:CHATTERING_DOWNLOAD_BASE } else { "https://github.com/$repo/releases/download/v$version" }
$appHome = Join-Path $env:LOCALAPPDATA 'Programs\Chattering'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("chattering-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  Write-Host "Downloading Chattering $version for Windows ($arch)..."
  Invoke-WebRequest -UseBasicParsing "$base/$name.zip" -OutFile "$tmp\$name.zip"
  Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS" -OutFile "$tmp\SHA256SUMS"
  $want = (Get-Content "$tmp\SHA256SUMS" | Where-Object { ($_ -split '\s+')[1] -eq "$name.zip" } | ForEach-Object { ($_ -split '\s+')[0] })
  $got = (Get-FileHash -Algorithm SHA256 "$tmp\$name.zip").Hash.ToLower()
  if (-not $want -or $want -ne $got) { throw 'The download does not match its checksum; nothing was installed.' }

  New-Item -ItemType Directory -Force -Path "$appHome\versions", "$appHome\bin" | Out-Null
  Expand-Archive -Path "$tmp\$name.zip" -DestinationPath $tmp -Force
  $dest = Join-Path $appHome "versions\$version"
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Move-Item (Join-Path $tmp $name) $dest
  # Downloaded files carry the internet's mark; this program is now installed.
  Get-ChildItem -Recurse $dest | Unblock-File
  if (Test-Path "$appHome\current.txt") { Copy-Item "$appHome\current.txt" "$appHome\previous.txt" -Force }
  Set-Content -NoNewline -Encoding ascii -Path "$appHome\current.txt" -Value $version

  # The commands: they read current.txt, so an update switches them.
  foreach ($pair in @(@('chattering-app', 'launcher.js'), @('chattering', 'chattering'))) {
    $cmd = "@echo off`r`nsetlocal`r`nset /p V=<`"%~dp0..\current.txt`"`r`n`"%~dp0..\versions\%V%\runtime\node\node.exe`" `"%~dp0..\versions\%V%\$($pair[1])`" %*`r`n"
    Set-Content -Encoding ascii -Path "$appHome\bin\$($pair[0]).cmd" -Value $cmd
  }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains "$appHome\bin")) {
    [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ";$appHome\bin").TrimStart(';')), 'User')
    Write-Host "Added $appHome\bin to your PATH (new terminals will see it)."
  }

  # A Start menu entry.
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Chattering.lnk'))
  $lnk.TargetPath = "$appHome\bin\chattering-app.cmd"
  $lnk.WorkingDirectory = $env:USERPROFILE
  $lnk.WindowStyle = 7
  $icon = Join-Path $dest 'icons\chattering.ico'
  if (Test-Path $icon) { $lnk.IconLocation = $icon }
  $lnk.Description = 'Chattering, by Rockfrog'
  $lnk.Save()

  Write-Host "Chattering $version is installed in $appHome."
  if ($env:CHATTERING_NO_START -ne '1') { & "$appHome\bin\chattering-app.cmd" }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
