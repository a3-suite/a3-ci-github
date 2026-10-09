#Requires -Version 5.1
[CmdletBinding()]
param(
  [ValidateSet('install', 'upgrade', 'repair', 'dry-run')][string]$Mode = 'install',
  [ValidateSet('online', 'offline')][string]$Source = 'online',
  [string]$Manifest,
  [string]$Artifact,
  [switch]$SmokeHelp,
  [switch]$Json,
  [switch]$Help,
  [switch]$Version
)

# __INSTALLER_RUNTIME_VALUES__
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Select defaults through environment variables when the script is executed
# through `irm ... | iex`, where command-line parameters are unavailable.
if (-not $PSBoundParameters.ContainsKey('Mode') -and $env:INSTALLER_MODE) {
  $Mode = $env:INSTALLER_MODE
}
if (-not $PSBoundParameters.ContainsKey('Source') -and $env:INSTALLER_SOURCE) {
  $Source = $env:INSTALLER_SOURCE
}
if (-not $PSBoundParameters.ContainsKey('Manifest') -and $env:INSTALLER_MANIFEST) {
  $Manifest = $env:INSTALLER_MANIFEST
}
if (-not $PSBoundParameters.ContainsKey('Artifact') -and $env:INSTALLER_ARTIFACT) {
  $Artifact = $env:INSTALLER_ARTIFACT
}
if (-not $PSBoundParameters.ContainsKey('SmokeHelp') -and $env:INSTALLER_SMOKE_HELP -eq '1') {
  $SmokeHelp = $true
}
if (-not $PSBoundParameters.ContainsKey('Json') -and $env:INSTALLER_JSON -eq '1') {
  $Json = $true
}
if ($Mode -notin @('install', 'upgrade', 'repair', 'dry-run')) {
  throw 'invalid operation mode'
}
if ($Source -notin @('online', 'offline')) {
  throw 'invalid source mode'
}
$installerVersion = '2'
if ($Help) {
  'usage: install.ps1 [-Mode install|upgrade|repair|dry-run] [-Source online|offline] [-Manifest PATH -Artifact PATH] [-SmokeHelp] [-Json]'
  exit 0
}
if ($Version) { $installerVersion; exit 0 }
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw 'Windows is required'
}
if ($MANIFEST_SHA256 -notmatch '^[0-9a-fA-F]{64}$' -or -not $MANIFEST_URL.StartsWith('https://github.com/', [StringComparison]::Ordinal)) {
  throw 'invalid fixed manifest source'
}
if ($SOURCE_KIND -ne 'github-release' -or -not $ARTIFACT_URL.StartsWith('https://', [StringComparison]::Ordinal)) {
  throw 'unsupported fixed source'
}
if ($ACTIVATION_STRATEGY -ne 'active-pointer' -or $TARGET_PLATFORM -ne 'windows-x86_64') {
  throw 'unsupported activation strategy or target platform'
}
if ($ARTIFACT_CHECKSUM -notmatch '^sha256:[0-9a-fA-F]{64}$') { throw 'invalid artifact checksum' }
$expectedArtifact = $ARTIFACT_CHECKSUM.Substring(7).ToUpperInvariant()
$MANAGED_ROOT = [Environment]::ExpandEnvironmentVariables($MANAGED_ROOT)
$RELEASE_PATH = [Environment]::ExpandEnvironmentVariables($RELEASE_PATH)
$CURRENT_POINTER = [Environment]::ExpandEnvironmentVariables($CURRENT_POINTER)
$LOCK_PATH = [Environment]::ExpandEnvironmentVariables($LOCK_PATH)
$INSTALL_STATE_PATH = [Environment]::ExpandEnvironmentVariables($INSTALL_STATE_PATH)
$LAUNCHER_PATH = [Environment]::ExpandEnvironmentVariables($LAUNCHER_PATH)
if ($PROFILE -notin @('per-user-cli', 'system-wide')) { throw 'unsupported placement profile' }
function Test-AbsolutePath([string]$Path) {
  # IsPathRooted alone also accepts drive-relative and current-drive paths.
  return $Path -match '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))'
}
function Assert-ManagedRootBreadth([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd([char]'\')
  $parts = $full.Split([char]'\', [StringSplitOptions]::RemoveEmptyEntries)
  if ($parts.Count -lt 3) { throw 'managed root is too broad' }
  if ($parts[1] -ieq 'Windows') { throw 'managed root is too broad' }
  if ($parts[1] -ieq 'Users' -and $parts.Count -eq 3) { throw 'managed root is too broad' }
}
foreach ($path in @($MANAGED_ROOT, $RELEASE_PATH, $CURRENT_POINTER, $LOCK_PATH, $INSTALL_STATE_PATH)) {
  if (-not (Test-AbsolutePath $path)) { throw 'placement paths must be absolute' }
}
$root = [IO.Path]::GetFullPath($MANAGED_ROOT)
if ($root -eq [IO.Path]::GetPathRoot($root)) { throw 'invalid managed root' }
$rootPrefix = $root.TrimEnd('\') + '\'
$release = [IO.Path]::GetFullPath($RELEASE_PATH)
$pointer = [IO.Path]::GetFullPath($CURRENT_POINTER)
$lock = [IO.Path]::GetFullPath($LOCK_PATH)
$state = [IO.Path]::GetFullPath($INSTALL_STATE_PATH)
foreach ($path in @($release, $pointer, $lock, $state)) {
  if (-not $path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'path escapes managed root' }
}
Assert-ManagedRootBreadth $MANAGED_ROOT
$launcher = $null
if ($LAUNCHER_PATH) {
  if (-not (Test-AbsolutePath $LAUNCHER_PATH)) {
    throw 'launcher path must be absolute'
  }
  foreach ($segment in ($LAUNCHER_PATH -split '[\\/]')) {
    if ($segment -eq '' -or $segment -eq '.' -or $segment -eq '..') {
      throw 'launcher path must not contain empty or relative components'
    }
  }
  $launcher = [IO.Path]::GetFullPath($LAUNCHER_PATH)
  if ($PROFILE -eq 'per-user-cli') {
    $launcherBase = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs')).TrimEnd('\') + '\'
  }
  else {
    $launcherBase = [IO.Path]::GetFullPath($env:ProgramFiles).TrimEnd('\') + '\'
  }
  if (-not $launcher.StartsWith($launcherBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'launcher path is outside the allowed base'
  }
  if ($launcher.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'launcher path must be outside the managed root'
  }
}
if ($Source -eq 'offline') {
  if (-not $Manifest) { throw 'offline manifest is required' }
  $manifestItem = Get-Item -LiteralPath $Manifest -Force
  if ($manifestItem.PSIsContainer -or ($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'offline manifest must be a regular file'
  }
  if (-not $Artifact) { throw 'offline artifact is required' }
  $artifactItem = Get-Item -LiteralPath $Artifact -Force
  if ($artifactItem.PSIsContainer -or ($artifactItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'offline artifact must be a regular file'
  }
}
elseif ($Manifest -or $Artifact) { throw 'online mode forbids local inputs' }

$work = Join-Path ([IO.Path]::GetTempPath()) ('installer-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($work) | Out-Null
$runtimeLock = $lock
$lockOwned = $false
$lockHandle = $null
$switched = $false
$releasePlaced = $false
$committed = $false
$oldPointer = $null
$launcherSet = $false
$launcherExisted = $false
$oldLauncherBytes = $null
$oldState = $null
$oldRelease = $null
$nextState = $null
$nextPointer = $null
$nextLauncher = $null
$managedStage = $null
$previousRelease = ''
$exitCode = 0
$result = $null
$createdDirs = New-Object System.Collections.Generic.List[string]
function Ensure-Directory([string]$Path) {
  $missing = New-Object System.Collections.Generic.List[string]
  $current = $Path.TrimEnd('\')
  while ($current -and -not (Test-Path -LiteralPath $current)) {
    $missing.Add($current)
    $parent = [IO.Path]::GetDirectoryName($current)
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
  for ($index = $missing.Count - 1; $index -ge 0; $index--) {
    $entry = $missing[$index]
    $probe = Join-Path ([IO.Path]::GetDirectoryName($entry)) ('.installer-mkdir-' + [Guid]::NewGuid().ToString('N'))
    try {
      [IO.Directory]::CreateDirectory($probe) | Out-Null
      # Moveは宛先が既存だと失敗するため、成功だけを自身の新規作成として所有記録する。
      [IO.Directory]::Move($probe, $entry)
      $script:createdDirs.Add($entry)
    }
    catch {
      if (Test-Path -LiteralPath $probe) { [IO.Directory]::Delete($probe, $true) }
      if (-not (Test-Path -LiteralPath $entry)) { throw }
      # 他プロセスが先に作成したディレクトリは所有記録に含めない。
    }
  }
}
function Expand-Artifact([string]$ArchivePath, [string]$Destination) {
  # Use the Unicode-aware API for Windows paths, after archive entry validation.
  [IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $Destination)
}
function Invoke-CleanupStep([string]$Label, [scriptblock]$Action) {
  try { & $Action }
  catch {
    [Console]::Error.WriteLine("rollback failed ($Label): $($_.Exception.Message)")
    $script:exitCode = 2
  }
}
function Assert-NoReparsePointPath([string]$Path) {
  $current = [IO.Path]::GetPathRoot($Path)
  $relative = $Path.Substring($current.Length)
  foreach ($part in $relative.Split([char]'\', [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = Join-Path $current $part
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "path contains a reparse point: $current"
    }
  }
}
try {
  foreach ($path in @($root, $release, $pointer, $runtimeLock, $state)) {
    Assert-NoReparsePointPath $path
  }
  if ($launcher) { Assert-NoReparsePointPath $launcher }
  if ($Mode -ne 'dry-run') {
    Ensure-Directory $root
    Ensure-Directory ([IO.Path]::GetDirectoryName($runtimeLock))
    try {
      $lockHandle = [IO.File]::Open($runtimeLock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    }
    catch {
      throw 'another installation owns the runtime lock'
    }
    $lockOwned = $true
  }
  $pointerItem = Get-Item -LiteralPath $pointer -Force -ErrorAction SilentlyContinue
  if ($pointerItem) {
    if ($pointerItem.PSIsContainer -or ($pointerItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'current pointer must be a regular file'
    }
    $oldPointer = [IO.File]::ReadAllText($pointer)
  }
  if ($launcher -and (Test-Path -LiteralPath $launcher)) {
    $launcherItem = Get-Item -LiteralPath $launcher -Force
    if ($launcherItem.PSIsContainer) { throw 'launcher path must be a file' }
    $oldLauncherBytes = [IO.File]::ReadAllBytes($launcher)
    $launcherExisted = $true
  }
  $manifestPath = Join-Path $work 'manifest.json'
  if ($Source -eq 'online') {
    Invoke-WebRequest -UseBasicParsing -Uri $MANIFEST_URL -OutFile $manifestPath -MaximumRedirection 5 | Out-Null
  }
  else { [IO.File]::Copy($Manifest, $manifestPath) }
  $actualManifest = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
  if ($actualManifest -ne $MANIFEST_SHA256.ToUpperInvariant()) { throw 'manifest checksum mismatch' }
  $artifactPath = Join-Path $work 'artifact.zip'
  if ($Source -eq 'online') {
    Invoke-WebRequest -UseBasicParsing -Uri $ARTIFACT_URL -OutFile $artifactPath -MaximumRedirection 5 | Out-Null
  }
  else { [IO.File]::Copy($Artifact, $artifactPath) }
  if ((Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash -ne $expectedArtifact) {
    throw 'artifact checksum mismatch'
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($artifactPath)
  try {
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName.Replace('\', '/')
      if ($name.StartsWith('/') -or $name -match '(^|/)\.\.(/|$)' -or $name -match '^[A-Za-z]:') {
        throw 'unsafe archive path'
      }
      $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
      if ($unixType -ne 0 -and $unixType -ne 0x8000 -and $unixType -ne 0x4000) {
        throw 'non-regular archive entry'
      }
    }
  }
  finally { $archive.Dispose() }
  $stage = Join-Path $work 'stage'
  Expand-Artifact $artifactPath $stage
  $binaries = @(Get-ChildItem -LiteralPath $stage -Recurse -File)
  if ($binaries.Count -ne 1 -or ($binaries[0].Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'expected exactly one binary'
  }
  $binary = $binaries[0]
  $binaryChecksum = (Get-FileHash -LiteralPath $binary.FullName -Algorithm SHA256).Hash
  $relativeBinary = $binary.FullName.Substring($stage.Length + 1)
  if ($SmokeHelp) {
    & $binary.FullName --help *> (Join-Path $work 'smoke.out')
    if ($LASTEXITCODE -ne 0) { throw 'binary smoke check failed' }
  }
  if (Test-Path -LiteralPath $state) {
    $stateItem = Get-Item -LiteralPath $state -Force
    if ($stateItem.PSIsContainer -or ($stateItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'invalid install state'
    }
    $oldState = [IO.File]::ReadAllBytes($state)
    $currentState = @{}
    foreach ($line in [IO.File]::ReadAllLines($state)) {
      $parts = $line.Split('=', 2)
      if ($parts.Count -eq 2) { $currentState[$parts[0]] = $parts[1] }
    }
    if ($currentState['manifestChecksum'] -notmatch '^[0-9A-Fa-f]{64}$' -or
        $currentState['artifactChecksum'] -notmatch '^[0-9A-Fa-f]{64}$' -or
        $currentState['binaryChecksum'] -notmatch '^[0-9A-Fa-f]{64}$' -or
        -not $currentState['releaseVersion']) { throw 'invalid install state content' }
    $previousRelease = $currentState['releaseVersion']
    if ($previousRelease -eq $RELEASE_VERSION -and (
        $currentState['manifestChecksum'] -ne $actualManifest -or
        $currentState['artifactChecksum'] -ne $expectedArtifact -or
        $currentState['binaryChecksum'] -ne $binaryChecksum)) {
      throw 'same release version with different checksums is rejected'
    }
    $installedBinary = Join-Path $release $relativeBinary
    $launcherOk = $true
    if ($launcher) {
      if ($currentState['launcherPath'] -ne $launcher) { $launcherOk = $false }
      elseif (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { $launcherOk = $false }
      elseif ((Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash -ne $currentState['binaryChecksum']) { $launcherOk = $false }
    }
    elseif ($currentState['launcherPath']) { $launcherOk = $false }
    if ($launcherExisted -and -not $launcherOk) {
      throw 'launcher path already exists and is not installer-managed'
    }
    if ($currentState['manifestChecksum'] -eq $actualManifest -and
        $currentState['artifactChecksum'] -eq $expectedArtifact -and
        $currentState['binaryChecksum'] -eq $binaryChecksum -and
        $currentState['releaseVersion'] -eq $RELEASE_VERSION -and
        $oldPointer -eq $release -and (Test-Path -LiteralPath $installedBinary -PathType Leaf) -and
        (Get-FileHash -LiteralPath $installedBinary -Algorithm SHA256).Hash -eq $binaryChecksum -and
        $launcherOk) {
      $committed = $true
      if ($Mode -eq 'dry-run') { $result = 'dry-run' }
      else { $result = 'unchanged' }
    }
    if (-not $committed) {
      if ($Mode -eq 'install') { throw 'install state exists; use upgrade or repair' }
      if ($Mode -eq 'repair' -and (
          $oldPointer -ne $release -or
          $previousRelease -ne $RELEASE_VERSION -or
          $currentState['manifestChecksum'] -ne $actualManifest -or
          $currentState['artifactChecksum'] -ne $expectedArtifact)) {
        throw 'repair requires the current release and matching checksums'
      }
    }
  }
  else {
    if ($null -ne $oldPointer) { throw 'current pointer exists without install state' }
    if ($launcherExisted) { throw 'launcher path already exists and is not installer-managed' }
    if ($Mode -eq 'upgrade') { throw 'upgrade requires install state' }
    if ($Mode -eq 'repair') { throw 'repair requires install state' }
  }
  if ($Mode -eq 'dry-run') {
    $committed = $true
    $result = 'dry-run'
  }
  if (-not $committed) {
    if (Test-Path -LiteralPath $release) {
      if ($Mode -ne 'repair' -or ($oldPointer -and $oldPointer -ne $release)) { throw 'release path already exists' }
      $oldRelease = Join-Path $root ('.previous-release-' + [Guid]::NewGuid().ToString('N'))
    }
    Ensure-Directory ([IO.Path]::GetDirectoryName($state))
    Ensure-Directory ([IO.Path]::GetDirectoryName($release))
    Ensure-Directory ([IO.Path]::GetDirectoryName($pointer))
    $managedStage = Join-Path $root ('.staging-' + [Guid]::NewGuid().ToString('N'))
    Expand-Artifact $artifactPath $managedStage
    $managedBinary = Join-Path $managedStage $relativeBinary
    if ((Get-FileHash -LiteralPath $managedBinary -Algorithm SHA256).Hash -ne $binaryChecksum) {
      throw 'staged binary checksum mismatch'
    }
    if ($oldRelease) { [IO.Directory]::Move($release, $oldRelease) }
    [IO.Directory]::Move($managedStage, $release)
    $managedStage = $null
    $releasePlaced = $true
    if ($launcher) { Assert-NoReparsePointPath $launcher }
    $nextPointer = Join-Path ([IO.Path]::GetDirectoryName($pointer)) ('.current-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($nextPointer, $release, [Text.UTF8Encoding]::new($false))
    if ($null -ne $oldPointer) { [IO.File]::Replace($nextPointer, $pointer, [NullString]::Value) }
    else { [IO.File]::Move($nextPointer, $pointer) }
    $switched = $true
    if ($launcher) {
      Assert-NoReparsePointPath $launcher
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($launcher)) | Out-Null
      Assert-NoReparsePointPath $launcher
      $nextLauncher = Join-Path ([IO.Path]::GetDirectoryName($launcher)) ('.launcher-' + [Guid]::NewGuid().ToString('N') + '.tmp')
      [IO.File]::Copy((Join-Path $release $relativeBinary), $nextLauncher, $true)
      $launcherSet = $true
      if ($launcherExisted) { [IO.File]::Replace($nextLauncher, $launcher, [NullString]::Value) }
      else { [IO.File]::Move($nextLauncher, $launcher) }
    }
    $nextState = Join-Path ([IO.Path]::GetDirectoryName($state)) ('.install-state-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $lines = @(
      "releaseVersion=$RELEASE_VERSION",
      "artifactChecksum=$expectedArtifact",
      "binaryChecksum=$binaryChecksum",
      "manifestChecksum=$actualManifest",
      "sourceCommit=$SOURCE_COMMIT",
      "ciRunId=$CI_RUN_ID",
      "installerVersion=$installerVersion",
      "installedAt=$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))",
      "previousRelease=$previousRelease",
      "launcherPath=$LAUNCHER_PATH"
    )
    [IO.File]::WriteAllLines($nextState, $lines, [Text.UTF8Encoding]::new($false))
    if ($null -ne $oldState) { [IO.File]::Replace($nextState, $state, [NullString]::Value) }
    else { [IO.File]::Move($nextState, $state) }
    $committed = $true
    $result = 'success'
  }
}
catch {
  [Console]::Error.WriteLine("installer error: $($_.Exception.Message)")
  $exitCode = 2
}
finally {
  if ($switched -and -not $committed) {
    Invoke-CleanupStep 'pointer' {
      if ($null -ne $oldPointer) { [IO.File]::WriteAllText($pointer, $oldPointer, [Text.UTF8Encoding]::new($false)) }
      elseif (Test-Path -LiteralPath $pointer) { [IO.File]::Delete($pointer) }
    }
    Invoke-CleanupStep 'state' {
      if ($null -ne $oldState) { [IO.File]::WriteAllBytes($state, $oldState) }
      elseif (Test-Path -LiteralPath $state) { [IO.File]::Delete($state) }
    }
    if ($launcherSet) {
      Invoke-CleanupStep 'launcher' {
        if ($launcherExisted) { [IO.File]::WriteAllBytes($launcher, $oldLauncherBytes) }
        elseif (Test-Path -LiteralPath $launcher) { [IO.File]::Delete($launcher) }
      }
    }
  }
  if ($releasePlaced -and -not $committed -and (Test-Path -LiteralPath $release)) {
    Invoke-CleanupStep 'new release' { [IO.Directory]::Delete($release, $true) }
  }
  if ($nextPointer -and (Test-Path -LiteralPath $nextPointer)) {
    Invoke-CleanupStep 'temporary pointer' { [IO.File]::Delete($nextPointer) }
  }
  if ($nextLauncher -and (Test-Path -LiteralPath $nextLauncher)) {
    Invoke-CleanupStep 'temporary launcher' { [IO.File]::Delete($nextLauncher) }
  }
  if ($managedStage -and (Test-Path -LiteralPath $managedStage)) {
    Invoke-CleanupStep 'stage' { [IO.Directory]::Delete($managedStage, $true) }
  }
  if ($nextState -and (Test-Path -LiteralPath $nextState)) {
    Invoke-CleanupStep 'temporary state' { [IO.File]::Delete($nextState) }
  }
  if ($oldRelease -and (Test-Path -LiteralPath $oldRelease)) {
    if ($committed) {
      Invoke-CleanupStep 'previous release cleanup' { [IO.Directory]::Delete($oldRelease, $true) }
    }
    else {
      Invoke-CleanupStep 'previous release restore' { [IO.Directory]::Move($oldRelease, $release) }
    }
  }
  if ($lockOwned) {
    Invoke-CleanupStep 'lock handle' { $lockHandle.Dispose() }
    Invoke-CleanupStep 'lock file' { [IO.File]::Delete($runtimeLock) }
  }
  if (Test-Path -LiteralPath $work) {
    Invoke-CleanupStep 'temporary work' { [IO.Directory]::Delete($work, $true) }
  }
  if ($exitCode -ne 0) {
    for ($index = $createdDirs.Count - 1; $index -ge 0; $index--) {
      Invoke-CleanupStep 'created directory' {
        $target = $createdDirs[$index]
        if ((Get-ChildItem -LiteralPath $target -Force | Measure-Object).Count -eq 0) {
          [IO.Directory]::Delete($target)
        }
      }
    }
  }
}
if ($exitCode -ne 0) { exit $exitCode }
if ($Json) { @{ result = $result; releaseVersion = $RELEASE_VERSION } | ConvertTo-Json -Compress }
elseif ($result -eq 'dry-run') { "verified $RELEASE_VERSION" }
elseif ($result -eq 'unchanged') { "unchanged $RELEASE_VERSION" }
else { "installed $RELEASE_VERSION" }
