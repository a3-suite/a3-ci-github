param(
  [Parameter(Mandatory = $true)][string]$BinaryName,
  [Parameter(Mandatory = $true)][string]$AssetPrefix,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$PlatformId,
  [Parameter(Mandatory = $true)][string]$PlatformTarget,
  [Parameter(Mandatory = $true)][string]$SourceSha,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$archiveName = "$AssetPrefix-$Version-$PlatformId.zip"
$archivePath = Join-Path $OutputDirectory $archiveName
$checksumPath = "$archivePath.sha256"
$manifestPath = Join-Path $OutputDirectory 'asset-manifest.json'
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw 'release archive missing' }
if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) { throw 'release checksum missing' }
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'release asset manifest missing' }
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
$checksumRecord = (Get-Content -LiteralPath $checksumPath -Raw).TrimEnd([char[]]"`r`n")
if ($checksumRecord -cne "$actual  $archiveName") { throw 'release checksum binding mismatch' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $archivePath))
try {
  $entries = @($archive.Entries | ForEach-Object { $_.FullName })
  if ($entries.Count -ne 1 -or $entries[0] -ne $BinaryName) { throw 'release archive content mismatch' }
} finally {
  $archive.Dispose()
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$rootFields = @($manifest.PSObject.Properties.Name | Sort-Object)
$expectedRootFields = @('assets', 'kind', 'platform_id', 'platform_target', 'schema_version', 'source_sha', 'version') | Sort-Object
if (Compare-Object $rootFields $expectedRootFields -CaseSensitive) { throw 'release asset manifest fields mismatch' }
foreach ($field in @('kind', 'platform_id', 'platform_target', 'schema_version', 'source_sha', 'version')) {
  if ($manifest.$field -isnot [string]) { throw 'release asset manifest scalar field type mismatch' }
}
if ($manifest.schema_version -cne '1' -or $manifest.kind -cne 'ci-release-build-manifest') { throw 'release asset manifest metadata mismatch' }
if ($manifest.source_sha -cne $SourceSha -or $manifest.version -cne $Version) { throw 'release asset manifest source or version mismatch' }
if ($manifest.platform_id -cne $PlatformId -or $manifest.platform_target -cne $PlatformTarget) { throw 'release asset manifest platform mismatch' }
if (-not ($manifest.assets -is [System.Array])) { throw 'release asset manifest assets must be an array' }
$assets = @($manifest.assets)
if ($assets.Count -ne 1) { throw 'release asset manifest asset count mismatch' }
$assetFields = @($assets[0].PSObject.Properties.Name | Sort-Object)
$expectedAssetFields = @('checksum_path', 'path', 'sha256') | Sort-Object
if (Compare-Object $assetFields $expectedAssetFields -CaseSensitive) { throw 'release asset manifest asset fields mismatch' }
foreach ($field in $expectedAssetFields) {
  if ($assets[0].$field -isnot [string]) { throw 'release asset manifest asset field type mismatch' }
}
if ($assets[0].path -cne $archiveName -or $assets[0].sha256 -cne $actual -or $assets[0].checksum_path -cne "$archiveName.sha256") {
  throw 'release asset manifest binding mismatch'
}
