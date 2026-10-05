"""Assemble an installer candidate, then finalize evidence after verification."""

from __future__ import annotations

import argparse
import json
import ntpath
import posixpath
import re
import shlex
import sys
import zipfile
from pathlib import Path, PurePosixPath, PureWindowsPath
from urllib.parse import urlsplit

from builder_common import (
    AssemblyError,
    _normalize_source_bytes,
    _read_json_object,
    _read_regular_file,
    _sha256,
    _snapshot_source,
    _source_checksum,
    _write_json,
    _zip_info,
)

BUILDER_IDENTITY = "installer.github-release-native.script-builder.v2"
PLACEHOLDER_PATTERN = re.compile(r"<[^<>]+>")
CANDIDATE_RECORD_NAME = "installer-asset-candidate.json"
VERIFICATION_RECORD_NAME = "installer-verification-evidence.json"
EVIDENCE_RECORD_NAME = "installer-asset-evidence.json"
SOURCE_SNAPSHOT_NAME = ".installer-source.zip"
RUNTIME_VALUES_MARKER = "# __INSTALLER_RUNTIME_VALUES__"
ASCII_CONTROL_LIMIT = 32
ASCII_DELETE = 127
INSTALLER_MAJOR_VERSION = 2
MIN_MANAGED_ROOT_DEPTH = 2
APP_SPECIFIC_DEPTH = 3
UNC_MANAGED_ROOT_DEPTH = 3
UNIX_RESERVED_SUBTREES = frozenset(
    {
        "bin",
        "sbin",
        "lib",
        "lib64",
        "boot",
        "dev",
        "proc",
        "sys",
        "etc",
        "System",
        "run",
    }
)


def _contains_placeholder(value: object) -> bool:
    if isinstance(value, str):
        return PLACEHOLDER_PATTERN.search(value) is not None
    if isinstance(value, list):
        return any(_contains_placeholder(item) for item in value)
    if isinstance(value, dict):
        return any(_contains_placeholder(item) for item in value.values())
    return False


def _require_mapping(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise AssemblyError(f"{label} must be a JSON object")
    return value


def _require_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AssemblyError(f"{label} must be a non-empty string")
    return value


def _validate_asset_name(asset_name: str, suffix: str | None = None) -> None:
    if (
        Path(asset_name).name != asset_name
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.(?:sh|ps1)", asset_name) is None
        or (suffix is not None and not asset_name.endswith(suffix))
    ):
        raise AssemblyError("asset name must be a safe platform script basename")


def _validate_provenance(
    manifest: dict[str, object], source_revision: str, assembly_id: str
) -> None:
    provenance = _require_mapping(manifest.get("provenance"), "manifest provenance")
    if provenance.get("sourceCommit") != source_revision:
        raise AssemblyError(
            "source revision must match manifest provenance sourceCommit"
        )
    if provenance.get("ciRunId") != assembly_id:
        raise AssemblyError("assembly id must match manifest provenance ciRunId")


def _unix_guarded_managed_root_allowed(components: tuple[str, ...]) -> bool:
    """Allow only the documented app-specific exceptions under guarded roots."""
    first = components[0]
    if first == "usr":
        return len(components) >= APP_SPECIFIC_DEPTH and components[1] == "local"
    if first == "var":
        return len(components) >= APP_SPECIFIC_DEPTH and components[1] in {
            "lib",
            "opt",
            "folders",
            "tmp",
        }
    if first == "private":
        if len(components) < APP_SPECIFIC_DEPTH:
            return False
        if components[1] == "tmp":
            return True
        return (
            components[1] == "var"
            and len(components) >= APP_SPECIFIC_DEPTH + 1
            and components[2] in {"folders", "tmp"}
        )
    if first == "Library":
        return (
            len(components) >= APP_SPECIFIC_DEPTH
            and components[1] == "Application Support"
        )
    return False


def _windows_env_components(raw: str) -> tuple[str, tuple[str, ...]] | None:
    lowered = raw.lower()
    for name in ("localappdata", "userprofile", "programdata", "programfiles"):
        prefix = f"%{name}%"
        if lowered.startswith(prefix):
            remainder = raw[len(prefix) :]
            if not remainder.startswith(("\\", "/")):
                return None
            parts = tuple(remainder.replace("/", "\\")[1:].split("\\"))
            return name, parts
    return None


def _classify_placement_path(raw: str, windows: bool) -> tuple[str, tuple[str, ...]]:
    """Return the path style and components for a manifest placement path."""
    if raw.startswith("~/"):
        return "unix-home", tuple(raw[2:].split("/"))
    if windows:
        env = _windows_env_components(raw)
        if env is not None:
            name, parts = env
            return f"windows-env:{name}", parts
    return "absolute", ()


def _is_strictly_within(parts: tuple[str, ...], root: tuple[str, ...]) -> bool:
    return len(parts) > len(root) and parts[: len(root)] == root


def _components_overlap(left: tuple[str, ...], right: tuple[str, ...]) -> bool:
    return _is_strictly_within(left, right) or _is_strictly_within(right, left)


def _reject_broad_managed_root(
    root: PurePosixPath | PureWindowsPath, windows: bool
) -> None:
    """Reject shared or OS-reserved managed roots."""
    if windows:
        if str(root).startswith("\\\\"):
            parts = [part for part in str(root).split("\\") if part]
            if len(parts) < UNC_MANAGED_ROOT_DEPTH or parts[1].lower() == "windows":
                raise AssemblyError("managed root is too broad")
            if parts[1].lower() == "users" and len(parts) == UNC_MANAGED_ROOT_DEPTH:
                raise AssemblyError("managed root is too broad")
            return
        parts = [part for part in root.parts[1:] if part != "\\"]
        if len(parts) < MIN_MANAGED_ROOT_DEPTH or parts[0].lower() == "windows":
            raise AssemblyError("managed root is too broad")
        if parts[0].lower() == "users" and len(parts) == MIN_MANAGED_ROOT_DEPTH:
            raise AssemblyError("managed root is too broad")
        return
    components = tuple(part for part in root.parts if part != "/")
    if len(components) < MIN_MANAGED_ROOT_DEPTH:
        raise AssemblyError("managed root is too broad")
    first = components[0]
    if first in {"home", "Users"} and len(components) == MIN_MANAGED_ROOT_DEPTH:
        raise AssemblyError("managed root is too broad")
    if first in UNIX_RESERVED_SUBTREES:
        raise AssemblyError("managed root is too broad")
    if first in {"usr", "var", "private", "Library"} and not (
        _unix_guarded_managed_root_allowed(components)
    ):
        raise AssemblyError("managed root is too broad")


def _launcher_components(raw: str, windows: bool) -> tuple[str, tuple[str, ...]]:
    """Return the launcher path style and full components for base checks.

    Absolute paths must be decomposed with the target platform's path type so a
    system-wide launcher can be compared against its allowed base. The generic
    placement classifier intentionally returns no components for absolute paths,
    which would make the system-wide base check unreachable.
    """
    style, parts = _classify_placement_path(raw, windows)
    if style == "absolute":
        path_type = PureWindowsPath if windows else PurePosixPath
        parts = tuple(path_type(raw).parts)
    return style, parts


def _reject_relative_launcher_components(raw: str, windows: bool) -> None:
    """Reject empty and relative components from the raw launcher path.

    Absolute paths must be checked before path normalization, because
    ``PurePath`` drops empty and ``.`` components, which would hide a launcher
    path that the runtime rejects.
    """
    if raw.startswith("~/"):
        parts = raw[2:].split("/")
    elif windows:
        env = _windows_env_components(raw)
        if env is not None:
            parts = list(env[1])
        else:
            parts = raw.replace("/", "\\").split("\\")
    else:
        parts = raw.split("/")
        if parts and parts[0] == "":
            parts = parts[1:]
    if any(part in {"", ".", ".."} for part in parts):
        raise AssemblyError(
            "launcher path must not contain empty or relative components"
        )


def _validate_launcher_path(
    validated: dict[str, str],
    windows: bool,
    target_platform: str,
    profile: str,
    style_kind: str,
    managed_root_path: PurePosixPath | PureWindowsPath | None,
    managed_root_components: tuple[str, ...],
) -> None:
    del target_platform
    launcher = validated["LAUNCHER_PATH"]
    if not launcher:
        return
    _reject_relative_launcher_components(launcher, windows)
    launcher_style, parts = _launcher_components(launcher, windows)
    if launcher_style.split(":")[0] != style_kind:
        raise AssemblyError("launcher path must use the same path style as placement")
    if profile == "per-user-cli":
        if launcher_style == "unix-home":
            if not _is_strictly_within(parts, (".local", "bin")):
                raise AssemblyError("launcher path must stay under ~/.local/bin")
        elif launcher_style == "windows-env:localappdata":
            if not _is_strictly_within(parts, ("Programs",)):
                raise AssemblyError(
                    "launcher path must stay under %LOCALAPPDATA%\\Programs"
                )
        else:
            raise AssemblyError("launcher path must use a per-user launcher base")
    elif launcher_style == "absolute" and not windows:
        if not _is_strictly_within(parts, ("/", "usr", "local", "bin")):
            raise AssemblyError("launcher path must stay under /usr/local/bin")
    elif launcher_style == "absolute" and windows:
        # ProgramFiles belongs to the target host, not the assembly host.
        # The runtime checks its allowed base before any placement.
        if not PureWindowsPath(launcher).is_absolute():
            raise AssemblyError("launcher path must be absolute")
    else:
        raise AssemblyError("launcher path must use a system launcher base")
    if style_kind == "absolute":
        if managed_root_path is None:
            raise AssemblyError("managed root path is unavailable")
        launcher_path = (
            PureWindowsPath(launcher) if windows else PurePosixPath(launcher)
        )
        if launcher_path == managed_root_path or launcher_path.is_relative_to(
            managed_root_path
        ):
            raise AssemblyError("launcher path must be outside the managed root")
    elif _is_strictly_within(parts, managed_root_components) or _is_strictly_within(
        managed_root_components, parts
    ):
        raise AssemblyError("launcher path must be outside the managed root")


def _runtime_values(manifest: dict[str, object], checksum: str) -> dict[str, str]:
    expected_sections = {
        "schemaVersion",
        "releaseVersion",
        "targetPlatformId",
        "source",
        "artifact",
        "placement",
        "activation",
        "concurrency",
        "state",
        "compatibility",
        "provenance",
    }
    if (
        set(manifest) != expected_sections
        or manifest.get("schemaVersion") != "installer.manifest.v2"
    ):
        raise AssemblyError("unsupported manifest fields or schema version")
    source = _require_mapping(manifest.get("source"), "manifest source")
    artifact = _require_mapping(manifest.get("artifact"), "manifest artifact")
    placement = _require_mapping(manifest.get("placement"), "manifest placement")
    concurrency = _require_mapping(manifest.get("concurrency"), "manifest concurrency")
    state = _require_mapping(manifest.get("state"), "manifest state")
    activation = _require_mapping(manifest.get("activation"), "manifest activation")
    compatibility = _require_mapping(
        manifest.get("compatibility"), "manifest compatibility"
    )
    provenance = _require_mapping(manifest.get("provenance"), "manifest provenance")
    expected_fields = (
        (source, {"kind", "owner", "repository", "fixedReference"}, set()),
        (artifact, {"url", "fileName", "checksum"}, set()),
        (
            placement,
            {"managedRoot", "releasePath", "currentLink"},
            {"profile", "channel"},
        ),
        (activation, {"strategy"}, {"launcherPath"}),
        (concurrency, {"lockPath"}, set()),
        (state, {"installStatePath"}, set()),
        (compatibility, {"requiredInstallerVersion"}, set()),
        (provenance, {"sourceTag", "sourceCommit", "ciRunId"}, set()),
    )
    if any(
        not required <= set(section) <= required | optional
        for section, required, optional in expected_fields
    ):
        raise AssemblyError("unsupported nested manifest fields")
    profile = placement.get("profile", "per-user-cli")
    channel = placement.get("channel", "standalone")
    launcher_raw = activation.get("launcherPath", "")
    if not isinstance(profile, str) or profile not in {
        "per-user-cli",
        "system-wide",
    }:
        raise AssemblyError("unsupported placement profile")
    if not isinstance(channel, str) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._-]*", channel
    ):
        raise AssemblyError("unsafe placement channel")
    values = {
        "MANIFEST_SHA256": checksum,
        "RELEASE_VERSION": manifest.get("releaseVersion"),
        "TARGET_PLATFORM": manifest.get("targetPlatformId"),
        "SOURCE_KIND": source.get("kind"),
        "FIXED_REFERENCE": source.get("fixedReference"),
        "ARTIFACT_URL": artifact.get("url"),
        "ARTIFACT_FILE_NAME": artifact.get("fileName"),
        "ARTIFACT_CHECKSUM": artifact.get("checksum"),
        "MANAGED_ROOT": placement.get("managedRoot"),
        "RELEASE_PATH": placement.get("releasePath"),
        "CURRENT_POINTER": placement.get("currentLink"),
        "LOCK_PATH": concurrency.get("lockPath"),
        "INSTALL_STATE_PATH": state.get("installStatePath"),
        "ACTIVATION_STRATEGY": activation.get("strategy"),
        "PROFILE": profile,
        "CHANNEL": channel,
        "LAUNCHER_PATH": launcher_raw,
        "SOURCE_COMMIT": provenance.get("sourceCommit"),
        "CI_RUN_ID": provenance.get("ciRunId"),
        "REQUIRED_INSTALLER_VERSION": compatibility.get("requiredInstallerVersion"),
    }
    validated = {
        key: _require_string(value, key)
        for key, value in values.items()
        if key != "LAUNCHER_PATH"
    }
    validated["LAUNCHER_PATH"] = (
        _require_string(launcher_raw, "LAUNCHER_PATH") if launcher_raw else ""
    )
    if any(
        any(
            ord(character) < ASCII_CONTROL_LIMIT or ord(character) == ASCII_DELETE
            for character in value
        )
        for value in validated.values()
        if value
    ):
        raise AssemblyError("runtime values must not contain control characters")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]*", validated["RELEASE_VERSION"]):
        raise AssemblyError("release version is unsafe for runtime output")
    if validated["TARGET_PLATFORM"] not in {
        "linux-x86_64",
        "macos-arm64",
        "windows-x86_64",
    }:
        raise AssemblyError("unsupported target platform")
    windows_target = validated["TARGET_PLATFORM"].startswith("windows-")
    path_keys = (
        "MANAGED_ROOT",
        "RELEASE_PATH",
        "CURRENT_POINTER",
        "LOCK_PATH",
        "INSTALL_STATE_PATH",
    )
    styles = {
        _classify_placement_path(validated[key], windows_target)[0] for key in path_keys
    }
    style_kinds = {style.split(":")[0] for style in styles}
    if len(style_kinds) != 1:
        raise AssemblyError("placement paths must use the same path style")
    style_kind = style_kinds.pop()
    managed_root_path: PurePosixPath | PureWindowsPath | None = None
    managed_root_components: tuple[str, ...] = ()
    if style_kind == "absolute":
        path_type = PureWindowsPath if windows_target else PurePosixPath
        path_module = ntpath if windows_target else posixpath
        if any(".." in path_type(validated[key]).parts for key in path_keys):
            raise AssemblyError("parent traversal in placement path")
        if not windows_target and any(
            posixpath.normpath(validated[key]) != validated[key] for key in path_keys
        ):
            raise AssemblyError("Unix placement paths must be normalized")
        paths = {
            key: path_type(path_module.normpath(validated[key])) for key in path_keys
        }
        for key, path in paths.items():
            if not path.is_absolute():
                raise AssemblyError(f"absolute placement path is required: {key}")
        root = paths["MANAGED_ROOT"]
        if not windows_target and root == PurePosixPath("/"):
            raise AssemblyError("filesystem root cannot be a managed root")
        managed_paths = {key: paths[key] for key in path_keys[1:]}
        for key, path in managed_paths.items():
            if path == root or not path.is_relative_to(root):
                raise AssemblyError(f"placement path escapes managed root: {key}")
        for key, path in managed_paths.items():
            for other_key, other in managed_paths.items():
                if key >= other_key:
                    continue
                if path.is_relative_to(other) or other.is_relative_to(path):
                    raise AssemblyError(
                        f"overlapping placement paths: {key}, {other_key}"
                    )
        _reject_broad_managed_root(root, windows_target)
        managed_root_path = root
    else:
        if profile != "per-user-cli":
            raise AssemblyError(
                "home or environment placeholders are only allowed for per-user-cli"
            )
        parsed = {
            key: _classify_placement_path(validated[key], windows_target)
            for key in path_keys
        }
        if len({value[0] for value in parsed.values()}) != 1:
            raise AssemblyError("placement paths must use the same placeholder style")
        managed_root_components = parsed["MANAGED_ROOT"][1]
        if not managed_root_components or any(
            part in {"", ".", ".."} for part in managed_root_components
        ):
            raise AssemblyError("invalid managed root placeholder path")
        placeholder_style = parsed["MANAGED_ROOT"][0]
        if placeholder_style == "unix-home":
            if validated["TARGET_PLATFORM"] == "linux-x86_64":
                base = (".local", "share")
            elif validated["TARGET_PLATFORM"] == "macos-arm64":
                base = ("Library", "Application Support")
            else:
                raise AssemblyError("unsupported target platform")
            if managed_root_components[: len(base)] != base or len(
                managed_root_components
            ) <= len(base):
                raise AssemblyError(
                    "managed root must stay under the per-user data base"
                )
        elif placeholder_style == "windows-env:localappdata":
            pass
        else:
            raise AssemblyError("managed root must use a per-user base")
        for key in path_keys[1:]:
            parts = parsed[key][1]
            if any(
                part in {"", ".", ".."} for part in parts
            ) or not _is_strictly_within(parts, managed_root_components):
                raise AssemblyError(f"placement path escapes managed root: {key}")
        for key in path_keys[1:]:
            for other_key in path_keys[1:]:
                if key >= other_key:
                    continue
                if _components_overlap(parsed[key][1], parsed[other_key][1]):
                    raise AssemblyError(
                        f"overlapping placement paths: {key}, {other_key}"
                    )
    _validate_launcher_path(
        validated,
        windows_target,
        validated["TARGET_PLATFORM"],
        profile,
        style_kind,
        managed_root_path,
        managed_root_components,
    )
    if (
        validated["SOURCE_KIND"] != "github-release"
        or validated["ACTIVATION_STRATEGY"] != "active-pointer"
    ):
        raise AssemblyError("starter supports GitHub Release active-pointer only")
    required_version = validated["REQUIRED_INSTALLER_VERSION"]
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", required_version):
        raise AssemblyError("required installer version is unsupported")
    version_parts = [int(part) for part in required_version.split(".")]
    if version_parts[0] > INSTALLER_MAJOR_VERSION or (
        version_parts[0] == INSTALLER_MAJOR_VERSION
        and any(part > 0 for part in version_parts[1:])
    ):
        raise AssemblyError("required installer version is unsupported")
    for key in ("FIXED_REFERENCE", "ARTIFACT_FILE_NAME"):
        if (
            not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]*", validated[key])
            or validated[key].lower() == "latest"
        ):
            raise AssemblyError(f"unsafe {key}")
    owner = _require_string(source.get("owner"), "source owner")
    repository = _require_string(source.get("repository"), "source repository")
    for value in (owner, repository):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
            raise AssemblyError("unsafe GitHub source identity")
    url = urlsplit(validated["ARTIFACT_URL"])
    expected_path = (
        f"/{owner}/{repository}/releases/download/"
        f"{validated['FIXED_REFERENCE']}/{validated['ARTIFACT_FILE_NAME']}"
    )
    if (
        url.scheme != "https"
        or url.hostname != "github.com"
        or url.username
        or url.password
        or url.query
        or url.fragment
        or url.path != expected_path
    ):
        raise AssemblyError("artifact URL must match fixed GitHub Release identity")
    suffix = (
        ".zip" if validated["TARGET_PLATFORM"].startswith("windows-") else ".tar.gz"
    )
    if not validated["ARTIFACT_FILE_NAME"].endswith(suffix):
        raise AssemblyError("artifact archive type does not match target platform")
    if not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", validated["ARTIFACT_CHECKSUM"]):
        raise AssemblyError("artifact checksum must be SHA256")
    if provenance["sourceTag"] != validated["FIXED_REFERENCE"]:
        raise AssemblyError("source tag must match fixed reference")
    return validated


def _runtime_config_sh(values: dict[str, str]) -> bytes:
    return (
        "\n".join(f"{key}={shlex.quote(value)}" for key, value in values.items()) + "\n"
    ).encode()


def _runtime_config_ps1(values: dict[str, str]) -> bytes:
    def quote(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"

    return (
        "\n".join(f"${key} = {quote(value)}" for key, value in values.items()) + "\n"
    ).encode()


def _manifest_url(manifest: dict[str, object]) -> str:
    source = _require_mapping(manifest.get("source"), "manifest source")
    return (
        f"https://github.com/{source['owner']}/{source['repository']}/"
        f"releases/download/{source['fixedReference']}/{_manifest_name(manifest)}"
    )


def _manifest_name(manifest: dict[str, object]) -> str:
    return f"manifest-{manifest['targetPlatformId']}.json"


def _render_script(source: bytes, values: dict[str, str], windows: bool) -> bytes:
    marker = RUNTIME_VALUES_MARKER.encode()
    if source.count(marker) != 1:
        raise AssemblyError("installer source must contain one runtime values marker")
    config = _runtime_config_ps1(values) if windows else _runtime_config_sh(values)
    return source.replace(marker, config.rstrip(b"\n"))


def assemble_candidate(
    *,
    source_dir: Path,
    manifest_path: Path,
    output_dir: Path,
    asset_name: str,
    source_revision: str,
    assembly_id: str,
) -> dict[str, str]:
    """Build a deterministic standalone candidate script."""
    source_revision = _require_string(source_revision, "source revision")
    assembly_id = _require_string(assembly_id, "assembly id")
    if output_dir.exists():
        raise AssemblyError(f"output directory already exists: {output_dir}")
    if not output_dir.parent.is_dir():
        raise AssemblyError(
            f"output parent directory does not exist: {output_dir.parent}"
        )

    source_snapshot = _snapshot_source(source_dir)
    if any(
        path.as_posix() in {"runtime-values.sh", "runtime-values.ps1"}
        for path, _, _ in source_snapshot
    ):
        raise AssemblyError("runtime values are generated from the manifest")
    manifest_bytes, manifest = _read_json_object(manifest_path, "manifest")
    manifest_bytes = _normalize_source_bytes(manifest_bytes, "manifest")
    if _contains_placeholder(manifest):
        raise AssemblyError("manifest contains unresolved template placeholders")
    _validate_provenance(manifest, source_revision, assembly_id)
    manifest_checksum = _sha256(manifest_bytes)
    runtime_values = _runtime_values(manifest, manifest_checksum)
    runtime_values["MANIFEST_URL"] = _manifest_url(manifest)
    windows = runtime_values["TARGET_PLATFORM"].startswith("windows-")
    required_entrypoint = "install.ps1" if windows else "install.sh"
    if required_entrypoint not in {path.as_posix() for path, _, _ in source_snapshot}:
        raise AssemblyError(
            f"target platform entrypoint is missing: {required_entrypoint}"
        )
    _validate_asset_name(asset_name, ".ps1" if windows else ".sh")
    installer_source_checksum = _source_checksum(source_snapshot)
    entrypoint_source = next(
        payload
        for path, payload, _ in source_snapshot
        if path.as_posix() == required_entrypoint
    )
    script_bytes = _render_script(entrypoint_source, runtime_values, windows)

    output_dir.mkdir()
    asset_path = output_dir / asset_name
    asset_path.write_bytes(script_bytes)
    asset_path.chmod(0o644 if windows else 0o755)
    manifest_name = _manifest_name(manifest)
    (output_dir / manifest_name).write_bytes(manifest_bytes)
    with zipfile.ZipFile(output_dir / SOURCE_SNAPSHOT_NAME, mode="x") as archive:
        for relative_path, payload, mode in source_snapshot:
            archive.writestr(_zip_info(relative_path.as_posix(), mode), payload)

    asset_checksum = _sha256(asset_path.read_bytes())
    checksum_path = output_dir / f"{asset_name}.sha256"
    checksum_path.write_text(f"{asset_checksum}  {asset_name}\n", encoding="utf-8")
    candidate_path = output_dir / CANDIDATE_RECORD_NAME
    _write_json(
        candidate_path,
        {
            "assembly_id": assembly_id,
            "asset_checksum": f"sha256:{asset_checksum}",
            "asset_name": asset_name,
            "builder_identity": BUILDER_IDENTITY,
            "installer_source_checksum": f"sha256:{installer_source_checksum}",
            "manifest_checksum": f"sha256:{manifest_checksum}",
            "manifest_name": manifest_name,
            "payload_checksum": None,
            "source_revision": source_revision,
        },
    )
    return {
        "asset": asset_path.name,
        "asset_checksum": f"sha256:{asset_checksum}",
        "candidate": candidate_path.name,
    }


def _inspect_candidate_script(
    asset_path: Path,
    output_dir: Path,
    manifest_name: str,
) -> tuple[bytes, bytes, dict[str, object], str]:
    asset_bytes = _read_regular_file(asset_path, "candidate asset")
    manifest_bytes, manifest = _read_json_object(
        output_dir / manifest_name, "candidate manifest"
    )
    _read_regular_file(output_dir / SOURCE_SNAPSHOT_NAME, "candidate source snapshot")
    try:
        with zipfile.ZipFile(output_dir / SOURCE_SNAPSHOT_NAME) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            if len(names) != len(set(names)):
                raise AssemblyError("source snapshot contains duplicate entries")
            if not entries:
                raise AssemblyError("source snapshot is empty")
            source_snapshot = []
            for entry in sorted(entries, key=lambda item: item.filename):
                relative_name = entry.filename
                if (
                    entry.is_dir()
                    or not relative_name
                    or PurePosixPath(relative_name).is_absolute()
                    or ".." in PurePosixPath(relative_name).parts
                ):
                    raise AssemblyError("source snapshot contains an unsafe path")
                mode = (entry.external_attr >> 16) & 0o777
                archive_mode = 0o755 if mode & 0o111 else 0o644
                source_snapshot.append(
                    (PurePosixPath(relative_name), archive.read(entry), archive_mode)
                )
    except (KeyError, zipfile.BadZipFile) as error:
        raise AssemblyError(
            "candidate source snapshot must be a readable ZIP"
        ) from error
    values = _runtime_values(manifest, _sha256(manifest_bytes))
    if manifest_name != _manifest_name(manifest):
        raise AssemblyError("candidate manifest name does not match platform")
    values["MANIFEST_URL"] = _manifest_url(manifest)
    windows = values["TARGET_PLATFORM"].startswith("windows-")
    _validate_asset_name(asset_path.name, ".ps1" if windows else ".sh")
    required_entrypoint = "install.ps1" if windows else "install.sh"
    source = next(
        (
            payload
            for path, payload, _ in source_snapshot
            if path.as_posix() == required_entrypoint
        ),
        None,
    )
    if source is None or asset_bytes != _render_script(source, values, windows):
        raise AssemblyError("candidate script does not match manifest and source")
    return asset_bytes, manifest_bytes, manifest, _source_checksum(source_snapshot)


def finalize_evidence(
    *, output_dir: Path, verification_evidence_path: Path
) -> dict[str, str]:
    """Finalize evidence after verification of the exact candidate script."""
    if output_dir.is_symlink() or not output_dir.is_dir():
        raise AssemblyError(
            f"candidate output must be a non-symlink directory: {output_dir}"
        )
    final_paths = [
        output_dir / VERIFICATION_RECORD_NAME,
        output_dir / EVIDENCE_RECORD_NAME,
        output_dir / f"{EVIDENCE_RECORD_NAME}.sha256",
    ]
    if any(path.exists() or path.is_symlink() for path in final_paths):
        raise AssemblyError("final evidence output already exists")

    _, candidate = _read_json_object(
        output_dir / CANDIDATE_RECORD_NAME, "candidate record"
    )
    asset_name = _require_string(candidate.get("asset_name"), "candidate asset_name")
    _validate_asset_name(asset_name)
    asset_checksum = _require_string(
        candidate.get("asset_checksum"), "candidate asset_checksum"
    )
    manifest_checksum = _require_string(
        candidate.get("manifest_checksum"), "candidate manifest_checksum"
    )
    manifest_name = _require_string(
        candidate.get("manifest_name"), "candidate manifest_name"
    )
    if (
        re.fullmatch(
            r"manifest-(?:linux-x86_64|macos-arm64|windows-x86_64)\.json", manifest_name
        )
        is None
    ):
        raise AssemblyError("invalid candidate manifest name")
    installer_source_checksum = _require_string(
        candidate.get("installer_source_checksum"),
        "candidate installer_source_checksum",
    )
    source_revision = _require_string(
        candidate.get("source_revision"), "candidate source_revision"
    )
    assembly_id = _require_string(candidate.get("assembly_id"), "candidate assembly_id")
    if candidate.get("builder_identity") != BUILDER_IDENTITY:
        raise AssemblyError("candidate builder identity mismatch")

    asset_path = output_dir / asset_name
    actual_asset_checksum = (
        f"sha256:{_sha256(_read_regular_file(asset_path, 'candidate asset'))}"
    )
    if actual_asset_checksum != asset_checksum:
        raise AssemblyError("candidate asset checksum mismatch")
    _asset_bytes, manifest_bytes, manifest, archived_source_checksum = (
        _inspect_candidate_script(asset_path, output_dir, manifest_name)
    )
    actual_manifest_checksum = f"sha256:{_sha256(manifest_bytes)}"
    if actual_manifest_checksum != manifest_checksum:
        raise AssemblyError("candidate manifest checksum mismatch")
    if f"sha256:{archived_source_checksum}" != installer_source_checksum:
        raise AssemblyError("candidate installer source checksum mismatch")
    _validate_provenance(manifest, source_revision, assembly_id)

    verification_bytes, verification = _read_json_object(
        verification_evidence_path, "post-assembly verification evidence"
    )
    if verification.get("status") != "passed":
        raise AssemblyError("verification evidence status must be passed")
    suite = _require_string(verification.get("suite"), "verification evidence suite")
    expected_bindings = {
        "asset_checksum": asset_checksum,
        "source_revision": source_revision,
        "manifest_checksum": manifest_checksum,
        "installer_source_checksum": installer_source_checksum,
    }
    for field, expected in expected_bindings.items():
        if verification.get(field) != expected:
            raise AssemblyError(
                f"verification evidence {field} must match candidate asset"
            )

    verification_path = output_dir / VERIFICATION_RECORD_NAME
    verification_path.write_bytes(verification_bytes)
    verification_checksum = _sha256(verification_bytes)
    evidence_path = output_dir / EVIDENCE_RECORD_NAME
    evidence_bytes = _write_json(
        evidence_path,
        {
            "assembly_id": assembly_id,
            "asset_checksum": asset_checksum,
            "asset_name": asset_name,
            "builder_identity": BUILDER_IDENTITY,
            "installer_source_checksum": installer_source_checksum,
            "manifest_checksum": manifest_checksum,
            "payload_checksum": candidate.get("payload_checksum"),
            "source_revision": source_revision,
            "verification_result": {
                **expected_bindings,
                "evidence_checksum": f"sha256:{verification_checksum}",
                "evidence_file": verification_path.name,
                "status": "passed",
                "suite": suite,
            },
        },
    )
    evidence_checksum = _sha256(evidence_bytes)
    evidence_checksum_path = output_dir / f"{EVIDENCE_RECORD_NAME}.sha256"
    evidence_checksum_path.write_text(
        f"{evidence_checksum}  {evidence_path.name}\n", encoding="utf-8"
    )
    return {
        "asset": asset_path.name,
        "asset_checksum": asset_checksum,
        "evidence": evidence_path.name,
        "evidence_checksum": f"sha256:{evidence_checksum}",
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Assemble an installer candidate and finalize verified evidence."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    assemble_parser = commands.add_parser("assemble")
    assemble_parser.add_argument("--source-dir", type=Path, required=True)
    assemble_parser.add_argument("--manifest", type=Path, required=True)
    assemble_parser.add_argument("--output-dir", type=Path, required=True)
    assemble_parser.add_argument("--asset-name", required=True)
    assemble_parser.add_argument("--source-revision", required=True)
    assemble_parser.add_argument("--assembly-id", required=True)
    finalize_parser = commands.add_parser("finalize")
    finalize_parser.add_argument("--output-dir", type=Path, required=True)
    finalize_parser.add_argument("--verification-evidence", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run candidate assembly or evidence finalization."""
    args = _parser().parse_args(argv)
    try:
        if args.command == "assemble":
            result = assemble_candidate(
                source_dir=args.source_dir,
                manifest_path=args.manifest,
                output_dir=args.output_dir,
                asset_name=args.asset_name,
                source_revision=args.source_revision,
                assembly_id=args.assembly_id,
            )
        else:
            result = finalize_evidence(
                output_dir=args.output_dir,
                verification_evidence_path=args.verification_evidence,
            )
    except (AssemblyError, OSError) as error:
        sys.stderr.write(f"error: {error}\n")
        return 2
    sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
