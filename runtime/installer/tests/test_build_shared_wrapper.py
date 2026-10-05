"""Verify the provider shared wrapper builder without external dependencies."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
import warnings
from pathlib import Path

BUNDLE_ROOT = Path(__file__).resolve().parents[1]
BUILDER_PATH = BUNDLE_ROOT / "src/build-shared-wrapper.py"
SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567"
PLATFORMS = ("linux-x86_64", "macos-arm64")


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class BuildSharedWrapperContractTest(unittest.TestCase):
    """Exercise the provider builder through its command-line boundary."""

    def test_builder_embeds_verified_payloads_and_finalizes_evidence(self) -> None:
        """Bind evidence to the exact wrapper and payload checksums."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            source_dir = self._write_source(root)
            installers = self._write_installers(root)
            output_dir = root / "output"

            assembled = self._run_assemble(source_dir, installers, output_dir)

            self.assertEqual(assembled.returncode, 0, assembled.stderr)
            script = (output_dir / "install.sh").read_text(encoding="utf-8")
            for platform in PLATFORMS:
                self.assertIn(self._url(platform), script)
                self.assertIn(_sha(installers[platform]), script)
            self.assertFalse((output_dir / "installer-asset-evidence.json").exists())

            verification_path = self._write_verification(root, output_dir)
            finalized = self._run_finalize(output_dir, verification_path)

            self.assertEqual(finalized.returncode, 0, finalized.stderr)
            evidence = json.loads(
                (output_dir / "installer-asset-evidence.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(evidence["asset_name"], "install.sh")
            self.assertEqual(
                evidence["verification_result"]["platform_installer_checksums"],
                {
                    platform: f"sha256:{_sha(installers[platform])}"
                    for platform in PLATFORMS
                },
            )

    def test_assemble_requires_both_supported_platforms(self) -> None:
        """Reject a shared wrapper that cannot serve a supported platform."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            installers = {"linux-x86_64": self._write_installers(root)["linux-x86_64"]}

            result = self._run_assemble(
                self._write_source(root), installers, root / "output"
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("requires both supported platforms", result.stderr)

    def test_assemble_rejects_non_https_installer_url(self) -> None:
        """Keep pipe delivery on fixed HTTPS urls only."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            urls = {
                platform: self._url(platform).replace("https://", "http://")
                for platform in PLATFORMS
            }

            result = self._run_assemble(
                self._write_source(root),
                self._write_installers(root),
                root / "output",
                urls=urls,
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("fixed https url", result.stderr)

    def test_assemble_rejects_installer_url_name_mismatch(self) -> None:
        """Bind the published url name to the verified payload name."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            urls = self._urls(root)
            urls["linux-x86_64"] = (
                "https://github.com/example-org/example-app/releases/download/"
                "v1.0.0/other-installer.sh"
            )

            result = self._run_assemble(
                self._write_source(root),
                self._write_installers(root),
                root / "output",
                urls=urls,
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("must end with the installer asset name", result.stderr)

    def test_assemble_is_independent_of_source_line_endings(self) -> None:
        """Ignore checkout EOL so the wrapper checksum stays reproducible."""
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
                self._write_installers(lf_root),
                lf_output,
            )
            crlf_source = self._write_source(crlf_root, crlf=True)
            self.assertIn(b"\r\n", (crlf_source / "install.sh").read_bytes())
            crlf_assemble = self._run_assemble(
                crlf_source,
                self._write_installers(crlf_root),
                crlf_output,
                urls=self._urls(crlf_root),
            )

            self.assertEqual(lf_assemble.returncode, 0, lf_assemble.stderr)
            self.assertEqual(crlf_assemble.returncode, 0, crlf_assemble.stderr)
            crlf_bytes = (crlf_output / "install.sh").read_bytes()
            self.assertNotIn(b"\r", crlf_bytes)
            self.assertEqual((lf_output / "install.sh").read_bytes(), crlf_bytes)
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
            self.assertEqual(
                lf_candidate["asset_checksum"], crlf_candidate["asset_checksum"]
            )
            self.assertEqual(
                lf_candidate["platform_installers"],
                crlf_candidate["platform_installers"],
            )

    def test_assemble_rejects_non_utf8_source(self) -> None:
        """Reject binary wrapper source instead of rewriting its bytes."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            source_dir = self._write_source(root)
            (source_dir / "blob.bin").write_bytes(b"\xff\xfe\x00binary")

            result = self._run_assemble(
                source_dir, self._write_installers(root), root / "output"
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("must be UTF-8 text", result.stderr)
            self.assertFalse((root / "output").exists())

    def test_finalize_rejects_wrapper_changed_after_verification(self) -> None:
        """Do not finalize evidence for a mutated candidate wrapper."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            output_dir = self._assemble_candidate(root)
            verification_path = self._write_verification(root, output_dir)
            (output_dir / "install.sh").write_text("# tampered\n", encoding="utf-8")

            result = self._run_finalize(output_dir, verification_path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("candidate wrapper checksum mismatch", result.stderr)

    def test_finalize_rejects_platform_checksum_mismatch(self) -> None:
        """Require verification evidence to bind every payload checksum."""
        with tempfile.TemporaryDirectory() as temporary_root:
            root = Path(temporary_root)
            output_dir = self._assemble_candidate(root)
            candidate = json.loads(
                (output_dir / "installer-asset-candidate.json").read_text(
                    encoding="utf-8"
                )
            )
            verification_path = root / "verification.json"
            verification_path.write_text(
                json.dumps(
                    {
                        "status": "passed",
                        "suite": "project-shared-wrapper",
                        "wrapper_checksum": candidate["asset_checksum"],
                        "source_revision": SOURCE_REVISION,
                        "platform_installer_checksums": {
                            platform: "sha256:" + "0" * 64 for platform in PLATFORMS
                        },
                    }
                ),
                encoding="utf-8",
            )

            result = self._run_finalize(output_dir, verification_path)

            self.assertEqual(result.returncode, 2)
            self.assertIn("platform checksum mismatch", result.stderr)

    def test_finalize_rejects_incomplete_or_unbound_proof(self) -> None:
        """Transported candidate and verification fields cannot assert their own validity."""
        cases = ["builder_identity", "asset_name", "platform_installers", "installer-entry", "installer-name", "installer-checksum", "installer-binding", "status", "suite", "wrapper_checksum", "source_revision", "broken-zip", "unsafe-zip", "existing-evidence", "missing-output", "duplicate-zip"]
        for kind in cases:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self._test_temp_root()) as temporary:
                root = Path(temporary)
                output = self._assemble_candidate(root)
                verification = self._write_verification(root, output)
                record_path = output / "installer-asset-candidate.json"
                record = json.loads(record_path.read_text())
                if kind in {"status", "suite", "wrapper_checksum", "source_revision"}:
                    data = json.loads(verification.read_text())
                    data[kind] = ""
                    verification.write_text(json.dumps(data))
                elif kind in {"broken-zip", "unsafe-zip", "duplicate-zip"}:
                    snapshot = output / ".installer-source.zip"
                    if kind == "broken-zip":
                        snapshot.write_bytes(b"not a ZIP")
                    else:
                        with warnings.catch_warnings(), zipfile.ZipFile(snapshot, "w") as archive:
                            warnings.filterwarnings("ignore", message="Duplicate name")
                            archive.writestr("install.sh", "#!/bin/sh\n# __INSTALLER_RUNTIME_VALUES__\n")
                            archive.writestr("install.sh" if kind == "duplicate-zip" else "../escape", "unsafe")
                elif kind == "missing-output":
                    pass
                elif kind == "existing-evidence":
                    (output / "installer-asset-evidence.json").write_text("preserve")
                else:
                    if kind == "installer-entry":
                        record["platform_installers"][PLATFORMS[0]] = []
                    elif kind == "installer-binding":
                        record["platform_installers"][PLATFORMS[0]]["installer_checksum"] = "sha256:" + "0" * 64
                    elif kind in {"installer-name", "installer-checksum"}:
                        key = "installer_name" if kind == "installer-name" else "installer_checksum"
                        record["platform_installers"][PLATFORMS[0]][key] = "" if kind == "installer-name" else "sha256:bad"
                    else:
                        record[kind] = {} if kind == "platform_installers" else ""
                    record_path.write_text(json.dumps(record))
                result = self._run_finalize(root / "missing" if kind == "missing-output" else output, verification)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse((output / "installer-verification-evidence.json").exists())
                evidence = output / "installer-asset-evidence.json"
                if kind == "existing-evidence":
                    self.assertEqual(evidence.read_text(), "preserve")
                else:
                    self.assertFalse(evidence.exists())

    def test_assemble_rejects_invalid_payload_and_missing_source(self) -> None:
        """Do not build wrappers around unreadable payloads or incomplete source."""
        for kind in ["wrong-payload-suffix", "missing-marker", "missing-entrypoint", "missing-parent", "missing-url", "existing-output", "asset-name"]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self._test_temp_root()) as temporary:
                root = Path(temporary)
                source = self._write_source(root)
                installers = self._write_installers(root)
                output = root / "output"
                urls = self._urls(root)
                if kind == "wrong-payload-suffix":
                    payload = installers[PLATFORMS[0]]
                    renamed = payload.with_suffix(".bin")
                    payload.rename(renamed)
                    installers[PLATFORMS[0]] = renamed
                elif kind == "missing-marker":
                    (source / "install.sh").write_text("#!/bin/sh\nexit 0\n")
                elif kind == "missing-entrypoint":
                    (source / "install.sh").rename(source / "other.sh")
                elif kind == "missing-parent":
                    output = root / "missing/output"
                elif kind == "missing-url":
                    del urls[PLATFORMS[0]]
                elif kind == "existing-output":
                    output.mkdir()
                    (output / "preserve").write_text("keep")
                result = self._run_assemble(source, installers, output, urls=urls, asset_name="../unsafe.sh" if kind == "asset-name" else "install.sh")
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse((output / "installer-asset-candidate.json").exists())
                if kind == "existing-output":
                    self.assertEqual((output / "preserve").read_text(), "keep")
                else:
                    self.assertFalse(output.exists())

    def test_assemble_rejects_malformed_cli_assignments(self) -> None:
        """Malformed and duplicate assignment options fail at the CLI boundary."""
        with tempfile.TemporaryDirectory(dir=self._test_temp_root()) as temporary:
            root = Path(temporary)
            for values in [["bad"], ["linux-x86_64=first", "linux-x86_64=second"]]:
                command = [sys.executable, str(BUILDER_PATH), "assemble", "--source-dir", str(root), "--output-dir", str(root / "output"), "--asset-name", "install.sh", "--source-revision", SOURCE_REVISION, "--assembly-id", "assembly-1"]
                for value in values:
                    command.extend(["--platform-installer", value])
                result = subprocess.run(command, capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse((root / "output").exists())

    @staticmethod
    def _test_temp_root() -> Path:
        root = BUNDLE_ROOT / "tests/tmp"
        root.mkdir(parents=True, exist_ok=True)
        return root

    def _write_source(self, root: Path, *, crlf: bool = False) -> Path:
        source_dir = root / "source"
        source_dir.mkdir()
        entrypoint = source_dir / "install.sh"
        text = "#!/bin/sh\n# __INSTALLER_RUNTIME_VALUES__\nexit 0\n"
        entrypoint.write_bytes(
            (text.replace("\n", "\r\n") if crlf else text).encode("utf-8")
        )
        entrypoint.chmod(0o755)
        return source_dir

    def _write_installers(self, root: Path) -> dict[str, Path]:
        installer_dir = root / "payload"
        installer_dir.mkdir(exist_ok=True)
        installers: dict[str, Path] = {}
        for platform in PLATFORMS:
            path = installer_dir / f"install-{platform}.sh"
            path.write_text(
                f"#!/usr/bin/env bash\nset -eu\n# payload {platform}\n",
                encoding="utf-8",
            )
            path.chmod(0o755)
            installers[platform] = path
        return installers

    def _url(self, platform: str) -> str:
        return (
            "https://github.com/example-org/example-app/releases/download/"
            f"v1.0.0/install-{platform}.sh"
        )

    def _urls(self, root: Path) -> dict[str, str]:
        return {platform: self._url(platform) for platform in PLATFORMS}

    def _run_assemble(
        self,
        source_dir: Path,
        installers: dict[str, Path],
        output_dir: Path,
        *,
        urls: dict[str, str] | None = None,
        asset_name: str = "install.sh",
    ) -> subprocess.CompletedProcess[str]:
        command = [
            sys.executable,
            str(BUILDER_PATH),
            "assemble",
            "--source-dir",
            str(source_dir),
            "--output-dir",
            str(output_dir),
            "--asset-name",
            asset_name,
            "--source-revision",
            SOURCE_REVISION,
            "--assembly-id",
            "assembly-1",
        ]
        resolved_urls = urls or self._urls(source_dir)
        for platform, path in installers.items():
            command += ["--platform-installer", f"{platform}={path}"]
        for platform, url in resolved_urls.items():
            command += ["--installer-url", f"{platform}={url}"]
        return subprocess.run(
            command,
            cwd=BUNDLE_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )

    def _run_finalize(
        self, output_dir: Path, verification_path: Path
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

    def _assemble_candidate(self, root: Path) -> Path:
        output_dir = root / "output"
        result = self._run_assemble(
            self._write_source(root), self._write_installers(root), output_dir
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return output_dir

    def _write_verification(self, root: Path, output_dir: Path) -> Path:
        candidate = json.loads(
            (output_dir / "installer-asset-candidate.json").read_text(encoding="utf-8")
        )
        verification_path = root / "verification.json"
        verification_path.write_text(
            json.dumps(
                {
                    "status": "passed",
                    "suite": "project-shared-wrapper",
                    "wrapper_checksum": candidate["asset_checksum"],
                    "source_revision": SOURCE_REVISION,
                    "platform_installer_checksums": {
                        platform: data["installer_checksum"]
                        for platform, data in candidate["platform_installers"].items()
                    },
                }
            ),
            encoding="utf-8",
        )
        return verification_path


if __name__ == "__main__":
    unittest.main()
