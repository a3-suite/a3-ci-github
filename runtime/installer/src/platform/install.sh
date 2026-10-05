#!/usr/bin/env bash
set -euo pipefail

version=2
# __INSTALLER_RUNTIME_VALUES__
usage() { printf '%s\n' 'usage: install.sh [--mode install|upgrade|repair|dry-run] [--source online|offline] [--manifest PATH --artifact PATH] [--smoke-help] [--json]'; }
fail() { printf 'installer error: %s\n' "$1" >&2; exit 2; }
sha256_file() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null; then shasum -a 256 "$1" | awk '{print $1}'
  else fail 'sha256sum or shasum is required'; fi
}
expand_runtime_path() {
  case "$1" in
    \~/*) [[ -n "${HOME:-}" ]] || fail 'HOME is required for home-relative paths'; printf '%s/%s' "$HOME" "${1#\~/}" ;;
    *) printf '%s' "$1" ;;
  esac
}
reject_relative_components() {
  local rest=${1#/} part
  while :; do
    part=${rest%%/*}
    case "$part" in ''|.|..) fail 'launcher path must not contain empty or relative components' ;; esac
    [[ "$rest" == */* ]] || break
    rest=${rest#*/}
  done
}
reject_broad_managed_root() {
  local root=$1 tail
  case "$root" in /*/*) ;; *) fail 'managed root is too broad' ;; esac
  case "$root" in
    /home/*|/Users/*)
      tail=${root#/home/}; tail=${tail#/Users/}
      case "$tail" in */*) ;; *) fail 'managed root is too broad' ;; esac ;;
  esac
  case "$root" in
    /root|/bin|/sbin|/lib|/lib64|/boot|/dev|/proc|/sys|/etc|/System|/run|/home|/Users) fail 'managed root is too broad' ;;
    /bin/*|/sbin/*|/lib/*|/lib64/*|/boot/*|/dev/*|/proc/*|/sys/*|/etc/*|/System/*|/run/*) fail 'managed root is too broad' ;;
    /usr|/usr/*) case "$root" in /usr/local/*) ;; *) fail 'managed root is too broad' ;; esac ;;
    /var|/var/*) case "$root" in /var/lib/*|/var/opt/*|/var/folders/*|/var/tmp/*) ;; *) fail 'managed root is too broad' ;; esac ;;
    /private|/private/*) case "$root" in /private/tmp/*|/private/var/folders/*|/private/var/tmp/*) ;; *) fail 'managed root is too broad' ;; esac ;;
    /Library|/Library/*) case "$root" in "/Library/Application Support/"*) ;; *) fail 'managed root is too broad' ;; esac ;;
    /opt|/srv|/Applications) fail 'managed root is too broad' ;;
  esac
}

mode='install' source_mode='online' local_manifest='' local_artifact='' json=0 smoke=0
while (($#)); do
  case "$1" in
    --help) usage; exit 0 ;;
    --version) printf '%s\n' "$version"; exit 0 ;;
    --manifest|--mode|--source|--artifact)
      (($# >= 2)) || fail "missing value for $1"
      case "$1" in
        --manifest) local_manifest=$2 ;;
        --mode) mode=$2 ;;
        --source) source_mode=$2 ;;
        --artifact) local_artifact=$2 ;;
      esac
      shift 2 ;;
    --smoke-help) smoke=1; shift ;;
    --json) json=1; shift ;;
    *) fail "unknown argument: $1" ;;
  esac
done
case "$mode" in install|upgrade|repair|dry-run) ;; *) fail 'invalid operation mode' ;; esac
case "$source_mode" in online|offline) ;; *) fail 'invalid source mode' ;; esac
[[ "$MANIFEST_SHA256" =~ ^[[:xdigit:]]{64}$ && "$MANIFEST_URL" == https://github.com/* ]] || fail 'invalid fixed manifest source'
[[ "$SOURCE_KIND" == github-release && "$ARTIFACT_URL" == https://* ]] || fail 'unsupported fixed source'
[[ "$ACTIVATION_STRATEGY" == active-pointer ]] || fail 'unsupported activation strategy'
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux-x86_64 ;;
  Darwin-arm64) platform=macos-arm64 ;;
  *) fail 'unsupported target platform' ;;
esac
[[ "$TARGET_PLATFORM" == "$platform" ]] || fail 'target platform mismatch'
[[ "$ARTIFACT_CHECKSUM" =~ ^sha256:[[:xdigit:]]{64}$ ]] || fail 'invalid artifact checksum'
expected_artifact=$(printf '%s' "$ARTIFACT_CHECKSUM" | cut -c8-)
case "$PROFILE" in per-user-cli|system-wide) ;; *) fail 'unsupported placement profile' ;; esac
MANAGED_ROOT=$(expand_runtime_path "$MANAGED_ROOT")
RELEASE_PATH=$(expand_runtime_path "$RELEASE_PATH")
CURRENT_POINTER=$(expand_runtime_path "$CURRENT_POINTER")
LOCK_PATH=$(expand_runtime_path "$LOCK_PATH")
INSTALL_STATE_PATH=$(expand_runtime_path "$INSTALL_STATE_PATH")
LAUNCHER_PATH=$(expand_runtime_path "$LAUNCHER_PATH")
[[ "$MANAGED_ROOT" = /* && "$MANAGED_ROOT" != / && ! "$MANAGED_ROOT" =~ (^|/)\.\.(/|$) ]] || fail 'invalid managed root'
reject_broad_managed_root "$MANAGED_ROOT"
for path in "$RELEASE_PATH" "$CURRENT_POINTER" "$LOCK_PATH" "$INSTALL_STATE_PATH"; do
  [[ "$path" == "$MANAGED_ROOT"/* && ! "$path" =~ (^|/)\.\.(/|$) ]] || fail 'path escapes managed root'
done
if [[ -n "$LAUNCHER_PATH" ]]; then
  reject_relative_components "$LAUNCHER_PATH"
  case "$PROFILE" in
    per-user-cli) case "$LAUNCHER_PATH" in "$HOME"/.local/bin/*) ;; *) fail 'launcher path is outside the per-user launcher base' ;; esac ;;
    system-wide) case "$LAUNCHER_PATH" in /usr/local/bin/*) ;; *) fail 'launcher path is outside the system launcher base' ;; esac ;;
  esac
  case "$LAUNCHER_PATH" in "$MANAGED_ROOT"/*) fail 'launcher path must be outside the managed root' ;; esac
fi
if [[ "$source_mode" == offline ]]; then
  [[ -n "$local_manifest" && -f "$local_manifest" && ! -L "$local_manifest" ]] || fail 'offline manifest must be a regular file'
  [[ -n "$local_artifact" && -f "$local_artifact" && ! -L "$local_artifact" ]] || fail 'offline artifact must be a regular file'
else
  [[ -z "$local_manifest" && -z "$local_artifact" ]] || fail 'online mode forbids local inputs'
fi

work=$(mktemp -d)
runtime_lock="$LOCK_PATH"
created_dirs=()
ensure_directory() {
  local dir=$1 parent entry stack=()
  dir=${dir%/}
  [[ -n "$dir" ]] || return 0
  while [[ ! -d "$dir" ]]; do
    stack+=("$dir")
    parent=$(dirname "$dir")
    [[ "$parent" != "$dir" ]] || break
    dir=$parent
  done
  local index
  for ((index = ${#stack[@]} - 1; index >= 0; index--)); do
    entry=${stack[index]}
    mkdir "$entry" || fail "directory creation failed: $entry"
    created_dirs+=("$entry")
  done
}
lock_owned=0 release_placed=0 switched=0 committed=0 old_pointer='' old_state='' old_release='' old_release_dir='' state_tmp='' stage_managed='' result=''
launcher_set=0 launcher_existed=0 old_launcher=''
cleanup() {
  local status=$?
  trap - EXIT
  if ((switched == 1 && committed == 0)); then
    if [[ -n "$old_pointer" ]]; then
      ln -s "$old_pointer" "$work/restore-pointer" || status=2
      case "$(uname -s)" in
        Linux) mv -fT "$work/restore-pointer" "$CURRENT_POINTER" || status=2 ;;
        Darwin) mv -fh "$work/restore-pointer" "$CURRENT_POINTER" || status=2 ;;
      esac
    else rm -f "$CURRENT_POINTER" || status=2; fi
    if [[ -n "$old_state" ]]; then cp "$old_state" "$INSTALL_STATE_PATH" || status=2
    else rm -f "$INSTALL_STATE_PATH" || status=2; fi
    if ((launcher_set == 1)); then
      if ((launcher_existed == 1)); then
        ln -s "$old_launcher" "$work/restore-launcher" || status=2
        case "$(uname -s)" in
          Linux) mv -fT "$work/restore-launcher" "$LAUNCHER_PATH" || status=2 ;;
          Darwin) mv -fh "$work/restore-launcher" "$LAUNCHER_PATH" || status=2 ;;
        esac
      else rm -f "$LAUNCHER_PATH" || status=2; fi
    fi
  fi
  if ((release_placed == 1 && committed == 0)); then rm -rf "$RELEASE_PATH" || status=2; fi
  if [[ -n "$old_release_dir" && -d "$old_release_dir" ]]; then
    if ((committed == 1)); then rm -rf "$old_release_dir" || status=2
    else
      if [[ -d "$old_release" ]]; then mv "$old_release" "$RELEASE_PATH" || status=2; fi
      if [[ ! -e "$old_release" ]]; then rmdir "$old_release_dir" || status=2; fi
    fi
  fi
  if ((lock_owned == 1)); then rmdir "$runtime_lock" || status=2; fi
  if [[ -n "$state_tmp" && -f "$state_tmp" ]]; then rm -f "$state_tmp" || status=2; fi
  if [[ -n "$stage_managed" && -d "$stage_managed" ]]; then rm -rf "$stage_managed" || status=2; fi
  if ((status != 0)); then
    local index
    for ((index = ${#created_dirs[@]} - 1; index >= 0; index--)); do
      rmdir "${created_dirs[index]}" 2>/dev/null || true
    done
  fi
  rm -rf "$work" || status=2
  if ((status == 0)); then
    if ((json == 1)); then printf '{"result":"%s","releaseVersion":"%s"}\n' "$result" "$RELEASE_VERSION"
    else
      case "$result" in
        dry-run) printf 'verified %s\n' "$RELEASE_VERSION" ;;
        unchanged) printf 'unchanged %s\n' "$RELEASE_VERSION" ;;
        success) printf 'installed %s\n' "$RELEASE_VERSION" ;;
      esac
    fi
  else printf 'installer failed; rollback status=%s\n' "$status" >&2; fi
  exit "$status"
}
trap cleanup EXIT
assert_no_symlink_path() {
  local path=$1 current=/ part
  path=$(dirname "$path")
  path="${path#/}"
  while [[ -n "$path" ]]; do
    part="${path%%/*}"; current="$current$part"
    [[ ! -L "$current" ]] || fail "symlink path component: $current"
    [[ "$path" == */* ]] || break
    path="${path#*/}"; current="$current/"
  done
}
# preflight を fetch より前に置き、lock 競合時に取得・検証を始めない。
# この時点で作成したディレクトリは失敗時に空であれば元に戻す。
for path in "$MANAGED_ROOT" "$RELEASE_PATH" "$CURRENT_POINTER" "$runtime_lock" "$INSTALL_STATE_PATH"; do assert_no_symlink_path "$path"; done
if [[ -n "$LAUNCHER_PATH" ]]; then assert_no_symlink_path "$LAUNCHER_PATH"; fi
if [[ "$mode" != dry-run ]]; then
  ensure_directory "$MANAGED_ROOT"
  ensure_directory "$(dirname "$runtime_lock")"
  mkdir "$runtime_lock" 2>/dev/null || fail 'another installation owns the runtime lock'
  lock_owned=1
fi
manifest="$work/manifest.json"
if [[ "$source_mode" == online ]]; then
  command -v curl >/dev/null || fail 'curl is required'
  curl --fail --silent --show-error --location --max-redirs 5 --proto '=https' --proto-redir '=https' --output "$manifest" "$MANIFEST_URL" || fail 'fixed manifest download failed'
else
  cp "$local_manifest" "$manifest" || fail 'offline manifest copy failed'
fi
actual_manifest=$(sha256_file "$manifest")
[[ "$actual_manifest" == "$MANIFEST_SHA256" ]] || fail 'manifest checksum mismatch'
artifact="$work/artifact"
if [[ "$source_mode" == online ]]; then
  command -v curl >/dev/null || fail 'curl is required'
  curl --fail --silent --show-error --location --max-redirs 5 --proto '=https' --proto-redir '=https' --output "$artifact" "$ARTIFACT_URL" || fail 'fixed download failed'
else
  cp "$local_artifact" "$artifact" || fail 'offline artifact copy failed'
fi
[[ "$(sha256_file "$artifact")" == "$expected_artifact" ]] || fail 'artifact checksum mismatch'
tar -tzf "$artifact" > "$work/entries" || fail 'archive listing failed'
while IFS= read -r entry; do
  [[ "$entry" != /* && "/$entry/" != */../* ]] || fail 'unsafe archive path'
done < "$work/entries"
tar -tvzf "$artifact" > "$work/metadata" || fail 'archive metadata failed'
while IFS= read -r metadata; do
  case "${metadata:0:1}" in -|d) ;; *) fail 'non-regular archive entry' ;; esac
done < "$work/metadata"
mkdir "$work/stage"
tar -xzf "$artifact" -C "$work/stage" || fail 'archive extraction failed'
binary='' count=0
while IFS= read -r -d '' entry; do count=$((count + 1)); binary=$entry; done < <(find "$work/stage" -type f -print0)
[[ "$count" -eq 1 && -f "$binary" && ! -L "$binary" ]] || fail 'expected exactly one binary'
chmod 0755 "$binary"
binary_checksum=$(sha256_file "$binary")
relative_binary="${binary#"$work/stage"/}"
if ((smoke == 1)); then "$binary" --help > "$work/smoke.out" 2>&1 || fail 'binary smoke check failed'; fi
[[ ! -e "$CURRENT_POINTER" || -L "$CURRENT_POINTER" ]] || fail 'current pointer must be a symlink'
if [[ -L "$CURRENT_POINTER" ]]; then old_pointer=$(readlink "$CURRENT_POINTER"); fi
if [[ -n "$LAUNCHER_PATH" ]]; then
  if [[ -L "$LAUNCHER_PATH" ]]; then
    old_launcher=$(readlink "$LAUNCHER_PATH") || fail 'cannot read launcher link'
    launcher_existed=1
  elif [[ -e "$LAUNCHER_PATH" ]]; then
    fail 'launcher path already exists and is not installer-managed'
  fi
fi
state_release=''
if [[ -e "$INSTALL_STATE_PATH" || -L "$INSTALL_STATE_PATH" ]]; then
  [[ -f "$INSTALL_STATE_PATH" && ! -L "$INSTALL_STATE_PATH" ]] || fail 'invalid install state'
  old_state="$work/previous-state"; cp "$INSTALL_STATE_PATH" "$old_state"
  state_manifest='' state_artifact='' state_binary='' state_launcher=''
  while IFS='=' read -r key value; do
    case "$key" in
      manifestChecksum) state_manifest=$value ;;
      artifactChecksum) state_artifact=$value ;;
      binaryChecksum) state_binary=$value ;;
      releaseVersion) state_release=$value ;;
      launcherPath) state_launcher=$value ;;
    esac
  done < "$old_state"
  [[ "$state_manifest" =~ ^[[:xdigit:]]{64}$ && "$state_artifact" =~ ^[[:xdigit:]]{64}$ && "$state_binary" =~ ^[[:xdigit:]]{64}$ && -n "$state_release" ]] || fail 'invalid install state content'
  # 同一 version の差し替えは mode にかかわらず明示 option なしでは拒否する。
  if [[ "$state_release" == "$RELEASE_VERSION" ]] && [[ "$state_manifest" != "$actual_manifest" || "$state_artifact" != "$expected_artifact" || "$state_binary" != "$binary_checksum" ]]; then
    fail 'same release version with different checksums is rejected'
  fi
  launcher_ok=1
  if [[ -n "$LAUNCHER_PATH" ]]; then
    if [[ "$state_launcher" != "$LAUNCHER_PATH" ]]; then
      launcher_ok=0
    elif [[ ! -L "$LAUNCHER_PATH" || "$(readlink "$LAUNCHER_PATH" 2>/dev/null)" != "$CURRENT_POINTER/$relative_binary" ]]; then
      launcher_ok=0
    fi
  elif [[ -n "$state_launcher" ]]; then
    launcher_ok=0
  fi
  if [[ "$launcher_existed" == 1 && "$launcher_ok" != 1 ]]; then
    fail 'launcher path already exists and is not installer-managed'
  fi
  if [[ "$state_manifest" == "$actual_manifest" && "$state_artifact" == "$expected_artifact" && "$state_binary" == "$binary_checksum" && "$state_release" == "$RELEASE_VERSION" && "$old_pointer" == "$RELEASE_PATH" && -f "$RELEASE_PATH/$relative_binary" ]] && [[ "$(sha256_file "$RELEASE_PATH/$relative_binary")" == "$binary_checksum" && "$launcher_ok" == 1 ]]; then
    committed=1
    if [[ "$mode" == dry-run ]]; then result='dry-run'; else result='unchanged'; fi
    exit 0
  fi
  [[ "$mode" != install ]] || fail 'install state exists; use upgrade or repair'
  if [[ "$mode" == repair ]]; then
    [[ "$old_pointer" == "$RELEASE_PATH" && "$state_release" == "$RELEASE_VERSION" && "$state_manifest" == "$actual_manifest" && "$state_artifact" == "$expected_artifact" ]] || fail 'repair requires the current release and matching checksums'
  fi
else
  [[ -z "$old_pointer" ]] || fail 'current pointer exists without install state'
  [[ "$launcher_existed" != 1 ]] || fail 'launcher path already exists and is not installer-managed'
  [[ "$mode" != upgrade ]] || fail 'upgrade requires install state'
  [[ "$mode" != repair ]] || fail 'repair requires install state'
fi
if [[ "$mode" == dry-run ]]; then
  result='dry-run'
  exit 0
fi
if [[ -e "$RELEASE_PATH" || -L "$RELEASE_PATH" ]]; then
  [[ "$mode" == repair && ( "$old_pointer" == "$RELEASE_PATH" || -z "$old_pointer" ) && -d "$RELEASE_PATH" ]] || fail 'release path already exists'
  old_release_dir=$(mktemp -d "$MANAGED_ROOT/.previous-release.XXXXXX")
  old_release="$old_release_dir/release"
fi
ensure_directory "$(dirname "$INSTALL_STATE_PATH")"
ensure_directory "$(dirname "$RELEASE_PATH")"
ensure_directory "$(dirname "$CURRENT_POINTER")"
assert_no_symlink_path "$RELEASE_PATH"
assert_no_symlink_path "$CURRENT_POINTER"
[[ ! -e "$CURRENT_POINTER" || -L "$CURRENT_POINTER" ]] || fail 'current pointer must be a symlink'
stage_managed=$(mktemp -d "$MANAGED_ROOT/.staging.XXXXXX")
tar -xzf "$artifact" -C "$stage_managed" || fail 'staging failed'
[[ "$(sha256_file "$stage_managed/$relative_binary")" == "$binary_checksum" ]] || fail 'staged binary checksum mismatch'
while IFS= read -r -d '' directory; do chmod 0755 "$directory"; done < <(find "$stage_managed" -type d -print0)
chmod 0755 "$stage_managed/$relative_binary"
# 旧 release は staging 検証が完了するまで退避しない（stage 中の稼働対象消失を防ぐ）。
if [[ -n "$old_release" ]]; then mv "$RELEASE_PATH" "$old_release" || fail 'release backup failed'; fi
mv "$stage_managed" "$RELEASE_PATH" || fail 'release placement failed'
stage_managed=''
release_placed=1
if [[ -n "$LAUNCHER_PATH" ]]; then assert_no_symlink_path "$LAUNCHER_PATH"; fi
ln -s "$RELEASE_PATH" "$work/next-pointer"
case "$(uname -s)" in
  Linux) mv -fT "$work/next-pointer" "$CURRENT_POINTER" || fail 'activation failed' ;;
  Darwin) mv -fh "$work/next-pointer" "$CURRENT_POINTER" || fail 'activation failed' ;;
esac
switched=1
if [[ -n "$LAUNCHER_PATH" ]]; then
  assert_no_symlink_path "$LAUNCHER_PATH"
  mkdir -p "$(dirname "$LAUNCHER_PATH")" || fail 'launcher directory creation failed'
  assert_no_symlink_path "$LAUNCHER_PATH"
  ln -s "$CURRENT_POINTER/$relative_binary" "$work/next-launcher" || fail 'launcher creation failed'
  case "$(uname -s)" in
    Linux) mv -fT "$work/next-launcher" "$LAUNCHER_PATH" || fail 'launcher activation failed' ;;
    Darwin) mv -fh "$work/next-launcher" "$LAUNCHER_PATH" || fail 'launcher activation failed' ;;
  esac
  launcher_set=1
fi
state_tmp="$(dirname "$INSTALL_STATE_PATH")/.install-state.$$.$RANDOM.tmp"
printf 'releaseVersion=%s\nartifactChecksum=%s\nbinaryChecksum=%s\nmanifestChecksum=%s\nsourceCommit=%s\nciRunId=%s\ninstallerVersion=%s\ninstalledAt=%s\npreviousRelease=%s\nlauncherPath=%s\n' "$RELEASE_VERSION" "$expected_artifact" "$binary_checksum" "$actual_manifest" "$SOURCE_COMMIT" "$CI_RUN_ID" "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$state_release" "$LAUNCHER_PATH" > "$state_tmp"
mv "$state_tmp" "$INSTALL_STATE_PATH" || fail 'install state write failed'
committed=1
result='success'
