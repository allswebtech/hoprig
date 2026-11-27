# hoprig installer for Windows (Windows PowerShell 5.1 or PowerShell 7).
#
#   irm <address of this file> | iex                                            sets this computer up, asks nothing
#   & ([scriptblock]::Create((irm <address of this file>))) --yes               the same, and passes --yes on to setup
#
# What it does, one tick line each, with no question:
#   1. Node.js 24.13.1 or newer. One that is there and new enough is used. Otherwise the official Node.js zip for this
#      processor goes into your own folder (%LOCALAPPDATA%\hoprig\node) after its SHA-256 is checked against nodejs.org's
#      list, and that folder is added to your own PATH: no administrator, no permission box, no winget.
#   2. Git for Windows, only when it is missing (Claude Code needs its Git Bash), with winget. Windows may ask once to
#      allow a change.
#   3. hoprig itself, with npm.cmd (never npm.ps1: Windows' default setting does not let PowerShell run scripts), from
#      the repository's main branch, or from $env:HOPRIG_SOURCE (a .tgz file, a folder or a git URL). The hoprig.ps1 and
#      hop.ps1 files npm writes are taken away again, so typing hoprig runs hoprig.cmd.
#   4. `hoprig setup`: Claude Code (its official installer), the dashboard on this computer only, started by itself when
#      you sign in to Windows, and the browser opened on it, already signed in.
#   5. A Start menu entry Hoprig, which opens it again signed in.
# Arguments given to this script go to setup (for example --yes, --no-service).
#
# It is stopped when the window runs as administrator (the folders it makes would belong to the administrators; set
# HOPRIG_ALLOW_ADMIN=1 for a build machine). It never closes the window: the end stays on the screen. Output of the
# parts that print a lot goes to %LOCALAPPDATA%\hoprig\install.log.
#
# Safe to run again: anything already in place is left as it is.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$SetupArgs = @())

$ErrorActionPreference = 'Stop'
$MinNode = '24.13.1' # the same as src/nodefloor.mjs (major.minor.patch)
# Until the package is on npm the default is the repository's main branch as a tarball, which npm installs directly.
# The same address as hoprigSource() in src/paths.mjs, which the update and its version lookup read.
$Source = if ($env:HOPRIG_SOURCE) { $env:HOPRIG_SOURCE } else { 'https://github.com/allswebtech/hoprig/archive/refs/heads/main.tar.gz' }
$Home_ = Join-Path $env:LOCALAPPDATA 'hoprig'
$Log = Join-Path $Home_ 'install.log'
$NodeDir = Join-Path $Home_ 'node'
$Tick = [string][char]0x2713
$Cross = [string][char]0x2717
$script:NodeUnpacked = $false
$ProgressPreference = 'SilentlyContinue' # Windows PowerShell 5.1 downloads many times slower with its progress bar

function Say($text) { Write-Host $text }
function Tick($text) { Write-Host "$Tick $text" -ForegroundColor Green; Add-Content -LiteralPath $Log -Value "ok: $text" -Encoding UTF8 -ErrorAction SilentlyContinue }
# A program run with its words going to the log. Windows PowerShell 5.1 turns a native program's error output into a
# stopping error while $ErrorActionPreference is Stop: it is Continue for the call only. Returns the exit code.
function Invoke-Logged($exe, $argv) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $exe @argv 2>&1 | Out-File -LiteralPath $Log -Append -Encoding utf8 } finally { $ErrorActionPreference = $old }
    return $LASTEXITCODE
}
function Note($text) { Add-Content -LiteralPath $Log -Value $text -Encoding UTF8 -ErrorAction SilentlyContinue }
# A part that did not install: the part, the reason in one line, the way to try again; then the install stops (Stop-Install
# is caught below, and the window stays open: this script never calls exit).
function Fail($what, $why, $verb = 'did not install') {
    Write-Host "$Cross $what ${verb}: $why" -ForegroundColor Red
    Write-Host ''
    Write-Host 'Paste the same line again to try once more.'
    Write-Host "Details: $Log"
    Note "failed: $what - $why"
    throw 'HOPRIG_STOP'
}

# The version of the node on PATH, or $null when there is none (or it does not start). Compared as a [version], so
# major, minor and patch all count: 24.13.0 is too old, 24.13.1 and 25.0 are not.
function Get-NodeVersion {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $null }
    try { return [version](& node -p "process.versions.node") } catch { return $null }
}
function Test-NodeOk($v) { return ($null -ne $v) -and ($v -ge [version]$MinNode) }

# A program installed a moment ago is on the saved PATH, not yet on this window's.
function Update-PathFromSystem {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
    # Windows puts the all-users folders before your own: an older Node.js installed for everyone would win over the one
    # unpacked into your own folder a moment ago.
    if ($script:NodeUnpacked) { $env:Path = "$NodeDir;$env:Path" }
}

# A folder at the front of your own PATH (saved) and of this window's.
function Add-UserPath($dir) {
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($user -split ';') -contains $dir)) {
        [Environment]::SetEnvironmentVariable('Path', $(if ($user) { "$dir;$user" } else { $dir }), 'User')
    }
    if (-not (($env:Path -split ';') -contains $dir)) { $env:Path = "$dir;$env:Path" }
}

function Test-Admin {
    try {
        $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

# ---- 1. Node.js -----------------------------------------------------------------------------------------------
function Install-NodeZip {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $base = 'https://nodejs.org/dist/latest-v24.x'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt").Content
    $line = ($sums -split "`n" | Where-Object { $_ -match "node-v[0-9.]+-win-$arch\.zip\s*$" } | Select-Object -First 1)
    if (-not $line) { Fail 'Node.js' "no Windows $arch build is listed at nodejs.org" }
    $want = ($line -split '\s+')[0].ToLower()
    $name = ($line -split '\s+')[1].Trim()
    $tmp = Join-Path $Home_ 'tmp'
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $zip = Join-Path $tmp $name
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile $zip
    $got = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $want) { Remove-Item -LiteralPath $zip -Force; Fail 'Node.js' 'the download did not match the checksum nodejs.org lists' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $out = Join-Path $tmp 'node-unpacked'
    if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Recurse -Force }
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $out)
    $inner = Get-ChildItem -LiteralPath $out -Directory | Select-Object -First 1
    if (Test-Path -LiteralPath $NodeDir) { Remove-Item -LiteralPath $NodeDir -Recurse -Force }
    Move-Item -LiteralPath $inner.FullName -Destination $NodeDir
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    # Windows' default setting does not let PowerShell run script files: npm.ps1 and npx.ps1 are not wanted, the .cmd files are.
    foreach ($f in 'npm.ps1', 'npx.ps1') { Remove-Item -LiteralPath (Join-Path $NodeDir $f) -Force -ErrorAction SilentlyContinue }
    $script:NodeUnpacked = $true
    Add-UserPath $NodeDir
    Note "node: $name unpacked into $NodeDir, sha256 $got"
}

# ---- 2. Git ---------------------------------------------------------------------------------------------------
function Install-Git {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Fail 'Git' 'Windows has no winget here. Install Git for Windows from https://git-scm.com, then paste the line again' }
    Say 'Windows asks to allow a change: click Yes.'
    $common = @('install', '--id', 'Git.Git', '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements')
    # For you only first (no permission box where the package allows it); for everyone when it does not.
    if ((Invoke-Logged 'winget' ($common + @('--scope', 'user'))) -ne 0) { [void](Invoke-Logged 'winget' $common) }
    Update-PathFromSystem
    foreach ($d in (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd'), (Join-Path $env:ProgramFiles 'Git\cmd')) {
        if ((Test-Path -LiteralPath $d) -and -not (($env:Path -split ';') -contains $d)) { $env:Path = "$env:Path;$d" }
    }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'Git' 'it is still not found after winget ran' }
}

function Install-Hoprig {
    if ($env:OS -ne 'Windows_NT') { Say 'This is not Windows: use install.sh on macOS and Linux.'; return }
    if (-not [Environment]::Is64BitOperatingSystem) { Say 'Claude Code needs 64-bit Windows.'; return }
    # An administrator window: the folders made now would belong to the Administrators group. Nothing is installed.
    if ((Test-Admin) -and $env:HOPRIG_ALLOW_ADMIN -ne '1') {
        Write-Host 'Close this window, open PowerShell the normal way (not as administrator) and paste the line again.' -ForegroundColor Red
        return
    }
    New-Item -ItemType Directory -Force -Path $Home_ | Out-Null
    Note "installer started $(Get-Date -Format s)"
    Say 'Hoprig: setting up this computer. It takes a few minutes.'

    $found = Get-NodeVersion
    if (-not (Test-NodeOk $found)) {
        Install-NodeZip
        $found = Get-NodeVersion
        if (-not (Test-NodeOk $found)) { Fail 'Node.js' "version $MinNode or newer is still not found after it was unpacked" }
    }
    Tick 'Node.js'

    # The Git of the person is used where it is there; Claude Code on Windows needs it before it can run.
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Install-Git }
    Tick 'Git'

    if (Test-Path -LiteralPath $Source) { $Source = (Resolve-Path -LiteralPath $Source).Path }
    # npm 12 and newer refuse a package named by an address (a tarball URL, a git address) unless this one command
    # allows it; "root" allows only what is named here, never what a dependency points to. An older npm needs nothing,
    # and npm 12 refuses a flag it does not know, so the flag is passed only where it is needed.
    $npmAllow = @()
    $npmMajor = 0
    try { $npmMajor = [int]((& npm.cmd --version) -split '\.')[0] } catch { $npmMajor = 0 }
    if ($npmMajor -ge 12 -and -not (Test-Path -LiteralPath $Source)) {
        if ($Source -match '^(git\+|git://|github:)|\.git$') { $npmAllow = @('--allow-git=root') }
        elseif ($Source -match '^https?://') { $npmAllow = @('--allow-remote=root') }
    }
    # The terminal module's install script is not run by npm 12 in a global install: `hoprig setup` below builds it.
    # With the Node.js unpacked into your own folder, hoprig goes beside it: its hoprig.cmd then starts that node.exe,
    # whatever older Node.js comes first on the PATH.
    $npmPrefix = @(); if ($script:NodeUnpacked) { $npmPrefix = @('--prefix', $NodeDir) }
    if ((Invoke-Logged 'npm.cmd' (@('install', '-g') + $npmPrefix + $npmAllow + @('--no-audit', '--no-fund', $Source))) -ne 0) { Fail 'Hoprig' 'npm could not install it' }
    $prefix = if ($script:NodeUnpacked) { $NodeDir } else { (& npm.cmd prefix -g).Trim() }
    Note "hoprig installed under $prefix with $((Get-Command npm.cmd).Source)"
    # npm writes hoprig.ps1 and hop.ps1 beside the .cmd files; PowerShell takes a .ps1 before a .cmd and Windows'
    # default setting then refuses it. Taken away, typing hoprig runs hoprig.cmd.
    foreach ($f in 'hoprig.ps1', 'hop.ps1') { Remove-Item -LiteralPath (Join-Path $prefix $f) -Force -ErrorAction SilentlyContinue }
    Add-UserPath $prefix
    $bin = Join-Path $prefix 'hoprig.cmd'
    if (-not (Test-Path -LiteralPath $bin)) { Fail 'Hoprig' 'it was installed but its command is not found' }
    Tick 'Hoprig'

    # Claude Code, the dashboard, its start at sign-in and the browser: setup (a first run asks nothing and prints a tick each).
    & $bin setup @SetupArgs
    if ($LASTEXITCODE -ne 0) { Fail 'Hoprig set-up' 'a part of it did not finish (its lines above say which)' 'did not finish' }
    New-StartMenuEntry $bin
}

# The Start menu entry Hoprig: it signs in and opens the page, so nobody has to remember an address or a password.
function New-StartMenuEntry($bin) {
    try {
        $dir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut((Join-Path $dir 'Hoprig.lnk'))
        $lnk.TargetPath = (Get-Command powershell.exe).Source
        $lnk.Arguments = "-NoProfile -WindowStyle Hidden -Command `"& '$bin' link --open`""
        $lnk.Description = 'Open Hoprig in your browser'
        $lnk.Save()
        Note "start menu entry: $dir\Hoprig.lnk"
    } catch { Note "start menu entry not made: $($_.Exception.Message)" }
}

try {
    Install-Hoprig
} catch {
    if ($_.Exception.Message -ne 'HOPRIG_STOP') {
        Write-Host "$Cross Hoprig did not install: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host ''
        Write-Host 'Paste the same line again to try once more.'
        Write-Host "Details: $Log"
        Note "error: $($_.Exception.Message)"
    }
}
