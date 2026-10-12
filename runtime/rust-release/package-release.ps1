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
. (Join-Path $PSScriptRoot '../diagnostics/failure.ps1')
$ciStage = 'input-validation'
$ciLastConfirmed = 'not-started'
$ciWriteState = 'not-started'
try {
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
  $ciLastConfirmed = $ciStage
  $ciStage = 'output-create'
  $ciWriteState = 'output-may-be-partial'
  New-Item -ItemType Directory -Path $staging | Out-Null
  $archiveName = "$AssetPrefix-$Version-$PlatformId.zip"
  try {
    $archivePath = Join-Path $staging $archiveName
    $ciStage = 'archive-create'
    Compress-Archive -LiteralPath $BinaryPath -DestinationPath $archivePath
    $ciLastConfirmed = $ciStage
    $ciStage = 'checksum-manifest-write'
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$archivePath.sha256", "$hash  $archiveName`n", [Text.UTF8Encoding]::new($false))
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
    $ciLastConfirmed = $ciStage
    $ciStage = 'asset-verification'
    & (Join-Path $PSScriptRoot 'verify-release-asset.ps1') $BinaryName $AssetPrefix $Version $PlatformId $PlatformTarget $SourceSha $staging
    $ciLastConfirmed = $ciStage
    $ciStage = 'output-publish'
    [IO.Directory]::Move($staging, $outputPath)
  } finally {
    if (Test-Path -LiteralPath $staging -PathType Container) {
      try {
        [IO.Directory]::Delete($staging, $true)
        $ciWriteState = 'owned-staging-removed'
      } catch {
        $ciWriteState = 'staging-cleanup-incomplete'
        Write-CiFailureEvidence -Subject 'ci-rust-release-build' -Operation 'package' -Stage 'cleanup' -LastConfirmed $ciLastConfirmed -WriteState $ciWriteState
      }
    }
  }
} catch {
  Write-CiFailureEvidence -Subject 'ci-rust-release-build' -Operation 'package' -Stage $ciStage -LastConfirmed $ciLastConfirmed -WriteState $ciWriteState -NativeExit $LASTEXITCODE
  throw "$ciStage-failed"
}
