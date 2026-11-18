param(
    [Parameter(Mandatory=$true)][string]$Version,
    [string]$Archive
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'An exact DSH version is required' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Set-Location -LiteralPath $root
function Invoke-Checked([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
}
Invoke-Checked 'node' @('scripts/ci/dsh-release.mjs', '--check', $Version)
$out = Join-Path $root ".cache/compatibility/$Version"
New-Item -ItemType Directory -Path $out -Force | Out-Null
if ($Archive) {
    $source = (Resolve-Path -LiteralPath $Archive).Path
    if ([IO.Path]::GetExtension($source) -ne '.tgz') { throw 'Expected a packed plugin tarball' }
    $archivePath = Join-Path $out ([IO.Path]::GetFileName($source))
    if ($source -ne $archivePath) { Copy-Item -LiteralPath $source -Destination $archivePath }
    @{filename=[IO.Path]::GetFileName($source);sha256=(Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash;reused=$true} |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'pack.json') -Encoding utf8
} else {
    Invoke-Checked 'npm.cmd' @('run', 'build')
    $packed = & npm.cmd pack --offline --ignore-scripts --json --pack-destination $out
    if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }
    $packed | Set-Content -LiteralPath (Join-Path $out 'pack.json') -Encoding utf8
    $pack = ($packed | ConvertFrom-Json)[0]
    $archivePath = Join-Path $out $pack.filename
}
$manifest = Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json
$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
$install = Join-Path $out "install-$($archiveHash.Substring(0,16))"
New-Item -ItemType Directory -Path $install -Force | Out-Null
$dependencies = [ordered]@{}
# Actual official boot/Loader and host services, pinned to the selected release.
$services = @('dsh-app-boot','dsh-system-prompt','dsh-tools','dsh-typert-registry','dsh-llm','dsh-session','dsh-credentials','dsh-home-paths','dsh-typert-protocol','dsh-session-projection','dsh-agent','dsh-agent-preset-registry')
foreach ($name in $services) { $dependencies["@deepseek-ai/$name"] = $Version }
foreach ($peer in $manifest.peerDependencies.PSObject.Properties) {
    if ($peer.Name -eq '@deepseek-ai/dsh' -or $peer.Name.StartsWith('@deepseek-ai/dsh-')) { $dependencies[$peer.Name] = $Version }
}
$dependencies[$manifest.name] = "file:$($archivePath.Replace('\','/'))"
@{name='isolated-mail-compatibility';version='1.0.0';private=$true;type='module';dependencies=$dependencies} |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $install 'package.json') -Encoding utf8
# Normal peer resolution: no force, legacy-peer-deps, or compatibility exemptions.
Invoke-Checked 'npm.cmd' @('install','--prefix',$install,'--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org')
$env:DSH_SDK_MODULES = Join-Path $install 'node_modules'
$env:DSH_SMOKE_PACKAGE = Join-Path $env:DSH_SDK_MODULES $manifest.name
$env:DSH_SMOKE_ARCHIVE = $archivePath
$env:DSH_SMOKE_OUT = $out
$env:DSH_EXPECTED_VERSION = $Version
$env:DSH_PLUGIN_REVISION = (& git rev-parse HEAD)
$env:DSH_PLUGIN_DIRTY = if (& git status --porcelain) { 'true' } else { 'false' }
$env:DSH_KERNEL_NETWORK_LOG = Join-Path $out 'network.jsonl'
Set-Content -LiteralPath $env:DSH_KERNEL_NETWORK_LOG -Value '' -NoNewline
Invoke-Checked 'node' @('--import','./scripts/use-dsh-sdk.mjs','--import','./tests/helpers/offline.mjs','scripts/ci/packed-smoke.mjs')
