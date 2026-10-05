"""Shared helpers for installer assembly builders."""

from __future__ import annotations

import hashlib
import json
import stat
import zipfile
from pathlib import Path, PurePosixPath

FIXED_ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


class AssemblyError(ValueError):
    """Report invalid or unsafe installer assembly input."""


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _normalize_source_bytes(payload: bytes, label: str) -> bytes:
    """Bind assembly inputs to LF line endings so checksums ignore checkout EOL.

    A checkout that converts line endings would otherwise change the source
    snapshot digest, the rendered asset, and the value embedded as the last
    runtime value, which leaves a trailing carriage return in the asset.
    """
    try:
        payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise AssemblyError(f"{label} must be UTF-8 text") from error
    return payload.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def _read_regular_file(path: Path, label: str) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise AssemblyError(f"{label} must be a regular non-symlink file: {path}")
    return path.read_bytes()


def _read_json_object(path: Path, label: str) -> tuple[bytes, dict[str, object]]:
    payload = _read_regular_file(path, label)
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AssemblyError(f"{label} must be a UTF-8 JSON object: {path}") from error
    if not isinstance(value, dict):
        raise AssemblyError(f"{label} must be a JSON object: {path}")
    return payload, value


def _snapshot_source(source_dir: Path) -> list[tuple[PurePosixPath, bytes, int]]:
    if source_dir.is_symlink() or not source_dir.is_dir():
        raise AssemblyError(
            f"installer source must be a non-symlink directory: {source_dir}"
        )

    snapshot: list[tuple[PurePosixPath, bytes, int]] = []
    for path in sorted(
        source_dir.rglob("*"),
        key=lambda item: item.relative_to(source_dir).as_posix(),
    ):
        if path.is_symlink():
            raise AssemblyError(f"installer source must not contain symlinks: {path}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise AssemblyError(f"installer source contains a non-regular file: {path}")
        relative_path = PurePosixPath(path.relative_to(source_dir).as_posix())
        mode = stat.S_IMODE(path.stat().st_mode)
        archive_mode = 0o755 if mode & 0o111 else 0o644
        payload = _normalize_source_bytes(
            path.read_bytes(), f"installer source {relative_path}"
        )
        snapshot.append((relative_path, payload, archive_mode))

    if not snapshot:
        raise AssemblyError("installer source must contain at least one regular file")
    return snapshot


def _source_checksum(snapshot: list[tuple[PurePosixPath, bytes, int]]) -> str:
    digest = hashlib.sha256()
    for relative_path, payload, mode in snapshot:
        digest.update(relative_path.as_posix().encode())
        digest.update(b"\0")
        digest.update(f"{mode:o}".encode())
        digest.update(b"\0")
        digest.update(hashlib.sha256(payload).digest())
    return digest.hexdigest()


def _zip_info(name: str, mode: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, FIXED_ZIP_TIMESTAMP)
    info.create_system = 3
    info.compress_type = zipfile.ZIP_STORED
    info.external_attr = (stat.S_IFREG | mode) << 16
    return info


def _json_bytes(payload: dict[str, object]) -> bytes:
    return (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode()


def _write_json(path: Path, payload: dict[str, object]) -> bytes:
    encoded = _json_bytes(payload)
    path.write_bytes(encoded)
    return encoded
