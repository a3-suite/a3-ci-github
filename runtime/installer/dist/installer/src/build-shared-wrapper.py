"""Assemble a shared POSIX wrapper, then finalize evidence after verification."""

from __future__ import annotations

import argparse
import json
import re
import shlex
import sys
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

from builder_common import (
    AssemblyError,
    _checksum_bytes,
    _read_json_object,
    _read_regular_file,
    _sha256,
    _snapshot_source,
    _source_checksum,
    _write_json,
    _zip_info,
)

BUILDER_IDENTITY = "installer.github-release-native-shared.script-builder.v2"
CANDIDATE_RECORD_NAME = "installer-asset-candidate.json"
VERIFICATION_RECORD_NAME = "installer-verification-evidence.json"
EVIDENCE_RECORD_NAME = "installer-asset-evidence.json"
SOURCE_SNAPSHOT_NAME = ".installer-source.zip"
RUNTIME_VALUES_MARKER = "# __INSTALLER_RUNTIME_VALUES__"
SOURCE_ENTRYPOINT = "install.sh"
SUPPORTED_PLATFORMS = ("linux-x86_64", "macos-arm64")
PLACEHOLDER_PATTERN = re.compile(r"<[^<>]+>")


def _validate_asset_name(asset_name: str) -> None:
    if (
        Path(asset_name).name != asset_name
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.sh", asset_name) is None
    ):
        raise AssemblyError("asset name must be a safe shell script basename")


def _validate_installer_url(url: str, platform: str, installer_name: str) -> None:
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise AssemblyError(f"installer url must be a fixed https url: {platform}")
    if not parsed.path.endswith(f"/{installer_name}"):
        raise AssemblyError(
            f"installer url must end with the installer asset name: {platform}"
        )


def _parse_assignments(values: list[str], label: str) -> dict[str, str]:
    assignments: dict[str, str] = {}
    for value in values:
        key, separator, raw = value.partition("=")
        if not separator or not key or not raw:
            raise AssemblyError(f"{label} must use <platform>=<value>: {value}")
        if key in assignments:
            raise AssemblyError(f"duplicate {label}: {key}")
        assignments[key] = raw
    return assignments


def _platform_prefix(platform: str) -> str:
    return "P_" + platform.replace("-", "_")


def _render_wrapper(source: bytes, entries: list[tuple[str, str, str]]) -> bytes:
    marker = RUNTIME_VALUES_MARKER.encode()
    if source.count(marker) != 1:
        raise AssemblyError("wrapper source must contain one runtime values marker")
    lines: list[str] = []
    for platform, url, checksum in sorted(entries):
        prefix = _platform_prefix(platform)
        lines.append(f"{prefix}_INSTALLER_URL={shlex.quote(url)}")
        lines.append(f"{prefix}_INSTALLER_CHECKSUM={shlex.quote(checksum)}")
    config = "\n".join(lines).encode()
    return source.replace(marker, config.rstrip(b"\n"))


def _validate_platform_installer(
    platform: str, installer_path: Path, installer_url: str
) -> dict[str, str]:
    if platform not in SUPPORTED_PLATFORMS:
        raise AssemblyError(f"unsupported wrapper platform: {platform}")
    if installer_path.suffix != ".sh":
        raise AssemblyError(f"platform installer must be a .sh asset: {platform}")
    installer_name = installer_path.name
    _validate_installer_url(installer_url, platform, installer_name)
    checksum = _sha256(_read_regular_file(installer_path, "platform installer"))
    return {
        "installer_name": installer_name,
        "installer_url": installer_url,
        "installer_checksum": f"sha256:{checksum}",
    }


def assemble_candidate(
    *,
    source_dir: Path,
    installer_paths: dict[str, Path],
    installer_urls: dict[str, str],
    output_dir: Path,
    asset_name: str,
    source_revision: str,
    assembly_id: str,
) -> dict[str, str]:
    """Build a deterministic shared wrapper embedding verified payloads."""
    if output_dir.exists():
        raise AssemblyError(f"output directory already exists: {output_dir}")
    if not output_dir.parent.is_dir():
        raise AssemblyError(
            f"output parent directory does not exist: {output_dir.parent}"
        )
    if set(installer_paths) != set(SUPPORTED_PLATFORMS):
        raise AssemblyError(
            "shared wrapper requires both supported platforms: "
            + ", ".join(SUPPORTED_PLATFORMS)
        )
    if set(installer_urls) != set(SUPPORTED_PLATFORMS):
        raise AssemblyError("installer urls must cover both supported platforms")
    _validate_asset_name(asset_name)

    installers: dict[str, dict[str, str]] = {}
    for platform in SUPPORTED_PLATFORMS:
        installers[platform] = _validate_platform_installer(
            platform, installer_paths[platform], installer_urls[platform]
        )

    snapshot = _snapshot_source(source_dir)
    source_files = {
        path.as_posix(): (payload, mode) for path, payload, mode in snapshot
    }
    if SOURCE_ENTRYPOINT not in source_files:
        raise AssemblyError(f"wrapper source is missing {SOURCE_ENTRYPOINT}")
    entrypoint, _ = source_files[SOURCE_ENTRYPOINT]
    entries = [
        (
            platform,
            data["installer_url"],
            data["installer_checksum"].removeprefix("sha256:"),
        )
        for platform, data in installers.items()
    ]
    wrapper_bytes = _render_wrapper(entrypoint, entries)

    output_dir.mkdir()
    asset_path = output_dir / asset_name
    asset_path.write_bytes(wrapper_bytes)
    asset_path.chmod(0o755)
    with zipfile.ZipFile(output_dir / SOURCE_SNAPSHOT_NAME, mode="x") as archive:
        for relative_path, payload, mode in snapshot:
            archive.writestr(_zip_info(relative_path.as_posix(), mode), payload)

    asset_checksum = _sha256(asset_path.read_bytes())
    (output_dir / f"{asset_name}.sha256").write_bytes(_checksum_bytes(asset_checksum, asset_name))
    candidate_path = output_dir / CANDIDATE_RECORD_NAME
    _write_json(
        candidate_path,
        {
            "assembly_id": assembly_id,
            "asset_checksum": f"sha256:{asset_checksum}",
            "asset_name": asset_name,
            "builder_identity": BUILDER_IDENTITY,
            "platform_installers": installers,
            "source_revision": source_revision,
        },
    )
    return {
        "asset": asset_path.name,
        "asset_checksum": f"sha256:{asset_checksum}",
        "candidate": candidate_path.name,
    }


def _read_snapshot_entrypoint(output_dir: Path) -> tuple[bytes, str]:
    try:
        with zipfile.ZipFile(output_dir / SOURCE_SNAPSHOT_NAME) as archive:
            names = [entry.filename for entry in archive.infolist()]
            if len(names) != len(set(names)):
                raise AssemblyError("source snapshot contains duplicate entries")
            payload = archive.read(SOURCE_ENTRYPOINT)
    except (KeyError, zipfile.BadZipFile) as error:
        raise AssemblyError(
            "candidate source snapshot must be a readable ZIP"
        ) from error
    return payload, _source_checksum_from_zip(output_dir / SOURCE_SNAPSHOT_NAME)


def _source_checksum_from_zip(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        snapshot = []
        for entry in sorted(archive.infolist(), key=lambda item: item.filename):
            relative_name = entry.filename
            if (
                not relative_name
                or PurePosixPath(relative_name).is_absolute()
                or ".." in PurePosixPath(relative_name).parts
            ):
                raise AssemblyError("source snapshot contains an unsafe path")
            mode = 0o755 if ((entry.external_attr >> 16) & 0o111) else 0o644
            snapshot.append((PurePosixPath(relative_name), archive.read(entry), mode))
    return _source_checksum(snapshot)


def finalize_evidence(
    *, output_dir: Path, verification_evidence_path: Path
) -> dict[str, str]:
    """Finalize evidence after verification of the exact candidate wrapper."""
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
    if candidate.get("builder_identity") != BUILDER_IDENTITY:
        raise AssemblyError("candidate builder identity mismatch")
    asset_name = candidate.get("asset_name")
    asset_checksum = candidate.get("asset_checksum")
    source_revision = candidate.get("source_revision")
    assembly_id = candidate.get("assembly_id")
    if (
        not isinstance(asset_name, str)
        or not asset_name
        or not isinstance(asset_checksum, str)
        or not asset_checksum
        or not isinstance(source_revision, str)
        or not source_revision
        or not isinstance(assembly_id, str)
        or not assembly_id
    ):
        raise AssemblyError("candidate record is incomplete")
    _validate_asset_name(asset_name)
    installers = candidate.get("platform_installers")
    if not isinstance(installers, dict) or set(installers) != set(SUPPORTED_PLATFORMS):
        raise AssemblyError("candidate record must list both platform installers")

    asset_path = output_dir / asset_name
    asset_bytes = _read_regular_file(asset_path, "candidate wrapper")
    if f"sha256:{_sha256(asset_bytes)}" != asset_checksum:
        raise AssemblyError("candidate wrapper checksum mismatch")

    entrypoint, _ = _read_snapshot_entrypoint(output_dir)
    entries: list[tuple[str, str, str]] = []
    for platform, data in installers.items():
        if not isinstance(data, dict):
            raise AssemblyError("candidate platform installer entry is invalid")
        url = data.get("installer_url")
        checksum = data.get("installer_checksum")
        name = data.get("installer_name")
        if (
            not isinstance(url, str)
            or not url
            or not isinstance(checksum, str)
            or not checksum
            or not isinstance(name, str)
            or not name
        ):
            raise AssemblyError("candidate platform installer entry is incomplete")
        _validate_installer_url(url, platform, name)
        if not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", checksum):
            raise AssemblyError("candidate platform installer checksum is invalid")
        entries.append((platform, url, checksum.removeprefix("sha256:")))
    if _render_wrapper(entrypoint, entries) != asset_bytes:
        raise AssemblyError("candidate wrapper does not match source and payloads")

    verification_bytes, verification = _read_json_object(
        verification_evidence_path, "post-assembly verification evidence"
    )
    if verification.get("status") != "passed":
        raise AssemblyError("verification evidence status must be passed")
    suite = verification.get("suite")
    if not isinstance(suite, str) or not suite:
        raise AssemblyError("verification evidence suite is required")
    if verification.get("wrapper_checksum") != asset_checksum:
        raise AssemblyError("verification evidence wrapper checksum mismatch")
    if verification.get("source_revision") != source_revision:
        raise AssemblyError("verification evidence source revision mismatch")
    expected_checksums = {
        platform: data["installer_checksum"] for platform, data in installers.items()
    }
    if verification.get("platform_installer_checksums") != expected_checksums:
        raise AssemblyError("verification evidence platform checksum mismatch")

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
            "platform_installers": installers,
            "source_revision": source_revision,
            "verification_result": {
                "evidence_checksum": f"sha256:{verification_checksum}",
                "evidence_file": verification_path.name,
                "platform_installer_checksums": expected_checksums,
                "source_revision": source_revision,
                "status": "passed",
                "suite": suite,
                "wrapper_checksum": asset_checksum,
            },
        },
    )
    evidence_checksum = _sha256(evidence_bytes)
    (output_dir / f"{EVIDENCE_RECORD_NAME}.sha256").write_bytes(_checksum_bytes(evidence_checksum, evidence_path.name))
    return {
        "asset": asset_path.name,
        "asset_checksum": asset_checksum,
        "evidence": evidence_path.name,
        "evidence_checksum": f"sha256:{evidence_checksum}",
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Assemble a shared POSIX wrapper and finalize verified evidence."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    assemble_parser = commands.add_parser("assemble")
    assemble_parser.add_argument("--source-dir", type=Path, required=True)
    assemble_parser.add_argument("--output-dir", type=Path, required=True)
    assemble_parser.add_argument("--asset-name", required=True)
    assemble_parser.add_argument("--source-revision", required=True)
    assemble_parser.add_argument("--assembly-id", required=True)
    assemble_parser.add_argument(
        "--platform-installer",
        action="append",
        default=[],
        help="<platform>=<path> for a verified platform installer payload",
    )
    assemble_parser.add_argument(
        "--installer-url",
        action="append",
        default=[],
        help="<platform>=<fixed https url> for the published platform installer",
    )
    finalize_parser = commands.add_parser("finalize")
    finalize_parser.add_argument("--output-dir", type=Path, required=True)
    finalize_parser.add_argument("--verification-evidence", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run wrapper assembly or evidence finalization."""
    args = _parser().parse_args(argv)
    try:
        if args.command == "assemble":
            paths = _parse_assignments(args.platform_installer, "platform-installer")
            urls = _parse_assignments(args.installer_url, "installer-url")
            result = assemble_candidate(
                source_dir=args.source_dir,
                installer_paths={key: Path(value) for key, value in paths.items()},
                installer_urls=urls,
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
