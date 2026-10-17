# SPDX-License-Identifier: GPL-3.0-or-later
# The Windows installer (PR-REL-01): stages the app with its Node runtime and native modules for one architecture,
# then builds an unsigned .msi with WiX Toolset v5 (`dotnet tool install --global wix --version 5.0.2`) and writes
# its SHA-256 beside it. Run from contract-review after `npm ci` and `npm run build`:
#   pwsh scripts/release/build-win-msi.ps1 [-Arch x64]
param([string]$Arch = 'x64')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$work = Join-Path $root 'release\win-work'
$stage = Join-Path $work 'stage'
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
node (Join-Path $root 'scripts\release\stage.mjs') --platform win32 --arch $Arch --out $stage
if ($LASTEXITCODE) { throw 'Staging failed.' }
$name = "GinChugger-$version-windows-$Arch.msi"
$out = Join-Path $root "release\$name"
wix build -arch $Arch -d "Version=$version" -d "StageDir=$stage" -o $out (Join-Path $PSScriptRoot 'windows\ginchugger.wxs')
if ($LASTEXITCODE) { throw 'wix build failed.' }
$hash = (Get-FileHash $out -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$out.sha256", "$hash  $name`n")
Remove-Item -Recurse -Force $work
Write-Output "$out"
Write-Output ("{0:N1} MB, sha256 {1} (unsigned)" -f ((Get-Item $out).Length / 1MB), $hash)
