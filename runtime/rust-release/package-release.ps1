param(
  [Parameter(Mandatory = $true)][string]$BinaryPath,
  [Parameter(Mandatory = $true)][string]$BinaryName,
  [Parameter(Mandatory = $true)][string]$AssetPrefix,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$PlatformId,
  [Parameter(Mandatory = $true)][string]$PlatformTarget,
  [Parameter(Mandatory = $true)][string]$SourceSha,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $BinaryPath -PathType Leaf)) { throw 'release binary missing' }
if (Test-Path -LiteralPath $OutputDirectory) { throw 'output directory already exists' }
if ($SourceSha -cnotmatch '^[0-9a-f]{40}$') { throw 'source SHA invalid' }
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
$outputRoot = [IO.Path]::GetPathRoot($outputPath)
if ($outputPath.Length -gt $outputRoot.Length) {
  $outputPath = $outputPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}
$outputParent = [IO.Path]::GetDirectoryName($outputPath)
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
  New-Item -ItemType Directory -Path $outputParent | Out-Null
}
$staging = Join-Path $outputParent ("$([IO.Path]::GetFileName($outputPath)).tmp.$([guid]::NewGuid().ToString('N'))")
New-Item -ItemType Directory -Path $staging | Out-Null
$archiveName = "$AssetPrefix-$Version-$PlatformId.zip"
try {
  $archivePath = Join-Path $staging $archiveName
  Compress-Archive -LiteralPath $BinaryPath -DestinationPath $archivePath
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
  Set-Content -LiteralPath "$archivePath.sha256" -Value "$hash  $archiveName" -NoNewline
  $manifest = [ordered]@{
    schema_version = '1'
    kind = 'ci-release-build-manifest'
    source_sha = $SourceSha
    version = $Version
    platform_id = $PlatformId
    platform_target = $PlatformTarget
    assets = @(
      [ordered]@{
        path = $archiveName
        sha256 = $hash
        checksum_path = "$archiveName.sha256"
      }
    )
  }
  $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $staging 'asset-manifest.json') -NoNewline
  & (Join-Path $PSScriptRoot 'verify-release-asset.ps1') $BinaryName $AssetPrefix $Version $PlatformId $PlatformTarget $SourceSha $staging
  [IO.Directory]::Move($staging, $outputPath)
} finally {
  if (Test-Path -LiteralPath $staging -PathType Container) {
    [IO.Directory]::Delete($staging, $true)
  }
}
