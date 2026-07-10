#Requires -Version 5.1
param(
    [Parameter(Position = 0)]
    [ValidateSet('major', 'minor', 'patch')]
    [string]$BumpType = 'patch'
)

$ErrorActionPreference = 'Stop'

function Get-VSCodeCli {
    foreach ($candidate in @('code', 'code.cmd', 'code-insiders', 'code-insiders.cmd')) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }

    return $null
}

$rootDir = Resolve-Path (Join-Path $PSScriptRoot '..')
$pkgJsonPath = Join-Path $rootDir 'package.json'

if (-not (Test-Path $pkgJsonPath)) {
    Write-Error "package.json not found at $pkgJsonPath"
    exit 1
}

$pkg = Get-Content -Path $pkgJsonPath -Raw | ConvertFrom-Json
$oldVersion = [string]$pkg.version

if ($oldVersion -notmatch '^\d+\.\d+\.\d+$') {
    Write-Error "unsupported version format '$oldVersion' (expected major.minor.patch)"
    exit 1
}

$versionParts = $oldVersion.Split('.')
$major = [int]$versionParts[0]
$minor = [int]$versionParts[1]
$patch = [int]$versionParts[2]

switch ($BumpType) {
    'major' { $major += 1; $minor = 0; $patch = 0 }
    'minor' { $minor += 1; $patch = 0 }
    'patch' { $patch += 1 }
}

$newVersion = "$major.$minor.$patch"
$pkg.version = $newVersion
$json = ($pkg | ConvertTo-Json -Depth 100) + [Environment]::NewLine
[System.IO.File]::WriteAllText($pkgJsonPath, $json, [System.Text.UTF8Encoding]::new($false))

$publisher = [string]$pkg.publisher
$name = [string]$pkg.name
$extensionId = "$publisher.$name"
$vsixFile = Join-Path $rootDir "$name-$newVersion.vsix"
$vsceBinary = $null
$possibleVscePaths = @(
    (Join-Path $rootDir 'node_modules/.bin/vsce.cmd'),
    (Join-Path $rootDir 'node_modules/.bin/vsce'),
    (Join-Path $rootDir 'node_modules/@vscode/vsce/vsce')
)

foreach ($candidate in $possibleVscePaths) {
    if (Test-Path $candidate) {
        $vsceBinary = $candidate
        break
    }
}

Write-Host "Bumping version: $oldVersion -> $newVersion"

Remove-Item (Join-Path $rootDir "$name-*.vsix") -Force -ErrorAction SilentlyContinue

if (-not (Test-Path $vsceBinary)) {
    Write-Host 'Installing npm dependencies for packaging...'
    Push-Location $rootDir
    try {
        & npm install
    }
    finally {
        Pop-Location
    }
}

Write-Host 'Packaging extension...'
Push-Location $rootDir
try {
    if ($vsceBinary) {
        & $vsceBinary package
    }
    else {
        & npx vsce package
    }
}
finally {
    Pop-Location
}

if (-not (Test-Path $vsixFile)) {
    Write-Error "expected package $vsixFile was not created"
    exit 1
}

$codeCli = Get-VSCodeCli
if (-not $codeCli) {
    Write-Error "VS Code CLI 'code' was not found in PATH"
    exit 1
}

Write-Host "Uninstalling existing extension ($extensionId) if present..."
try {
    & $codeCli --uninstall-extension $extensionId 2>$null | Out-Null
}
catch {
    # Ignore if the extension is not installed yet.
}

Write-Host "Installing $vsixFile..."
& $codeCli --install-extension $vsixFile

Write-Host "Done: $extensionId bumped $oldVersion -> $newVersion and reinstalled."
