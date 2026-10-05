"""Verify the provider installer builder without external dependencies."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
import warnings
from pathlib import Path, PurePosixPath

BUNDLE_ROOT = Path(__file__).resolve().parents[1]
BUILDER_PATH = BUNDLE_ROOT / "src/build-installer.py"
MANIFEST_TEMPLATE_PATH = BUNDLE_ROOT.parents[1] / "skills/installer/assets/examples/native-manifest.template.json"
SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567"
# The security gate flags literal user-home paths even in fixtures, so build
# synthetic home roots from path expressions instead of embedding the literals.
HOME_MANAGED_ROOT = str(PurePosixPath("/home") / "operator")
USERS_MANAGED_ROOT = str(PurePosixPath("/Users") / "operator")
USERS_LIBRARY_MANAGED_ROOT = str(
    PurePosixPath("/Users")
    / "operator"
    / "Library"
    / "Application Support"
    / "example-app"
)
MANIFEST_REPLACEMENTS = {
    "<release-version>": "1.0.0",
    "<target-platform-id>": "linux-x86_64",
    "<repository-owner>": "example-org",
    "<repository-name>": "example-app",
    "<release-tag>": "v1.0.0",
    "<fixed-release-asset-url>": (
        "https://github.com/example-org/example-app/releases/download/"
        "v1.0.0/example-app.tar.gz"
    ),
    "<artifact-file-name>": "example-app.tar.gz",
    "<artifact-sha256>": "a" * 64,
    "<managed-root>": "/opt/example-app",
    "<release-path>": "/opt/example-app/releases/1.0.0",
    "<current-link-or-pointer>": "/opt/example-app/current",
    "<activation-strategy>": "active-pointer",
    "<lock-path>": "/opt/example-app/install.lock",
    "<install-state-path>": "/opt/example-app/state/install-state.json",
    "<installer-version>": "1.0.0",
    "<source-commit-sha>": SOURCE_REVISION,
    "<ci-run-or-assembly-id>": "assembly-1",
}


def _temporary_directory() -> tempfile.TemporaryDirectory[str]:
    temp_root = BUNDLE_ROOT / "tests/tmp"
    if temp_root.is_symlink():
        raise RuntimeError("test temporary root must not be a symlink")
    temp_root.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=temp_root)


class BuildInstallerContractTest(unittest.TestCase):
    """Exercise the provider builder through its command-line boundary."""

    def test_builder_assembles_then_finalizes_exact_verified_asset(self) -> None:
        """Bind final evidence to the exact archive verified after assembly."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            source_dir = self._write_source(root)
            manifest_path = self._write_adapted_manifest(root)
            first_output = root / "first"
            second_output = root / "second"

            first_assemble = self._run_assemble(source_dir, manifest_path, first_output)
            second_assemble = self._run_assemble(
                source_dir, manifest_path, second_output
            )

            self.assertEqual(first_assemble.returncode, 0, first_assemble.stderr)
            self.assertEqual(second_assemble.returncode, 0, second_assemble.stderr)
            self.assertFalse((first_output / "installer-asset-evidence.json").exists())
            first_asset = first_output / "example-installer.sh"
            second_asset = second_output / "example-installer.sh"
            first_asset_checksum = hashlib.sha256(first_asset.read_bytes()).hexdigest()
            self.assertEqual(
                first_asset_checksum,
                hashlib.sha256(second_asset.read_bytes()).hexdigest(),
            )
            self.assertIn(b"MANIFEST_URL=", first_asset.read_bytes())
            self.assertIn(
                b"releases/download/v1.0.0/manifest-linux-x86_64.json",
                first_asset.read_bytes(),
            )
            self.assertEqual(
                (first_output / "manifest-linux-x86_64.json").read_bytes(),
                manifest_path.read_bytes(),
            )

            verification_path = self._write_verification(
                root,
                status="passed",
                candidate_path=first_output / "installer-asset-candidate.json",
            )
            finalize_result = self._run_finalize(first_output, verification_path)

            self.assertEqual(finalize_result.returncode, 0, finalize_result.stderr)
            evidence_path = first_output / "installer-asset-evidence.json"
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            expected_asset_checksum = f"sha256:{first_asset_checksum}"
            self.assertEqual(evidence["asset_name"], first_asset.name)
            self.assertEqual(evidence["source_revision"], SOURCE_REVISION)
            self.assertEqual(evidence["asset_checksum"], expected_asset_checksum)
            self.assertEqual(
                (first_output / "example-installer.sh.sha256").read_text(
                    encoding="utf-8"
                ),
                f"{first_asset_checksum}  example-installer.sh\n",
            )
            self.assertEqual(
                evidence["verification_result"]["asset_checksum"],
                expected_asset_checksum,
            )
            self.assertEqual(evidence["verification_result"]["status"], "passed")
            self.assertEqual(
                evidence["verification_result"]["suite"], "project-installer"
            )
            self.assertEqual(
                evidence["installer_source_checksum"],
                evidence["verification_result"]["installer_source_checksum"],
            )
            self.assertEqual(
                evidence["manifest_checksum"],
                evidence["verification_result"]["manifest_checksum"],
            )
            copied_verification = first_output / "installer-verification-evidence.json"
            self.assertEqual(
                copied_verification.read_bytes(), verification_path.read_bytes()
            )
            self.assertEqual(
                evidence["verification_result"]["evidence_file"],
                copied_verification.name,
            )
            self.assertEqual(
                evidence["verification_result"]["evidence_checksum"],
                f"sha256:{hashlib.sha256(verification_path.read_bytes()).hexdigest()}",
            )
            evidence_checksum = hashlib.sha256(evidence_path.read_bytes()).hexdigest()
            self.assertEqual(
                (first_output / "installer-asset-evidence.json.sha256").read_text(
                    encoding="utf-8"
                ),
                f"{evidence_checksum}  installer-asset-evidence.json\n",
            )

    def test_assemble_is_independent_of_source_line_endings(self) -> None:
        """Ignore checkout EOL so evidence stays reproducible across runners."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            lf_root = root / "lf"
            crlf_root = root / "crlf"
            lf_root.mkdir()
            crlf_root.mkdir()
            lf_output = lf_root / "output"
            crlf_output = crlf_root / "output"

            lf_assemble = self._run_assemble(
                self._write_source(lf_root),
                self._write_adapted_manifest(lf_root),
                lf_output,
            )
            crlf_source = self._write_source(crlf_root, crlf=True)
            crlf_manifest = self._write_adapted_manifest(crlf_root, crlf=True)
            self.assertIn(b"\r\n", (crlf_source / "install.sh").read_bytes())
            self.assertIn(b"\r\n", crlf_manifest.read_bytes())
            crlf_assemble = self._run_assemble(crlf_source, crlf_manifest, crlf_output)

            self.assertEqual(lf_assemble.returncode, 0, lf_assemble.stderr)
            self.assertEqual(crlf_assemble.returncode, 0, crlf_assemble.stderr)
            lf_asset = lf_output / "example-installer.sh"
            crlf_asset = crlf_output / "example-installer.sh"
            self.assertNotIn(b"\r", crlf_asset.read_bytes())
            self.assertEqual(lf_asset.read_bytes(), crlf_asset.read_bytes())
            lf_candidate = json.loads(
                (lf_output / "installer-asset-candidate.json").read_text(
                    encoding="utf-8"
                )
            )
            crlf_candidate = json.loads(
                (crlf_output / "installer-asset-candidate.json").read_text(
                    encoding="utf-8"
                )
            )
            for field in (
                "asset_checksum",
                "installer_source_checksum",
                "manifest_checksum",
            ):
                self.assertEqual(lf_candidate[field], crlf_candidate[field], field)
            self.assertEqual(
                (crlf_output / "manifest-linux-x86_64.json").read_bytes(),
                (lf_output / "manifest-linux-x86_64.json").read_bytes(),
            )

            verification_path = self._write_verification(
                root,
                status="passed",
                candidate_path=crlf_output / "installer-asset-candidate.json",
            )
            finalize_result = self._run_finalize(crlf_output, verification_path)

            self.assertEqual(finalize_result.returncode, 0, finalize_result.stderr)
            evidence = json.loads(
                (crlf_output / "installer-asset-evidence.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                evidence["asset_checksum"], crlf_candidate["asset_checksum"]
            )

    def test_assemble_is_independent_of_line_endings_for_windows(self) -> None:
        """Cover the checkout that most often rewrites line endings to CRLF."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            managed_root = "C:\\ProgramData\\example-app"
            lf_root = root / "lf"
            crlf_root = root / "crlf"
            lf_root.mkdir()
            crlf_root.mkdir()
            lf_output = lf_root / "output"
            crlf_output = crlf_root / "output"

            lf_assemble = self._run_assemble(
                self._write_windows_source(lf_root),
                self._write_placement_manifest(lf_root, "windows-x86_64", managed_root),
                lf_output,
            )
            crlf_source = self._write_windows_source(crlf_root, crlf=True)
            self.assertIn(b"\r\n", (crlf_source / "install.ps1").read_bytes())
            crlf_assemble = self._run_assemble(
                crlf_source,
                self._write_placement_manifest(
                    crlf_root, "windows-x86_64", managed_root, crlf=True
                ),
                crlf_output,
            )

            self.assertEqual(lf_assemble.returncode, 0, lf_assemble.stderr)
            self.assertEqual(crlf_assemble.returncode, 0, crlf_assemble.stderr)
            crlf_bytes = (crlf_output / "example-installer.ps1").read_bytes()
            self.assertNotIn(b"\r", crlf_bytes)
            self.assertEqual(
                (lf_output / "example-installer.ps1").read_bytes(), crlf_bytes
            )
            lf_candidate = json.loads(
                (lf_output / "installer-asset-candidate.json").read_text(
                    encoding="utf-8"
                )
            )
            crlf_candidate = json.loads(
                (crlf_output / "installer-asset-candidate.json").read_text(
                    encoding="utf-8"
                )
            )
            for field in (
                "asset_checksum",
                "installer_source_checksum",
                "manifest_checksum",
            ):
                self.assertEqual(lf_candidate[field], crlf_candidate[field], field)

    def test_assemble_rejects_non_utf8_source(self) -> None:
        """Reject binary source instead of silently rewriting its bytes."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            source_dir = self._write_source(root)
            (source_dir / "blob.bin").write_bytes(b"\xff\xfe\x00binary")

            result = self._run_assemble(
                source_dir, self._write_adapted_manifest(root), root / "output"
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("must be UTF-8 text", result.stderr)
            self.assertFalse((root / "output").exists())

    def test_assemble_rejects_unadapted_manifest_template(self) -> None:
        """Keep template placeholders out of release-candidate output."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            result = self._run_assemble(
                self._write_source(root), MANIFEST_TEMPLATE_PATH, root / "output"
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("unresolved template placeholders", result.stderr)
            self.assertFalse((root / "output").exists())

    def test_assemble_rejects_missing_marker_without_output(self) -> None:
        """Reject entrypoints that cannot receive the embedded manifest URL."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            source_dir = self._write_source(root)
            (source_dir / "install.sh").write_text(
                "#!/bin/sh\nexit 0\n", encoding="utf-8"
            )
            result = self._run_assemble(
                source_dir, self._write_adapted_manifest(root), root / "output"
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("runtime values marker", result.stderr)
            self.assertFalse((root / "output").exists())

    def test_assemble_rejects_unsupported_runtime_version(self) -> None:
        """Reject a minimum version newer than the installer entrypoint."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            manifest_path = self._write_adapted_manifest(root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["compatibility"]["requiredInstallerVersion"] = "2.1"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            result = self._run_assemble(
                self._write_source(root), manifest_path, root / "output"
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("required installer version is unsupported", result.stderr)

    def test_assemble_requires_target_platform_entrypoint(self) -> None:
        """Prevent a Windows bundle with no PowerShell installer."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            manifest_path = self._write_adapted_manifest(root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["targetPlatformId"] = "windows-x86_64"
            manifest["artifact"]["fileName"] = "example-app.zip"
            manifest["artifact"]["url"] = (
                "https://github.com/example-org/example-app/releases/download/"
                "v1.0.0/example-app.zip"
            )
            manifest["placement"] = {
                "managedRoot": "C:\\ProgramData\\example-app",
                "releasePath": "C:\\ProgramData\\example-app\\releases\\1.0.0",
                "currentLink": "C:\\ProgramData\\example-app\\current",
            }
            manifest["concurrency"]["lockPath"] = (
                "C:\\ProgramData\\example-app\\install.lock"
            )
            manifest["state"]["installStatePath"] = (
                "C:\\ProgramData\\example-app\\state\\install.state"
            )
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            result = self._run_assemble(
                self._write_source(root), manifest_path, root / "output"
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("target platform entrypoint is missing", result.stderr)

    def test_assemble_rejects_relative_windows_placement(self) -> None:
        """Keep Windows placement independent of the launch directory."""
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root)
            source_dir = self._write_source(root)
            (source_dir / "install.ps1").write_text(
                "# __INSTALLER_RUNTIME_VALUES__\nexit 0\n", encoding="utf-8"
            )
            manifest_path = self._write_adapted_manifest(root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["targetPlatformId"] = "windows-x86_64"
            manifest["artifact"]["fileName"] = "example-app.zip"
            manifest["artifact"]["url"] = (
                "https://github.com/example-org/example-app/releases/download/"
                "v1.0.0/example-app.zip"
            )
            manifest["placement"] = {
                "managedRoot": "managed",
                "releasePath": "managed/releases/1.0.0",
                "currentLink": "managed/current",
            }
            manifest["concurrency"]["lockPath"] = "managed/install.lock"
            manifest["state"]["installStatePath"] = "managed/state/install.state"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            result = self._run_assemble(source_dir, manifest_path, root / "output")

            self.assertEqual(result.returncode, 2)
            self.assertIn("absolute placement path", result.stderr)
            self.assertFalse((root / "output").exists())

            manifest["placement"] = {
                "managedRoot": "C:\\ProgramData\\example-app",
                "releasePath": "C:\\ProgramData\\example-app\\releases\\1.0.0",
                "currentLink": "C:\\ProgramData\\example-app\\current",
            }
            manifest["concurrency"]["lockPath"] = (
                "C:\\ProgramData\\example-app\\install.lock"
            )
            manifest["state"]["installStatePath"] = (
                "C:\\ProgramData\\example-app\\state\\install.state"
            )
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            accepted = self._run_assemble(source_dir, manifest_path, root / "valid")
            self.assertEqual(accepted.returncode, 0, accepted.stderr)

            manifest["state"]["installStatePath"] = (
                "C:\\ProgramData\\example-app\\releases\\1.0.0\\state\\install.state"
            )
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            overlap = self._run_assemble(source_dir, manifest_path, root / "overlap")
            self.assertEqual(overlap.returncode, 2)
            self.assertIn("overlapping placement paths", overlap.stderr)

    def test_assemble_rejects_overlapping_placement_paths(self) -> None:
        """State under a release must not change the release placement target."""
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root)
            source_dir = self._write_source(root)
            manifest_path = self._write_adapted_manifest(root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["state"]["installStatePath"] = (
                "/opt/example-app/releases/1.0.0/state/install.state"
            )
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            result = self._run_assemble(source_dir, manifest_path, root / "output")

            self.assertEqual(result.returncode, 2)
            self.assertIn("overlapping placement paths", result.stderr)
            self.assertFalse((root / "output").exists())

    def test_assemble_rejects_parent_traversal_placement(self) -> None:
        """Do not assemble placement paths that runtime rejects."""
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root)
            manifest_path = self._write_adapted_manifest(root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["placement"]["managedRoot"] = "/opt/my..app/../example-app"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            result = self._run_assemble(
                self._write_source(root), manifest_path, root / "output"
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("parent traversal in placement path", result.stderr)
            self.assertFalse((root / "output").exists())

    def test_assemble_rejects_unnormalized_unix_placement(self) -> None:
        """Keep builder and Unix runtime path interpretation aligned."""
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root)
            source_dir = self._write_source(root)
            manifest_path = self._write_adapted_manifest(root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["placement"]["managedRoot"] = "/opt/example-app/"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            result = self._run_assemble(source_dir, manifest_path, root / "output")

            self.assertEqual(result.returncode, 2)
            self.assertIn("Unix placement paths must be normalized", result.stderr)
            self.assertFalse((root / "output").exists())

    def test_assemble_rejects_unix_filesystem_root(self) -> None:
        """Do not allow the entire filesystem as the managed root."""
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root)
            manifest_path = self._write_adapted_manifest(root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["placement"]["managedRoot"] = "/"
            manifest["placement"]["releasePath"] = "/releases/1.0.0"
            manifest["placement"]["currentLink"] = "/current"
            manifest["concurrency"]["lockPath"] = "/install.lock"
            manifest["state"]["installStatePath"] = "/state/install.state"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            result = self._run_assemble(
                self._write_source(root), manifest_path, root / "output"
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("filesystem root cannot be a managed root", result.stderr)
            self.assertFalse((root / "output").exists())

    def test_assemble_rejects_too_broad_managed_roots(self) -> None:
        """Reject shared or OS-reserved roots beyond the filesystem root."""
        cases = (
            ("linux-x86_64", "/etc"),
            ("linux-x86_64", HOME_MANAGED_ROOT),
            ("linux-x86_64", "/opt"),
            ("linux-x86_64", "/var"),
            ("linux-x86_64", "/var/folders"),
            ("macos-arm64", USERS_MANAGED_ROOT),
            ("macos-arm64", "/Library"),
            ("macos-arm64", "/private/var/folders"),
            ("macos-arm64", "/private/var/tmp"),
            ("windows-x86_64", "C:\\Windows"),
            ("windows-x86_64", "C:\\Users"),
            ("windows-x86_64", "C:\\Users\\operator"),
            ("windows-x86_64", "\\\\server\\share"),
            ("windows-x86_64", "\\\\server\\Windows\\app"),
            ("windows-x86_64", "\\\\server\\Users\\me"),
        )
        for platform_id, managed_root in cases:
            with self.subTest(platform_id=platform_id, managed_root=managed_root), _temporary_directory() as temporary_root:
                root = Path(temporary_root)
                source_dir = self._write_source(root)
                (source_dir / "install.ps1").write_text(
                    "# __INSTALLER_RUNTIME_VALUES__\nexit 0\n", encoding="utf-8"
                )
                manifest_path = self._write_placement_manifest(
                    root, platform_id, managed_root
                )

                result = self._run_assemble(
                    source_dir, manifest_path, root / "output"
                )

                self.assertEqual(result.returncode, 2)
                self.assertIn("managed root is too broad", result.stderr)
                self.assertFalse((root / "output").exists())

    def test_assemble_accepts_app_specific_managed_roots(self) -> None:
        """Allow documented app-specific roots under shared bases."""
        cases = (
            ("linux-x86_64", "/opt/example-app"),
            ("linux-x86_64", "/usr/local/example-app"),
            ("linux-x86_64", "/var/lib/example-app"),
            ("macos-arm64", "/Library/Application Support/example-app"),
            (
                "macos-arm64",
                USERS_LIBRARY_MANAGED_ROOT,
            ),
            ("windows-x86_64", "C:\\ProgramData\\example-app"),
            ("windows-x86_64", "C:\\Program Files\\example-app"),
            ("windows-x86_64", "\\\\server\\share\\example-app"),
        )
        for platform_id, managed_root in cases:
            with self.subTest(platform_id=platform_id, managed_root=managed_root), _temporary_directory() as temporary_root:
                root = Path(temporary_root)
                source_dir = self._write_source(root)
                (source_dir / "install.ps1").write_text(
                    "# __INSTALLER_RUNTIME_VALUES__\nexit 0\n", encoding="utf-8"
                )
                manifest_path = self._write_placement_manifest(
                    root, platform_id, managed_root
                )

                result = self._run_assemble(
                    source_dir, manifest_path, root / "output"
                )

                self.assertEqual(result.returncode, 0, result.stderr)

    def test_assemble_accepts_per_user_profile_and_launcher(self) -> None:
        """Allow home-relative placement with a per-user launcher."""
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root)
            source_dir = self._write_source(root)
            (source_dir / "install.ps1").write_text(
                "# __INSTALLER_RUNTIME_VALUES__\nexit 0\n", encoding="utf-8"
            )

            result = self._run_assemble(
                source_dir,
                self._per_user_manifest(root, "linux-x86_64"),
                root / "output",
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            script = (root / "output" / "example-installer.sh").read_text(
                encoding="utf-8"
            )
            self.assertIn("PROFILE=per-user-cli", script)
            self.assertIn("~/.local/bin/example-app", script)

    def test_assemble_accepts_windows_per_user_profile(self) -> None:
        """Allow %LOCALAPPDATA% placement and launcher on Windows."""
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root)
            source_dir = self._write_source(root)
            (source_dir / "install.ps1").write_text(
                "# __INSTALLER_RUNTIME_VALUES__\nexit 0\n", encoding="utf-8"
            )

            result = self._run_assemble(
                source_dir,
                self._per_user_manifest(root, "windows-x86_64"),
                root / "output",
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            script = (root / "output" / "example-installer.ps1").read_text(
                encoding="utf-8"
            )
            self.assertIn("%LOCALAPPDATA%", script)

    def test_assemble_rejects_launcher_outside_allowed_base(self) -> None:
        """Keep the launcher under the profile's launcher base."""
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root)
            manifest_path = self._per_user_manifest(root, "linux-x86_64")
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["activation"]["launcherPath"] = "~/.local/lib/example-app"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            result = self._run_assemble(
                self._write_source(root), manifest_path, root / "output"
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("launcher path must stay under", result.stderr)

    def test_assemble_accepts_system_wide_launcher(self) -> None:
        """Allow a system-wide absolute launcher under the system base."""
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root)
            source_dir = self._write_source(root)
            (source_dir / "install.ps1").write_text(
                "# __INSTALLER_RUNTIME_VALUES__\nexit 0\n", encoding="utf-8"
            )
            manifest_path = self._write_adapted_manifest(root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["placement"]["profile"] = "system-wide"
            manifest["activation"]["launcherPath"] = "/usr/local/bin/example-app"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            result = self._run_assemble(source_dir, manifest_path, root / "output")

            self.assertEqual(result.returncode, 0, result.stderr)
            script = (root / "output" / "example-installer.sh").read_text(
                encoding="utf-8"
            )
            self.assertIn("/usr/local/bin/example-app", script)

    def test_assemble_accepts_windows_system_wide_absolute_launcher(self) -> None:
        """Assembly must not assume the target host's ProgramFiles location."""
        for launcher in (
            "C:\\Program Files\\example-app.exe",
            "D:\\Apps\\example-app.exe",
        ):
            with self.subTest(launcher=launcher), _temporary_directory() as temp:
                root = Path(temp)
                manifest_path = self._write_placement_manifest(
                    root, "windows-x86_64", "C:\\ProgramData\\example-app"
                )
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                manifest["placement"]["profile"] = "system-wide"
                manifest["activation"]["launcherPath"] = launcher
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                result = self._run_assemble(
                    self._write_windows_source(root), manifest_path, root / "output"
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_assemble_rejects_windows_system_wide_relative_launcher(self) -> None:
        """Reject both plain relative and drive-relative launcher paths."""
        for launcher in ("example-app.exe", "C:example-app.exe"):
            with self.subTest(launcher=launcher), _temporary_directory() as temp:
                root = Path(temp)
                manifest_path = self._write_placement_manifest(
                    root, "windows-x86_64", "C:\\ProgramData\\example-app"
                )
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                manifest["placement"]["profile"] = "system-wide"
                manifest["activation"]["launcherPath"] = launcher
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                output = root / "output"
                result = self._run_assemble(
                    self._write_windows_source(root), manifest_path, output
                )
                self.assertEqual(result.returncode, 2)
                self.assertIn("launcher path must be absolute", result.stderr)
                self.assertFalse(output.exists())

    def test_assemble_rejects_launcher_parent_traversal(self) -> None:
        """Reject empty and relative launcher components before assembly."""
        cases = (
            ("linux-x86_64", False, "~/.local/bin/../../../evil"),
            ("linux-x86_64", False, "~/.local/bin/./evil"),
            ("linux-x86_64", False, "~/.local/bin//evil"),
            ("linux-x86_64", True, "/usr/local/bin/./example-app"),
            ("linux-x86_64", True, "/usr/local/bin//example-app"),
            ("windows-x86_64", False, "%LOCALAPPDATA%\\Programs\\..\\evil.exe"),
            ("windows-x86_64", False, "%LOCALAPPDATA%\\Programs\\\\evil.exe"),
        )
        for platform_id, system_wide, launcher in cases:
            with self.subTest(
                platform_id=platform_id, system_wide=system_wide, launcher=launcher
            ), _temporary_directory() as temporary_root:
                root = Path(temporary_root)
                source_dir = self._write_source(root)
                (source_dir / "install.ps1").write_text(
                    "# __INSTALLER_RUNTIME_VALUES__\nexit 0\n", encoding="utf-8"
                )
                if system_wide:
                    manifest_path = self._write_adapted_manifest(root)
                else:
                    manifest_path = self._per_user_manifest(root, platform_id)
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                if system_wide:
                    manifest["placement"]["profile"] = "system-wide"
                manifest["activation"]["launcherPath"] = launcher
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

                result = self._run_assemble(
                    source_dir, manifest_path, root / "output"
                )

                self.assertEqual(result.returncode, 2)
                self.assertIn("launcher path must not contain", result.stderr)
                self.assertFalse((root / "output").exists())

    def test_assemble_rejects_managed_root_outside_per_user_base(self) -> None:
        """Keep per-user managed roots under the platform data base."""
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root)
            manifest_path = self._per_user_manifest(root, "linux-x86_64")
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["placement"]["managedRoot"] = "~/.foo/example-app"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            result = self._run_assemble(
                self._write_source(root), manifest_path, root / "output"
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("per-user data base", result.stderr)

    def _per_user_manifest(self, root: Path, platform_id: str) -> Path:
        manifest_path = self._write_adapted_manifest(root)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["targetPlatformId"] = platform_id
        if platform_id == "windows-x86_64":
            manifest["artifact"] = {
                "url": (
                    "https://github.com/example-org/example-app/releases/download/"
                    "v1.0.0/example-app.zip"
                ),
                "fileName": "example-app.zip",
                "checksum": "sha256:" + "a" * 64,
            }
            manifest["placement"] = {
                "profile": "per-user-cli",
                "channel": "standalone",
                "managedRoot": (
                    "%LOCALAPPDATA%\\example-vendor\\example-app\\standalone"
                ),
                "releasePath": (
                    "%LOCALAPPDATA%\\example-vendor\\example-app\\standalone"
                    "\\releases\\1.0.0"
                ),
                "currentLink": (
                    "%LOCALAPPDATA%\\example-vendor\\example-app\\standalone\\current"
                ),
            }
            manifest["activation"] = {
                "strategy": "active-pointer",
                "launcherPath": (
                    "%LOCALAPPDATA%\\Programs\\example-vendor\\example-app"
                    "\\bin\\example-app.exe"
                ),
            }
            manifest["concurrency"] = {
                "lockPath": (
                    "%LOCALAPPDATA%\\example-vendor\\example-app\\standalone"
                    "\\install.lock"
                )
            }
            manifest["state"] = {
                "installStatePath": (
                    "%LOCALAPPDATA%\\example-vendor\\example-app\\standalone"
                    "\\state\\install.state"
                )
            }
        else:
            manifest["placement"] = {
                "profile": "per-user-cli",
                "channel": "standalone",
                "managedRoot": "~/.local/share/example-vendor/example-app/standalone",
                "releasePath": (
                    "~/.local/share/example-vendor/example-app/standalone/releases/1.0.0"
                ),
                "currentLink": (
                    "~/.local/share/example-vendor/example-app/standalone/current"
                ),
            }
            manifest["activation"] = {
                "strategy": "active-pointer",
                "launcherPath": "~/.local/bin/example-app",
            }
            manifest["concurrency"] = {
                "lockPath": (
                    "~/.local/share/example-vendor/example-app/standalone/install.lock"
                )
            }
            manifest["state"] = {
                "installStatePath": (
                    "~/.local/share/example-vendor/example-app/standalone/state"
                    "/install.state"
                )
            }
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return manifest_path

    def test_finalize_rejects_failed_post_assembly_verification(self) -> None:
        """Do not finalize evidence from failed exact-asset verification."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            output_dir = self._assemble_candidate(root)
            verification_path = self._write_verification(
                root,
                status="failed",
                candidate_path=output_dir / "installer-asset-candidate.json",
            )

            result = self._run_finalize(output_dir, verification_path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("status must be passed", result.stderr)
            self.assertFalse((output_dir / "installer-asset-evidence.json").exists())

    def test_finalize_rejects_verification_without_asset_checksum(self) -> None:
        """Require post-assembly evidence to identify the verified archive."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            output_dir = self._assemble_candidate(root)
            verification_path = self._write_verification(
                root,
                status="passed",
                candidate_path=output_dir / "installer-asset-candidate.json",
            )
            verification = json.loads(verification_path.read_text(encoding="utf-8"))
            del verification["asset_checksum"]
            verification_path.write_text(json.dumps(verification), encoding="utf-8")

            result = self._run_finalize(output_dir, verification_path)

            self.assertEqual(result.returncode, 2)
            self.assertIn(
                "verification evidence asset_checksum must match candidate asset",
                result.stderr,
            )

    def test_finalize_rejects_verification_for_different_candidate(self) -> None:
        """Reject every verification binding that differs from the candidate."""
        fields = (
            "asset_checksum",
            "source_revision",
            "manifest_checksum",
            "installer_source_checksum",
        )
        for field in fields:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                output_dir = self._assemble_candidate(root)
                verification_path = self._write_verification(
                    root,
                    status="passed",
                    candidate_path=output_dir / "installer-asset-candidate.json",
                )
                verification = json.loads(verification_path.read_text(encoding="utf-8"))
                verification[field] = f"different-{field}"
                verification_path.write_text(json.dumps(verification), encoding="utf-8")

                result = self._run_finalize(output_dir, verification_path)

                self.assertEqual(result.returncode, 2)
                self.assertIn(
                    f"verification evidence {field} must match candidate asset",
                    result.stderr,
                )

    def test_finalize_rejects_candidate_changed_after_verification(self) -> None:
        """Reject mutation between exact-asset verification and finalization."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            output_dir = self._assemble_candidate(root)
            verification_path = self._write_verification(
                root,
                status="passed",
                candidate_path=output_dir / "installer-asset-candidate.json",
            )
            with (output_dir / "example-installer.sh").open("ab") as asset:
                asset.write(b"changed-after-verification")

            result = self._run_finalize(output_dir, verification_path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("candidate asset checksum mismatch", result.stderr)
            self.assertFalse((output_dir / "installer-asset-evidence.json").exists())

    def test_assemble_rejects_manifest_source_and_host_drift(self) -> None:
        """Reject provenance or download-host drift before creating output."""
        for field in ("sourceCommit", "artifactHost"):
            with self.subTest(field=field), _temporary_directory() as temp:
                root = Path(temp)
                manifest_path = self._write_adapted_manifest(root)
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                if field == "sourceCommit":
                    manifest["provenance"]["sourceCommit"] = "b" * 40
                else:
                    manifest["artifact"]["url"] = manifest["artifact"]["url"].replace(
                        "github.com", "example.invalid"
                    )
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                output = root / "output"

                result = self._run_assemble(
                    self._write_source(root), manifest_path, output
                )

                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(
                    "source revision must match"
                    if field == "sourceCommit"
                    else "artifact URL must match fixed GitHub Release identity",
                    result.stderr,
                )
                self.assertFalse(output.exists())

    def test_finalize_rejects_source_snapshot_mutation(self) -> None:
        """Bind final evidence to source bytes as well as the built asset."""
        with _temporary_directory() as temp:
            root = Path(temp)
            output = self._assemble_candidate(root)
            verification = self._write_verification(
                root,
                status="passed",
                candidate_path=output / "installer-asset-candidate.json",
            )
            snapshot = output / ".installer-source.zip"
            with zipfile.ZipFile(snapshot) as archive:
                entries = [
                    (info, archive.read(info.filename)) for info in archive.infolist()
                ]
            with zipfile.ZipFile(snapshot, "w") as archive:
                for index, (info, content) in enumerate(entries):
                    archive.writestr(
                        info, content + b"changed" if index == 0 else content
                    )

            result = self._run_finalize(output, verification)

            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("candidate installer source checksum mismatch", result.stderr)
            self.assertFalse((output / "installer-asset-evidence.json").exists())

    def test_assemble_does_not_overwrite_existing_output(self) -> None:
        """Keep reruns from replacing an existing candidate handoff."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            output_dir = root / "output"
            output_dir.mkdir()
            sentinel = output_dir / "sentinel"
            sentinel.write_text("preserve\n", encoding="utf-8")

            result = self._run_assemble(
                self._write_source(root), self._write_adapted_manifest(root), output_dir
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("already exists", result.stderr)
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve\n")

    def test_finalize_does_not_overwrite_existing_evidence(self) -> None:
        """Keep reruns from replacing an accepted final evidence record."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            output_dir = self._assemble_candidate(root)
            evidence_path = output_dir / "installer-asset-evidence.json"
            evidence_path.write_text("preserve\n", encoding="utf-8")
            verification_path = self._write_verification(
                root,
                status="passed",
                candidate_path=output_dir / "installer-asset-candidate.json",
            )

            result = self._run_finalize(output_dir, verification_path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("final evidence output already exists", result.stderr)
            self.assertEqual(evidence_path.read_text(encoding="utf-8"), "preserve\n")

    def test_assemble_rejects_invalid_manifest_fields_without_output(self) -> None:
        """Unsafe publication identity and placement fail before candidate creation."""
        cases = [
            ("schemaVersion", "unsupported", "schema version"),
            ("source", [], "JSON object"),
            ("source.extra", True, "nested manifest fields"),
            ("releaseVersion", "", "non-empty string"),
            ("releaseVersion", "bad/version", "release version is unsafe"),
            ("releaseVersion", "bad\nversion", "control characters"),
            ("targetPlatformId", "linux-arm64", "unsupported target platform"),
            ("placement.profile", "unknown", "placement profile"),
            ("placement.channel", "bad/channel", "placement channel"),
            ("activation.strategy", "unknown", "active-pointer only"),
            ("source.kind", "local", "active-pointer only"),
            ("source.fixedReference", "latest", "unsafe FIXED_REFERENCE"),
            ("source.owner", "bad/owner", "source identity"),
            ("source.repository", "bad/repository", "source identity"),
            ("compatibility.requiredInstallerVersion", "bad", "version is unsupported"),
            ("placement.currentLink", "/opt/other/current", "escapes managed root"),
            ("artifact.url", "https://example.invalid/tool.tar.gz", "artifact URL"),
            ("artifact.fileName", "tool.zip", "archive type"),
            ("artifact.checksum", "sha256:bad", "checksum must be SHA256"),
            ("compatibility.requiredInstallerVersion", "2.1", "version is unsupported"),
            ("provenance.sourceTag", "v2.0.0", "source tag"),
            ("provenance.ciRunId", "other", "assembly id"),
            ("activation.launcherPath", "/opt/example-app/launcher", "per-user launcher base"),
        ]
        for field, value, message in cases:
            with self.subTest(field=field), _temporary_directory() as temporary:
                root = Path(temporary)
                manifest_path = self._write_adapted_manifest(root)
                manifest = json.loads(manifest_path.read_text())
                container = manifest
                parts = field.split(".")
                for part in parts[:-1]:
                    container = container[part]
                container[parts[-1]] = value
                if field == "artifact.fileName":
                    manifest["artifact"]["url"] = manifest["artifact"]["url"].replace("example-app.tar.gz", value)
                manifest_path.write_text(json.dumps(manifest))
                output = root / "output"
                result = self._run_assemble(self._write_source(root), manifest_path, output)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(message, result.stderr)
                self.assertFalse(output.exists())

    def test_assemble_rejects_unreadable_manifest_and_source(self) -> None:
        """Bad input resources cannot produce a candidate."""
        for kind in ["json-syntax", "json-array", "source-missing", "source-empty", "generated-values", "parent-missing", "asset-name"]:
            with self.subTest(kind=kind), _temporary_directory() as temporary:
                root = Path(temporary)
                source = self._write_source(root)
                manifest = self._write_adapted_manifest(root)
                output = root / "output"
                if kind.startswith("json-"):
                    manifest.write_text("{" if kind == "json-syntax" else "[]")
                elif kind == "source-missing":
                    source = root / "missing"
                elif kind == "source-empty":
                    source = root / "empty"
                    source.mkdir()
                elif kind == "generated-values":
                    (source / "runtime-values.sh").write_text("unexpected")
                elif kind == "parent-missing":
                    output = root / "missing/output"
                result = self._run_assemble(source, manifest, output, asset_name="../unsafe.sh" if kind == "asset-name" else "example-installer.sh")
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(output.exists())

    def test_finalize_rejects_invalid_identity_and_snapshot_without_evidence(self) -> None:
        """Finalize validates transported identity and ZIP contents before writing proof."""
        cases = ["manifest_name", "builder_identity", "manifest_checksum", "installer_source_checksum", "empty-zip", "unsafe-zip", "broken-zip", "missing-entrypoint", "suite", "missing-output", "duplicate-zip", "platform-name"]
        for kind in cases:
            with self.subTest(kind=kind), _temporary_directory() as temporary:
                root = Path(temporary)
                output = self._assemble_candidate(root)
                record_path = output / "installer-asset-candidate.json"
                verification = self._write_verification(root, status="passed", candidate_path=record_path)
                if kind == "missing-output":
                    pass
                elif kind == "suite":
                    data = json.loads(verification.read_text())
                    data["suite"] = ""
                    verification.write_text(json.dumps(data))
                elif kind == "platform-name":
                    renamed = output / "manifest-macos-arm64.json"
                    (output / "manifest-linux-x86_64.json").rename(renamed)
                    data = json.loads(record_path.read_text())
                    data["manifest_name"] = renamed.name
                    record_path.write_text(json.dumps(data))
                elif kind.endswith("zip") or kind == "missing-entrypoint":
                    snapshot = output / ".installer-source.zip"
                    if kind == "broken-zip":
                        snapshot.write_bytes(b"not a ZIP")
                    else:
                        with warnings.catch_warnings(), zipfile.ZipFile(snapshot, "w") as archive:
                            warnings.filterwarnings("ignore", message="Duplicate name")
                            if kind == "duplicate-zip":
                                archive.writestr("install.sh", b"first")
                                archive.writestr("install.sh", b"second")
                            elif kind == "unsafe-zip":
                                archive.writestr("../install.sh", b"unsafe")
                            elif kind == "missing-entrypoint":
                                archive.writestr("other.sh", b"safe")
                else:
                    data = json.loads(record_path.read_text())
                    data[kind] = "other" if kind in {"manifest_name", "builder_identity"} else "sha256:" + "0" * 64
                    record_path.write_text(json.dumps(data))
                result = self._run_finalize(root / "missing" if kind == "missing-output" else output, verification)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse((output / "installer-asset-evidence.json").exists())
                self.assertFalse((output / "installer-verification-evidence.json").exists())

    def test_assemble_rejects_placeholder_and_launcher_boundary_drift(self) -> None:
        """Validate target path conventions without requiring that target OS."""
        cases = [
            ("linux-x86_64", "~/.local/share/example-app", "placement.profile", "system-wide", "only allowed for per-user-cli"),
            ("linux-x86_64", "~/.local/share/example-app", "placement.currentLink", "~/outside/current", "escapes managed root"),
            ("linux-x86_64", "~/.local/share/example-app", "placement.currentLink", "~/.local/share/example-app/releases", "overlapping placement"),
            ("linux-x86_64", "~/.local/share/example-app", "placement.managedRoot", "~/.local/share/../example-app", "invalid managed root"),
            ("linux-x86_64", "~/.local/share/example-app", "activation.launcherPath", "~/.local/other/tool", "under ~/.local/bin"),
            ("windows-x86_64", "%LOCALAPPDATA%\\example-app", "placement.currentLink", "%USERPROFILE%\\example-app\\current", "same placeholder style"),
            ("windows-x86_64", "%LOCALAPPDATA%\\example-app", "activation.launcherPath", "%LOCALAPPDATA%\\Other\\tool.exe", "under %LOCALAPPDATA%"),
            ("windows-x86_64", "%USERPROFILE%\\example-app", "placement.profile", "per-user-cli", "per-user base"),
            ("windows-x86_64", "~/.local/share/example-app", "placement.profile", "per-user-cli", "unsupported target platform"),
            ("linux-x86_64", "/opt/example-app", "activation.launcherPath", "/opt/launcher", "under /usr/local/bin"),
            ("linux-x86_64", "/opt/example-app", "activation.launcherPath", "~/.local/bin/tool", "same path style"),
            ("linux-x86_64", "/usr/local/bin/example-app", "activation.launcherPath", "/usr/local/bin/example-app/tool", "outside the managed root"),
            ("windows-x86_64", "%LOCALAPPDATA%\\Programs\\example-app", "activation.launcherPath", "%LOCALAPPDATA%\\Programs\\example-app\\tool.exe", "outside the managed root"),
            ("linux-x86_64", "/opt/example-app", "placement.currentLink", "~/.local/share/example-app/current", "same path style"),
            ("linux-x86_64", "/etc/example-app", "placement.profile", "system-wide", "too broad"),
            ("linux-x86_64", "/private/example-app", "placement.profile", "system-wide", "too broad"),
            ("windows-x86_64", "%LOCALAPPDATA%bad", "placement.profile", "per-user-cli", "absolute placement path"),
            ("windows-x86_64", "C:\\apps\\example-app", "activation.launcherPath", "relative\\tool.exe", "must be absolute"),
        ]
        for target, managed, field, value, message in cases:
            with self.subTest(target=target, field=field), _temporary_directory() as temporary:
                root = Path(temporary)
                manifest_path = self._write_placement_manifest(root, target, managed)
                data = json.loads(manifest_path.read_text())
                if managed.startswith(("/", "C:")):
                    data["placement"]["profile"] = "system-wide"
                section, key = field.split(".")
                data[section][key] = value
                manifest_path.write_text(json.dumps(data))
                source = self._write_windows_source(root) if target.startswith("windows") else self._write_source(root)
                result = self._run_assemble(source, manifest_path, root / "output")
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(message, result.stderr)
                self.assertFalse((root / "output").exists())

    def test_assemble_accepts_app_specific_private_tmp_root(self) -> None:
        with _temporary_directory() as temporary:
            root = Path(temporary)
            manifest = self._write_placement_manifest(root, "linux-x86_64", "/private/tmp/example-app")
            result = self._run_assemble(self._write_source(root), manifest, root / "output")
            self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipIf(sys.platform == "win32", "Unix filesystem resource fixture")
    def test_assemble_rejects_symlink_and_nonregular_source(self) -> None:
        """Source ownership excludes links and device-like resource entries."""
        import os
        for kind in ["manifest-link", "source-link", "fifo"]:
            with self.subTest(kind=kind), _temporary_directory() as temporary:
                root = Path(temporary)
                source = self._write_source(root)
                manifest = self._write_adapted_manifest(root)
                if kind == "manifest-link":
                    link = root / "linked.json"
                    link.symlink_to(manifest)
                    manifest = link
                elif kind == "source-link":
                    (source / "link.sh").symlink_to(source / "install.sh")
                else:
                    os.mkfifo(source / "pipe")
                result = self._run_assemble(source, manifest, root / "output", asset_name="example-installer.sh")
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse((root / "output").exists())

    def _assemble_candidate(self, root: Path) -> Path:
        output_dir = root / "output"
        result = self._run_assemble(
            self._write_source(root), self._write_adapted_manifest(root), output_dir
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return output_dir

    def _write_source(self, root: Path, *, crlf: bool = False) -> Path:
        source_dir = root / "source"
        source_dir.mkdir()
        entrypoint = source_dir / "install.sh"
        self._write_text_bytes(
            entrypoint, "#!/bin/sh\n# __INSTALLER_RUNTIME_VALUES__\nexit 0\n", crlf
        )
        entrypoint.chmod(0o755)
        nested_source = source_dir / "a" / "x.py"
        nested_source.parent.mkdir()
        self._write_text_bytes(nested_source, "print('nested')\n", crlf)
        self._write_text_bytes(source_dir / "a.py", "print('flat')\n", crlf)
        return source_dir

    @staticmethod
    def _write_text_bytes(path: Path, text: str, crlf: bool) -> None:
        """Write an explicit line ending so the case is platform independent."""
        payload = text.replace("\n", "\r\n") if crlf else text
        path.write_bytes(payload.encode("utf-8"))

    def _write_adapted_manifest(self, root: Path, *, crlf: bool = False) -> Path:
        manifest_text = MANIFEST_TEMPLATE_PATH.read_text(encoding="utf-8")
        for placeholder, replacement in MANIFEST_REPLACEMENTS.items():
            manifest_text = manifest_text.replace(placeholder, replacement)
        manifest_path = root / "manifest.json"
        self._write_text_bytes(manifest_path, manifest_text, crlf)
        return manifest_path

    def _write_placement_manifest(
        self, root: Path, platform_id: str, managed_root: str, *, crlf: bool = False
    ) -> Path:
        manifest_path = self._write_adapted_manifest(root)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["targetPlatformId"] = platform_id
        separator = "\\" if platform_id == "windows-x86_64" else "/"
        if platform_id == "windows-x86_64":
            manifest["artifact"]["fileName"] = "example-app.zip"
            manifest["artifact"]["url"] = (
                "https://github.com/example-org/example-app/releases/"
                "download/v1.0.0/example-app.zip"
            )
        manifest["placement"] = {
            "managedRoot": managed_root,
            "releasePath": f"{managed_root}{separator}releases{separator}1.0.0",
            "currentLink": f"{managed_root}{separator}current",
        }
        manifest["concurrency"]["lockPath"] = f"{managed_root}{separator}install.lock"
        manifest["state"]["installStatePath"] = (
            f"{managed_root}{separator}state{separator}install.state"
        )
        self._write_text_bytes(manifest_path, json.dumps(manifest), crlf)
        return manifest_path

    def _write_windows_source(self, root: Path, *, crlf: bool = False) -> Path:
        source_dir = root / "source"
        source_dir.mkdir()
        self._write_text_bytes(
            source_dir / "install.ps1",
            "# __INSTALLER_RUNTIME_VALUES__\nWrite-Output 'ok'\n",
            crlf,
        )
        return source_dir

    def _write_verification(
        self,
        root: Path,
        *,
        status: str,
        candidate_path: Path,
    ) -> Path:
        candidate = json.loads(candidate_path.read_text(encoding="utf-8"))
        verification_path = root / f"verification-{status}.json"
        verification_path.write_text(
            json.dumps(
                {
                    "asset_checksum": candidate["asset_checksum"],
                    "installer_source_checksum": (
                        candidate["installer_source_checksum"]
                    ),
                    "manifest_checksum": candidate["manifest_checksum"],
                    "source_revision": candidate["source_revision"],
                    "status": status,
                    "suite": "project-installer",
                },
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        return verification_path

    def _run_assemble(
        self,
        source_dir: Path,
        manifest_path: Path,
        output_dir: Path,
        *,
        asset_name: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        if asset_name is None:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            asset_name = (
                "example-installer.ps1"
                if manifest.get("targetPlatformId") == "windows-x86_64"
                else "example-installer.sh"
            )
        return subprocess.run(
            [
                sys.executable,
                str(BUILDER_PATH),
                "assemble",
                "--source-dir",
                str(source_dir),
                "--manifest",
                str(manifest_path),
                "--output-dir",
                str(output_dir),
                "--asset-name",
                asset_name,
                "--source-revision",
                SOURCE_REVISION,
                "--assembly-id",
                "assembly-1",
            ],
            cwd=BUNDLE_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )

    def _run_finalize(
        self,
        output_dir: Path,
        verification_path: Path,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(BUILDER_PATH),
                "finalize",
                "--output-dir",
                str(output_dir),
                "--verification-evidence",
                str(verification_path),
            ],
            cwd=BUNDLE_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )


if __name__ == "__main__":
    unittest.main()
