# hoprig installer for Windows (PowerShell 5.1 or 7).
#
#   irm <address of this file> | iex                                            asks before each change
#   & ([scriptblock]::Create((irm <address of this file>))) --yes               takes every default
#
# What it does, asking first each time:
#   1. Node.js 24.13.1 or newer. When missing it is installed with WinGet (built into Windows 10 1809+ and 11), as the
#      official "Node.js LTS" package (OpenJS.NodeJS.LTS) that nodejs.org lists for Windows. Windows may ask for
#      permission once (the Node.js installer is for all users).
#   2. hoprig itself, with npm: from the repository's main branch by default, or from $env:HOPRIG_SOURCE (a .tgz file, a folder or a
#      git URL). npm's global folder on Windows is in your own profile, so no administrator rights are needed.
#   3. `hoprig setup`, which installs Claude Code (its official Windows installer) and sets up the dashboard.
#      Arguments given to this script go to setup (for example --yes, --access network, --no-service).
#
# Safe to run again: anything already in place is left as it is.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$SetupArgs = @())

$ErrorActionPreference = 'Stop'
$MinNode = '24.13.1' # the same as src/nodefloor.mjs (major.minor.patch)
# Until the package is on npm the default is the repository's main branch as a tarball, which npm installs directly.
# The same address as hoprigSource() in src/paths.mjs, which the update and its version lookup read.
$Source = if ($env:HOPRIG_SOURCE) { $env:HOPRIG_SOURCE } else { 'https://github.com/allswebtech/hoprig/archive/refs/heads/main.tar.gz' }
$Yes = ($env:HOPRIG_YES -eq '1') -or ($SetupArgs -contains '--yes') -or ($SetupArgs -contains '-y')

function Say($text) { Write-Host $text }
function Step($text) { Write-Host ''; Write-Host $text -ForegroundColor Cyan }
function Fail($text) { Write-Host "hoprig installer: $text" -ForegroundColor Red; exit 1 }

function Confirm-Step($question) {
    if ($Yes) { Say "$question yes (--yes)"; return $true }
    $answer = Read-Host "$question [Y/n]"
    return ($answer -eq '' -or $answer -match '^(y|yes)$')
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
}

if ($env:OS -ne 'Windows_NT') { Fail 'this is not Windows: use install.sh on macOS and Linux.' }
if (-not [Environment]::Is64BitOperatingSystem) { Fail 'Claude Code needs 64-bit Windows.' }

# ---- 1. Node.js -----------------------------------------------------------------------------------------------
Step "1. Node.js ($MinNode or newer)"
$found = Get-NodeVersion
if (Test-NodeOk $found) {
    Say "Found Node.js $(& node --version). Nothing to do."
} else {
    if ($null -ne $found) { Say "Found Node.js $found, older than $MinNode (the lowest Hoprig runs on): the newest Node.js LTS goes in its place." } else { Say 'Node.js is not installed.' }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Fail "WinGet is not available here. Install Node.js LTS from https://nodejs.org, then run this installer again."
    }
    $cmd = 'winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements'
    Say "  command: $cmd"
    if (-not (Confirm-Step 'Install Node.js LTS with WinGet?')) { Fail "Node.js $MinNode or newer is needed. Get it from https://nodejs.org." }
    & winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements
    # WinGet exits non-zero when the package is already installed but older; the version check below decides.
    Update-PathFromSystem
    $found = Get-NodeVersion
    if (-not (Test-NodeOk $found)) { Fail "Node.js $MinNode or newer is still not found. Open a new PowerShell window and run this installer again." }
    Say "$([char]0x2713) Node.js $(& node --version)"
}

# ---- 2. hoprig ---------------------------------------------------------------------------------------------
Step '2. hoprig'
if (Test-Path -LiteralPath $Source) { $Source = (Resolve-Path -LiteralPath $Source).Path }
Say "Installing hoprig from $(if ($Source -eq 'hoprig') { 'npm' } else { $Source })."
# npm 12 and newer refuse a package named by an address (a tarball URL, a git address) unless this one command
# allows it; "root" allows only what is named here, never what a dependency points to. An older npm needs nothing,
# and npm 12 refuses a flag it does not know, so the flag is passed only where it is needed.
$npmAllow = @()
$npmMajor = 0
try { $npmMajor = [int]((& npm --version) -split '\.')[0] } catch { $npmMajor = 0 }
if ($npmMajor -ge 12 -and -not (Test-Path -LiteralPath $Source)) {
    if ($Source -match '^(git\+|git://|github:)|\.git$') { $npmAllow = @('--allow-git=root') }
    elseif ($Source -match '^https?://') { $npmAllow = @('--allow-remote=root') }
}
# The terminal module's install script is not run by npm 12 in a global install: `hoprig setup` below builds it.
& npm install -g @npmAllow --no-audit --no-fund $Source
if ($LASTEXITCODE -ne 0) { Fail 'npm could not install hoprig (see above).' }
$prefix = (& npm prefix -g).Trim()
$bin = Join-Path $prefix 'hoprig.cmd'
if (-not (Test-Path -LiteralPath $bin)) {
    $found = Get-Command hoprig -ErrorAction SilentlyContinue
    if (-not $found) { Fail 'hoprig was installed but its command is not found.' }
    $bin = $found.Source
}
Say "$([char]0x2713) hoprig $(& $bin version)"
if (-not (($env:Path -split ';') -contains $prefix)) {
    Say "Note: $prefix is not on PATH in this window; open a new PowerShell window to use the hoprig command."
}

# ---- 3. setup -------------------------------------------------------------------------------------------------
Step '3. hoprig setup'
& $bin setup @SetupArgs
exit $LASTEXITCODE
