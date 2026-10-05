"""Exercise the assembled Unix and PowerShell installer entrypoints."""

from __future__ import annotations

import hashlib
import io
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

BUNDLE_ROOT = Path(__file__).resolve().parents[1]
BUILDER = BUNDLE_ROOT / "src/build-installer.py"
SOURCE = BUNDLE_ROOT / "src/platform"
TEMPLATE = BUNDLE_ROOT.parents[1] / "skills/installer/assets/examples/native-manifest.template.json"
REVISION = "0123456789abcdef0123456789abcdef01234567"


def _temporary_directory() -> tempfile.TemporaryDirectory[str]:
    temp_root = BUNDLE_ROOT / "tests/tmp"
    if temp_root.is_symlink():
        raise RuntimeError("test temporary root must not be a symlink")
    temp_root.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=temp_root)


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class RuntimeInstallerTest(unittest.TestCase):
    """Check the assembled installer runtime against its public modes."""

    def _artifact(self, root: Path, *, name: str = "tool") -> Path:
        artifact = root / "tool.tar.gz"
        payload = b'#!/bin/sh\n[ "$1" = --help ]\n'
        with tarfile.open(artifact, "w:gz") as archive:
            info = tarfile.TarInfo(name)
            info.mode = 0o755
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
        return artifact

    def _bundle(
        self,
        root: Path,
        artifact: Path,
        *,
        version: str = "1.0.0",
        managed_root: Path | None = None,
        release_path: Path | None = None,
    ) -> tuple[Path, str, Path]:
        manifest = json.loads(TEMPLATE.read_text(encoding="utf-8"))
        managed = managed_root or root / "managed"
        manifest["releaseVersion"] = version
        manifest["targetPlatformId"] = (
            "windows-x86_64"
            if sys.platform == "win32"
            else "macos-arm64"
            if sys.platform == "darwin"
            else "linux-x86_64"
        )
        manifest["source"] = {
            "kind": "github-release",
            "owner": "example-org",
            "repository": "example-app",
            "fixedReference": f"v{version}",
        }
        manifest["artifact"] = {
            "url": f"https://github.com/example-org/example-app/releases/download/v{version}/{artifact.name}",
            "fileName": artifact.name,
            "checksum": f"sha256:{_sha(artifact)}",
        }
        manifest["placement"] = {
            "managedRoot": str(managed),
            "releasePath": str(release_path or managed / "releases" / version),
            "currentLink": str(managed / "current"),
        }
        manifest["activation"] = {"strategy": "active-pointer"}
        manifest["concurrency"] = {"lockPath": str(managed / "install.lock")}
        state = managed / "state" / "install.state"
        manifest["state"] = {"installStatePath": str(state)}
        manifest["compatibility"] = {"requiredInstallerVersion": "2"}
        manifest["provenance"] = {
            "sourceTag": f"v{version}",
            "sourceCommit": REVISION,
            "ciRunId": "assembly-1",
        }
        manifest_path = root / f"manifest-{version}.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        output = root / f"output-{version}"
        built = subprocess.run(
            [
                sys.executable,
                str(BUILDER),
                "assemble",
                "--source-dir",
                str(SOURCE),
                "--manifest",
                str(manifest_path),
                "--output-dir",
                str(output),
                "--asset-name",
                "installer.ps1" if sys.platform == "win32" else "installer.sh",
                "--source-revision",
                REVISION,
                "--assembly-id",
                "assembly-1",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(built.returncode, 0, built.stderr)
        return output, _sha(manifest_path), state

    def _run(
        self,
        bundle: Path,
        checksum: str,
        artifact: Path,
        *,
        mode: str,
        env: dict[str, str] | None = None,
        source_mode: str = "offline",
        smoke: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        if sys.platform == "win32":
            command = [
                "pwsh",
                "-NoProfile",
                "-File",
                str(bundle / "installer.ps1"),
            ]
            command += ["-Mode", mode, "-Source", source_mode, "-Json"]
            if source_mode == "offline":
                command += [
                    "-Manifest",
                    str(next(bundle.glob("manifest-*.json"))),
                    "-Artifact",
                    str(artifact),
                ]
            if smoke:
                command += ["-SmokeHelp"]
        else:
            command = ["bash", str(bundle / "installer.sh")]
            command += ["--mode", mode, "--source", source_mode, "--json"]
            if source_mode == "offline":
                command += [
                    "--manifest",
                    str(next(bundle.glob("manifest-*.json"))),
                    "--artifact",
                    str(artifact),
                ]
            if smoke:
                command += ["--smoke-help"]
        return subprocess.run(
            command, capture_output=True, text=True, check=False, env=env
        )

    @staticmethod
    def _ps_quote(value: Path) -> str:
        """Quote a path for a single-quoted PowerShell string."""
        return "'" + str(value).replace("'", "''") + "'"

    def _run_iex(
        self,
        bundle: Path,
        artifact: Path,
        *,
        mode: str,
    ) -> subprocess.CompletedProcess[str]:
        """Run the built PowerShell installer in memory like `irm | iex`."""
        manifest = next(bundle.glob("manifest-*.json"))
        script = bundle / "installer.ps1"
        assignments = (
            f"$env:INSTALLER_MODE='{mode}'",
            "$env:INSTALLER_SOURCE='offline'",
            f"$env:INSTALLER_MANIFEST={self._ps_quote(manifest)}",
            f"$env:INSTALLER_ARTIFACT={self._ps_quote(artifact)}",
            "$env:INSTALLER_JSON='1'",
        )
        command = "; ".join(assignments) + (
            f"; Get-Content -Raw -LiteralPath {self._ps_quote(script)} | iex"
        )
        return subprocess.run(
            ["pwsh", "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
            check=False,
        )

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_verify_install_noop_and_dry_run(self) -> None:
        """Validate before no-op and keep dry-run free of persistent state."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            artifact = self._artifact(root)
            bundle, checksum, state = self._bundle(root, artifact)
            dry_run = self._run(bundle, checksum, artifact, mode="dry-run")
            self.assertEqual(dry_run.returncode, 0, dry_run.stderr)
            self.assertFalse(state.exists())
            first = self._run(bundle, checksum, artifact, mode="install", smoke=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(json.loads(first.stdout)["result"], "success")
            previous = state.read_bytes()
            second = self._run(bundle, checksum, artifact, mode="install")
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(json.loads(second.stdout)["result"], "unchanged")
            self.assertEqual(state.read_bytes(), previous)
            (next(bundle.glob("manifest-*.json"))).write_text("{}", encoding="utf-8")
            wrong_digest = self._run(bundle, checksum, artifact, mode="install")
            (next(bundle.glob("manifest-*.json"))).write_bytes(
                (root / "manifest-1.0.0.json").read_bytes()
            )
            self.assertNotEqual(wrong_digest.returncode, 0)
            self.assertEqual(state.read_bytes(), previous)
            artifact.write_bytes(b"wrong")
            wrong_artifact = self._run(bundle, checksum, artifact, mode="install")
            self.assertNotEqual(wrong_artifact.returncode, 0)
            self.assertEqual(state.read_bytes(), previous)

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_online_uses_only_manifest_fixed_url(self) -> None:
        """Fetch the artifact from the manifest's fixed Release URL."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            artifact = self._artifact(root)
            bundle, _checksum, state = self._bundle(root, artifact)
            fixed_url = json.loads((next(bundle.glob("manifest-*.json"))).read_text())[
                "artifact"
            ]["url"]
            target_platform_id = json.loads(
                next(bundle.glob("manifest-*.json")).read_text()
            )["targetPlatformId"]
            fake_bin = root / "fake-bin"
            fake_bin.mkdir()
            fake_curl = fake_bin / "curl"
            fake_curl.write_text(
                "#!/bin/sh\n"
                "out=''\n"
                "while [ $# -gt 0 ]; do\n"
                '  if [ "$1" = --output ]; then\n'
                "    out=$2; shift 2\n"
                "  else url=$1; shift; fi\n"
                "done\n"
                'if [ "$url" = "$MANIFEST_URL" ]; then '
                'cp "$FAKE_MANIFEST" "$out"; exit; fi\n'
                '[ "$url" = "$EXPECTED_URL" ] || exit 7\n'
                'cp "$FAKE_ARTIFACT" "$out"\n',
                encoding="utf-8",
            )
            fake_curl.chmod(0o755)
            env = dict(
                os.environ,
                PATH=f"{fake_bin}:{os.environ['PATH']}",
                FAKE_ARTIFACT=str(artifact),
                FAKE_MANIFEST=str(next(bundle.glob("manifest-*.json"))),
                MANIFEST_URL=(
                    "https://github.com/example-org/example-app/releases/download/"
                    f"v1.0.0/manifest-{target_platform_id}.json"
                ),
                EXPECTED_URL=fixed_url,
            )
            completed = subprocess.run(
                ["bash", str(bundle / "installer.sh")],
                capture_output=True,
                text=True,
                check=False,
                env=env,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout, "installed 1.0.0\n")
            self.assertTrue(state.exists())

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_rejects_broad_managed_root_before_writes(self) -> None:
        """Keep the runtime breadth check even if assembly is bypassed."""
        with _temporary_directory() as temp:
            root = Path(temp).resolve()
            artifact = self._artifact(root)
            bundle, checksum, _ = self._bundle(root, artifact)
            installed_script = bundle / "installer.sh"
            script = installed_script.read_text(encoding="utf-8")
            rewritten = re.sub(
                r"MANAGED_ROOT=\S+", "MANAGED_ROOT='/etc'", script, count=1
            )
            self.assertNotEqual(rewritten, script)
            installed_script.write_text(rewritten, encoding="utf-8")

            completed = self._run(bundle, checksum, artifact, mode="dry-run")

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("managed root is too broad", completed.stderr)

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_per_user_profile_creates_launcher(self) -> None:
        """Expand home-relative paths and link the launcher to the release."""
        target = "macos-arm64" if sys.platform == "darwin" else "linux-x86_64"
        if target == "macos-arm64":
            base = "~/Library/Application Support/example-vendor/example-app/standalone"
        else:
            base = "~/.local/share/example-vendor/example-app/standalone"
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root).resolve()
            home = root / "home"
            home.mkdir()
            artifact = self._artifact(root)
            manifest = json.loads(TEMPLATE.read_text(encoding="utf-8"))
            manifest["releaseVersion"] = "1.0.0"
            manifest["targetPlatformId"] = target
            manifest["source"] = {
                "kind": "github-release",
                "owner": "example-org",
                "repository": "example-app",
                "fixedReference": "v1.0.0",
            }
            manifest["artifact"] = {
                "url": (
                    "https://github.com/example-org/example-app/releases/download/"
                    f"v1.0.0/{artifact.name}"
                ),
                "fileName": artifact.name,
                "checksum": f"sha256:{_sha(artifact)}",
            }
            manifest["placement"] = {
                "profile": "per-user-cli",
                "channel": "standalone",
                "managedRoot": base,
                "releasePath": f"{base}/releases/1.0.0",
                "currentLink": f"{base}/current",
            }
            manifest["activation"] = {
                "strategy": "active-pointer",
                "launcherPath": "~/.local/bin/example-app",
            }
            manifest["concurrency"] = {"lockPath": f"{base}/install.lock"}
            manifest["state"] = {"installStatePath": f"{base}/state/install.state"}
            manifest["compatibility"] = {"requiredInstallerVersion": "2"}
            manifest["provenance"] = {
                "sourceTag": "v1.0.0",
                "sourceCommit": REVISION,
                "ciRunId": "assembly-1",
            }
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            output = root / "output"
            built = subprocess.run(
                [
                    sys.executable,
                    str(BUILDER),
                    "assemble",
                    "--source-dir",
                    str(SOURCE),
                    "--manifest",
                    str(manifest_path),
                    "--output-dir",
                    str(output),
                    "--asset-name",
                    "installer.sh",
                    "--source-revision",
                    REVISION,
                    "--assembly-id",
                    "assembly-1",
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(built.returncode, 0, built.stderr)
            environment = os.environ.copy()
            environment["HOME"] = str(home)
            completed = subprocess.run(
                [
                    "bash",
                    str(output / "installer.sh"),
                    "--mode",
                    "install",
                    "--source",
                    "offline",
                    "--manifest",
                    str(output / f"manifest-{target}.json"),
                    "--artifact",
                    str(artifact),
                ],
                capture_output=True,
                text=True,
                check=False,
                env=environment,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            launcher = home / ".local/bin/example-app"
            release_root = home / base[2:]
            self.assertTrue(launcher.is_symlink())
            self.assertTrue(launcher.resolve().is_relative_to(release_root.resolve()))

            launcher.unlink()
            command = [
                "bash",
                str(output / "installer.sh"),
                "--mode",
                "install",
                "--source",
                "offline",
                "--manifest",
                str(output / f"manifest-{target}.json"),
                "--artifact",
                str(artifact),
            ]
            failed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=False,
                env=environment,
            )
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("use upgrade or repair", failed.stderr)
            command[command.index("install")] = "repair"
            repaired = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=False,
                env=environment,
            )
            self.assertEqual(repaired.returncode, 0, repaired.stderr)
            self.assertTrue(launcher.is_symlink())
            self.assertTrue(launcher.resolve().is_relative_to(release_root.resolve()))

            state_file = release_root / "state/install.state"
            state_text = state_file.read_text(encoding="utf-8")
            state_file.write_text(
                state_text.replace(
                    f"launcherPath={launcher}", "launcherPath=/tmp/other-launcher"
                ),
                encoding="utf-8",
            )
            for mode in ("install", "repair"):
                with self.subTest(mode=mode):
                    mismatch = subprocess.run(
                        [
                            "bash",
                            str(output / "installer.sh"),
                            "--mode",
                            mode,
                            "--source",
                            "offline",
                            "--manifest",
                            str(output / f"manifest-{target}.json"),
                            "--artifact",
                            str(artifact),
                        ],
                        capture_output=True,
                        text=True,
                        check=False,
                        env=environment,
                    )
                    self.assertNotEqual(mismatch.returncode, 0)
                    self.assertIn("not installer-managed", mismatch.stderr)
            self.assertTrue(launcher.is_symlink())
            self.assertEqual(os.readlink(launcher), f"{release_root}/current/tool")
            self.assertIn(
                "launcherPath=/tmp/other-launcher",
                state_file.read_text(encoding="utf-8"),
            )

    def _per_user_bundle(
        self, root: Path, *, launcher_path: str, payload: bytes | None = None
    ) -> tuple[Path, Path, str]:
        """Assemble a per-user starter bundle with an explicit launcher path."""
        target = "macos-arm64" if sys.platform == "darwin" else "linux-x86_64"
        base = (
            "~/Library/Application Support/example-vendor/example-app/standalone"
            if target == "macos-arm64"
            else "~/.local/share/example-vendor/example-app/standalone"
        )
        artifact = root / "example-app.tar.gz"
        if payload is None:
            payload = b'#!/bin/sh\n[ "$1" = --help ]\n'
        with tarfile.open(artifact, "w:gz") as archive:
            info = tarfile.TarInfo("example-app")
            info.mode = 0o755
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
        manifest = json.loads(TEMPLATE.read_text(encoding="utf-8"))
        manifest["releaseVersion"] = "1.0.0"
        manifest["targetPlatformId"] = target
        manifest["source"] = {
            "kind": "github-release",
            "owner": "example-org",
            "repository": "example-app",
            "fixedReference": "v1.0.0",
        }
        manifest["artifact"] = {
            "url": (
                "https://github.com/example-org/example-app/releases/download/"
                f"v1.0.0/{artifact.name}"
            ),
            "fileName": artifact.name,
            "checksum": f"sha256:{_sha(artifact)}",
        }
        manifest["placement"] = {
            "profile": "per-user-cli",
            "channel": "standalone",
            "managedRoot": base,
            "releasePath": f"{base}/releases/1.0.0",
            "currentLink": f"{base}/current",
        }
        manifest["activation"] = {
            "strategy": "active-pointer",
            "launcherPath": launcher_path,
        }
        manifest["concurrency"] = {"lockPath": f"{base}/install.lock"}
        manifest["state"] = {"installStatePath": f"{base}/state/install.state"}
        manifest["compatibility"] = {"requiredInstallerVersion": "2"}
        manifest["provenance"] = {
            "sourceTag": "v1.0.0",
            "sourceCommit": REVISION,
            "ciRunId": "assembly-1",
        }
        manifest_path = root / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        output = root / "output"
        built = subprocess.run(
            [
                sys.executable,
                str(BUILDER),
                "assemble",
                "--source-dir",
                str(SOURCE),
                "--manifest",
                str(manifest_path),
                "--output-dir",
                str(output),
                "--asset-name",
                "installer.sh",
                "--source-revision",
                REVISION,
                "--assembly-id",
                "assembly-1",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(built.returncode, 0, built.stderr)
        return output, artifact, target

    def _run_per_user(
        self,
        home: Path,
        output: Path,
        artifact: Path,
        target: str,
        *,
        mode: str = "install",
        smoke: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment["HOME"] = str(home)
        return subprocess.run(
            [
                "bash",
                str(output / "installer.sh"),
                "--mode",
                mode,
                "--source",
                "offline",
                "--manifest",
                str(output / f"manifest-{target}.json"),
                "--artifact",
                str(artifact),
                *(["--smoke-help"] if smoke else []),
            ],
            capture_output=True,
            text=True,
            check=False,
            env=environment,
        )

    def _per_user_windows_bundle(
        self, root: Path, *, version: str = "1.0.0", system_wide: bool = False
    ) -> tuple[Path, Path]:
        """Assemble a per-user Windows bundle with a %LOCALAPPDATA% launcher."""
        base = "%LOCALAPPDATA%\\example-vendor\\example-app\\standalone"
        artifact = root / f"example-app-{version}.zip"
        with zipfile.ZipFile(artifact, "w") as archive:
            archive.writestr("example-app.exe", f"binary {version}".encode())
        manifest = json.loads(TEMPLATE.read_text(encoding="utf-8"))
        manifest["releaseVersion"] = version
        manifest["targetPlatformId"] = "windows-x86_64"
        manifest["source"] = {
            "kind": "github-release",
            "owner": "example-org",
            "repository": "example-app",
            "fixedReference": f"v{version}",
        }
        manifest["artifact"] = {
            "url": (
                "https://github.com/example-org/example-app/releases/download/"
                f"v{version}/{artifact.name}"
            ),
            "fileName": artifact.name,
            "checksum": f"sha256:{_sha(artifact)}",
        }
        manifest["placement"] = {
            "profile": "per-user-cli",
            "channel": "standalone",
            "managedRoot": base,
            "releasePath": f"{base}\\releases\\{version}",
            "currentLink": f"{base}\\current",
        }
        manifest["activation"] = {
            "strategy": "active-pointer",
            "launcherPath": (
                "%LOCALAPPDATA%\\Programs\\example-vendor\\example-app"
                "\\bin\\example-app.exe"
            ),
        }
        manifest["concurrency"] = {"lockPath": f"{base}\\install.lock"}
        manifest["state"] = {"installStatePath": f"{base}\\state\\install.state"}
        manifest["compatibility"] = {"requiredInstallerVersion": "2"}
        manifest["provenance"] = {
            "sourceTag": f"v{version}",
            "sourceCommit": REVISION,
            "ciRunId": "assembly-1",
        }
        if system_wide:
            base = str(root / "managed/example-app")
            manifest["placement"].update(
                profile="system-wide",
                managedRoot=base,
                releasePath=str(Path(base) / "releases" / version),
                currentLink=str(Path(base) / "current"),
            )
            manifest["concurrency"]["lockPath"] = str(Path(base) / "install.lock")
            manifest["state"]["installStatePath"] = str(
                Path(base) / "state/install.state"
            )
            manifest["activation"]["launcherPath"] = str(
                root / "Program Files/example-app.exe"
            )
        manifest_path = root / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        output = root / "output"
        built = subprocess.run(
            [
                sys.executable,
                str(BUILDER),
                "assemble",
                "--source-dir",
                str(SOURCE),
                "--manifest",
                str(manifest_path),
                "--output-dir",
                str(output),
                "--asset-name",
                "installer.ps1",
                "--source-revision",
                REVISION,
                "--assembly-id",
                "assembly-1",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(built.returncode, 0, built.stderr)
        return output, artifact

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_rejects_launcher_parent_traversal(self) -> None:
        """Reject empty and relative launcher components if assembly is bypassed."""
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root).resolve()
            home = root / "home"
            home.mkdir()
            output, artifact, target = self._per_user_bundle(
                root, launcher_path="~/.local/bin/example-app"
            )
            script_path = output / "installer.sh"
            script = script_path.read_text(encoding="utf-8")
            rewritten = re.sub(
                r"LAUNCHER_PATH=\S+",
                "LAUNCHER_PATH='~/.local/bin/../../../tmp/evil'",
                script,
                count=1,
            )
            self.assertNotEqual(rewritten, script)
            script_path.write_text(rewritten, encoding="utf-8")

            completed = self._run_per_user(home, output, artifact, target)

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("launcher path must not contain", completed.stderr)
            self.assertFalse((root / "tmp/evil").exists())
            self.assertFalse((home / ".local/bin/evil").exists())

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_rejects_launcher_parent_symlink_without_changes(self) -> None:
        """Reject redirected launcher parents before touching managed paths."""
        for mode in ("install", "dry-run"):
            with self.subTest(mode=mode), _temporary_directory() as temp:
                root = Path(temp).resolve()
                home = root / "home"
                (home / ".local").mkdir(parents=True)
                outside = root / "outside"
                outside.mkdir()
                (home / ".local/bin").symlink_to(outside, target_is_directory=True)
                output, artifact, target = self._per_user_bundle(
                    root, launcher_path="~/.local/bin/example-app"
                )
                completed = self._run_per_user(
                    home, output, artifact, target, mode=mode
                )
                self.assertNotEqual(completed.returncode, 0)
                self.assertIn("symlink path component", completed.stderr)
                self.assertEqual(list(outside.iterdir()), [])
                self.assertFalse((home / ".local/lib").exists())

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_rechecks_launcher_parent_after_preflight(self) -> None:
        """Detect a parent redirected during smoke before activation."""
        with _temporary_directory() as temp:
            root = Path(temp).resolve()
            home = root / "home"
            outside = home / "outside"
            outside.mkdir(parents=True)
            output, artifact, target = self._per_user_bundle(
                root,
                launcher_path="~/.local/bin/example-app",
                payload=(
                    b'#!/bin/sh\nmkdir -p "$HOME/.local"\n'
                    b'ln -s "$HOME/outside" "$HOME/.local/bin"\nexit 0\n'
                ),
            )
            completed = self._run_per_user(home, output, artifact, target, smoke=True)
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("symlink path component", completed.stderr)
            managed = home / (
                "Library/Application Support/example-vendor/example-app/standalone"
                if target == "macos-arm64"
                else ".local/share/example-vendor/example-app/standalone"
            )
            self.assertFalse((managed / "current").is_symlink())
            self.assertFalse((managed / "releases/1.0.0").exists())
            self.assertFalse((managed / "state/install.state").exists())
            self.assertEqual(list(outside.iterdir()), [])

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_dry_run_rejects_existing_unsafe_state_without_changes(self) -> None:
        """Reject collisions and corrupt state while preserving existing paths."""
        for case in ("launcher-file", "launcher-symlink", "state", "pointer"):
            with self.subTest(case=case), _temporary_directory() as temp:
                root = Path(temp).resolve()
                home = root / "home"
                home.mkdir()
                output, artifact, target = self._per_user_bundle(
                    root, launcher_path="~/.local/bin/example-app"
                )
                managed = home / (
                    "Library/Application Support/example-vendor/example-app/standalone"
                    if target == "macos-arm64"
                    else ".local/share/example-vendor/example-app/standalone"
                )
                if case.startswith("launcher"):
                    path = home / ".local/bin/example-app"
                    path.parent.mkdir(parents=True)
                    if case == "launcher-file":
                        path.write_bytes(b"user file")
                    else:
                        path.symlink_to(root / "missing-user-target")
                else:
                    path = managed / (
                        "state/install.state" if case == "state" else "current"
                    )
                    path.parent.mkdir(parents=True)
                    path.write_bytes(b"invalid state")
                before = os.readlink(path) if path.is_symlink() else path.read_bytes()
                completed = self._run_per_user(
                    home, output, artifact, target, mode="dry-run"
                )
                self.assertNotEqual(completed.returncode, 0)
                after = os.readlink(path) if path.is_symlink() else path.read_bytes()
                self.assertEqual(after, before)
                self.assertFalse((managed / "releases").exists())
                self.assertFalse((managed / "install.lock").exists())

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_dry_run_accepts_managed_launcher_without_changes(self) -> None:
        """Keep a valid managed installation unchanged during dry-run."""
        with _temporary_directory() as temp:
            root = Path(temp).resolve()
            home = root / "home"
            home.mkdir()
            output, artifact, target = self._per_user_bundle(
                root, launcher_path="~/.local/bin/example-app"
            )
            installed = self._run_per_user(home, output, artifact, target)
            self.assertEqual(installed.returncode, 0, installed.stderr)
            managed = home / (
                "Library/Application Support/example-vendor/example-app/standalone"
                if target == "macos-arm64"
                else ".local/share/example-vendor/example-app/standalone"
            )
            state = managed / "state/install.state"
            before = state.read_bytes()
            completed = self._run_per_user(
                home, output, artifact, target, mode="dry-run"
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn("verified", completed.stdout)
            self.assertEqual(state.read_bytes(), before)
            self.assertTrue((home / ".local/bin/example-app").is_symlink())

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_rejects_unmanaged_launcher_symlink(self) -> None:
        """Keep an existing non-managed launcher symlink unchanged."""
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root).resolve()
            home = root / "home"
            home.mkdir()
            output, artifact, target = self._per_user_bundle(
                root, launcher_path="~/.local/bin/example-app"
            )
            launcher = home / ".local/bin/example-app"
            launcher.parent.mkdir(parents=True)
            user_target = root / "user-target"
            user_target.write_text("user data", encoding="utf-8")
            launcher.symlink_to(user_target)

            completed = self._run_per_user(home, output, artifact, target)

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("not installer-managed", completed.stderr)
            self.assertTrue(launcher.is_symlink())
            self.assertEqual(os.readlink(launcher), str(user_target))
            self.assertEqual(user_target.read_text(encoding="utf-8"), "user data")
            state = (
                home
                / ".local/share/example-vendor/example-app/standalone"
                / "state/install.state"
            )
            self.assertFalse(state.exists())

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_single_file_default_rejects_bad_manifest_and_cleans_work(
        self,
    ) -> None:
        """Remove temporary downloads when the fetched manifest is invalid."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            artifact = self._artifact(root)
            bundle, _, state = self._bundle(root, artifact)
            fake_bin = root / "fake-bin"
            fake_bin.mkdir()
            fake_curl = fake_bin / "curl"
            fake_curl.write_text(
                "#!/bin/sh\n"
                "out=''\n"
                "while [ $# -gt 0 ]; do\n"
                '  if [ "$1" = --output ]; then '
                "out=$2; shift 2; else url=$1; shift; fi\n"
                "done\n"
                'printf "%s\\n" "$url" >> "$FETCH_LOG"\n'
                'printf "wrong" > "$out"\n',
                encoding="utf-8",
            )
            fake_curl.chmod(0o755)
            temp_work = root / "work"
            temp_work.mkdir()
            fetch_log = root / "fetch.log"
            env = dict(
                os.environ,
                PATH=f"{fake_bin}:{os.environ['PATH']}",
                TMPDIR=str(temp_work),
                FETCH_LOG=str(fetch_log),
            )
            result = subprocess.run(
                ["bash", str(bundle / "installer.sh")],
                capture_output=True,
                text=True,
                check=False,
                env=env,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("manifest checksum mismatch", result.stderr)
            self.assertEqual(len(fetch_log.read_text(encoding="utf-8").splitlines()), 1)
            self.assertEqual(list(temp_work.iterdir()), [])
            self.assertFalse(state.exists())

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_state_write_failure_restores_pointer_and_state(self) -> None:
        """Restore both activation and state after a failed state update."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            artifact = self._artifact(root)
            bundle, checksum, state = self._bundle(root, artifact)
            first = self._run(bundle, checksum, artifact, mode="install")
            self.assertEqual(first.returncode, 0, first.stderr)
            pointer = state.parent.parent / "current"
            previous_pointer = pointer.resolve()
            previous_state = state.read_bytes()
            second_artifact = root / "tool-2.tar.gz"
            shutil.copy2(artifact, second_artifact)
            second_bundle, second_checksum, _ = self._bundle(
                root, second_artifact, version="2.0.0"
            )
            fake_bin = root / "fake-bin"
            fake_bin.mkdir()
            fake_mv = fake_bin / "mv"
            fake_mv.write_text(
                "#!/bin/sh\n"
                f'for arg do [ "$arg" = "{state}" ] && exit 1; done\n'
                'exec /bin/mv "$@"\n',
                encoding="utf-8",
            )
            fake_mv.chmod(0o755)
            env = dict(os.environ, PATH=f"{fake_bin}:{os.environ['PATH']}")
            failed = self._run(
                second_bundle, second_checksum, second_artifact, mode="upgrade", env=env
            )
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(pointer.resolve(), previous_pointer)
            self.assertEqual(state.read_bytes(), previous_state)
            self.assertFalse((state.parent.parent / "releases/2.0.0").exists())

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_repair_requires_installed_state(self) -> None:
        """Reject repair when no release is installed."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            managed = root / "managed"
            first_root = root / "first"
            first_root.mkdir()
            first_artifact = self._artifact(first_root)
            first_bundle, first_checksum, state = self._bundle(
                first_root, first_artifact, managed_root=managed
            )
            absent = self._run(
                first_bundle, first_checksum, first_artifact, mode="repair"
            )
            self.assertNotEqual(absent.returncode, 0)
            self.assertFalse(state.exists())

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_repair_rejects_same_version_checksum_change(self) -> None:
        """Reject a different artifact under the installed release version."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            managed = root / "managed"
            first_root = root / "first"
            first_root.mkdir()
            first_artifact = self._artifact(first_root)
            first_bundle, first_checksum, state = self._bundle(
                first_root, first_artifact, managed_root=managed
            )
            installed = self._run(
                first_bundle, first_checksum, first_artifact, mode="install"
            )
            self.assertEqual(installed.returncode, 0, installed.stderr)
            previous_state = state.read_bytes()
            release_binary = managed / "releases/1.0.0/tool"
            release_binary.write_bytes(b"damaged")
            second_root = root / "second"
            second_root.mkdir()
            second_artifact = self._artifact(second_root, name="newtool")
            second_bundle, second_checksum, _ = self._bundle(
                second_root, second_artifact, managed_root=managed
            )
            mismatch = self._run(
                second_bundle, second_checksum, second_artifact, mode="repair"
            )
            self.assertNotEqual(mismatch.returncode, 0)
            self.assertEqual(state.read_bytes(), previous_state)
            self.assertEqual(release_binary.read_bytes(), b"damaged")

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_repair_preserves_existing_backup_name(self) -> None:
        """A colliding backup name must not absorb or delete existing files."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            artifact = self._artifact(root)
            bundle, checksum, state = self._bundle(root, artifact)
            installed = self._run(bundle, checksum, artifact, mode="install")
            self.assertEqual(installed.returncode, 0, installed.stderr)
            (state.parent.parent / "releases/1.0.0/tool").write_bytes(b"damaged")
            command = (
                'collision="$MANAGED/.previous-release.$$"; '
                'mkdir "$collision"; printf preserve > "$collision/sentinel"; '
                'printf "%s\\n" "$collision"; exec bash "$@"'
            )
            completed = subprocess.run(
                [
                    "bash",
                    "-c",
                    command,
                    "repair-test",
                    str(bundle / "installer.sh"),
                    "--manifest",
                    str(next(bundle.glob("manifest-*.json"))),
                    "--mode",
                    "repair",
                    "--source",
                    "offline",
                    "--artifact",
                    str(artifact),
                    "--json",
                ],
                capture_output=True,
                text=True,
                check=False,
                env=dict(os.environ, MANAGED=str(state.parent.parent)),
            )
            collision = Path(completed.stdout.splitlines()[0])
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual((collision / "sentinel").read_text(), "preserve")
            self.assertEqual(
                (state.parent.parent / "releases/1.0.0/tool").read_bytes(),
                b'#!/bin/sh\n[ "$1" = --help ]\n',
            )

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_repair_state_failure_restores_previous_release(self) -> None:
        """Keep the old release when repair cannot commit its state."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            artifact = self._artifact(root)
            bundle, checksum, state = self._bundle(root, artifact)
            installed = self._run(bundle, checksum, artifact, mode="install")
            self.assertEqual(installed.returncode, 0, installed.stderr)
            release_binary = state.parent.parent / "releases/1.0.0/tool"
            release_binary.write_bytes(b"damaged")
            previous_state = state.read_bytes()
            fake_bin = root / "fake-bin"
            fake_bin.mkdir()
            fake_mv = fake_bin / "mv"
            fake_mv.write_text(
                "#!/bin/sh\n"
                f'for arg do [ "$arg" = "{state}" ] && exit 1; done\n'
                'exec /bin/mv "$@"\n',
                encoding="utf-8",
            )
            fake_mv.chmod(0o755)
            env = dict(os.environ, PATH=f"{fake_bin}:{os.environ['PATH']}")
            failed = self._run(bundle, checksum, artifact, mode="repair", env=env)
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(state.read_bytes(), previous_state)
            self.assertEqual(release_binary.read_bytes(), b"damaged")

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_upgrade_rejects_same_version_checksum_change(self) -> None:
        """Reject a repacked artifact that reuses the installed version."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            managed = root / "managed"
            first_root = root / "first"
            first_root.mkdir()
            first_artifact = self._artifact(first_root)
            first_bundle, first_checksum, state = self._bundle(
                first_root, first_artifact, managed_root=managed
            )
            installed = self._run(
                first_bundle, first_checksum, first_artifact, mode="install"
            )
            self.assertEqual(installed.returncode, 0, installed.stderr)
            previous_state = state.read_bytes()
            second_root = root / "second"
            second_root.mkdir()
            second_artifact = self._artifact(second_root, name="repacked")
            second_bundle, second_checksum, _ = self._bundle(
                second_root,
                second_artifact,
                managed_root=managed,
                release_path=managed / "releases" / "1.0.0-repack",
            )

            rejected = self._run(
                second_bundle, second_checksum, second_artifact, mode="upgrade"
            )

            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("same release version", rejected.stderr)
            self.assertEqual(state.read_bytes(), previous_state)
            self.assertFalse((managed / "releases/1.0.0-repack").exists())

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_lock_conflict_skips_fetch(self) -> None:
        """Reject a concurrent run before any download starts."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            managed = root / "managed"
            bundle_root = root / "bundle"
            bundle_root.mkdir()
            artifact = self._artifact(bundle_root)
            bundle, _, _ = self._bundle(bundle_root, artifact, managed_root=managed)
            (managed / "install.lock").mkdir(parents=True)
            fake_bin = root / "fake-bin"
            fake_bin.mkdir()
            curl_log = root / "curl.log"
            fake_curl = fake_bin / "curl"
            fake_curl.write_text(
                "#!/bin/sh\nprintf 'call\\n' >> \"$CURL_LOG\"\nexit 7\n",
                encoding="utf-8",
            )
            fake_curl.chmod(0o755)
            env = dict(
                os.environ,
                PATH=f"{fake_bin}:{os.environ['PATH']}",
                CURL_LOG=str(curl_log),
            )

            completed = subprocess.run(
                ["bash", str(bundle / "installer.sh")],
                capture_output=True,
                text=True,
                check=False,
                env=env,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn(
                "another installation owns the runtime lock", completed.stderr
            )
            self.assertFalse(curl_log.exists())

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_repair_keeps_release_until_staging_succeeds(self) -> None:
        """Keep the installed release in place while staging is unverified."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            managed = root / "managed"
            bundle_root = root / "bundle"
            bundle_root.mkdir()
            artifact = self._artifact(bundle_root)
            bundle, checksum, _ = self._bundle(
                bundle_root, artifact, managed_root=managed
            )
            installed = self._run(bundle, checksum, artifact, mode="install")
            self.assertEqual(installed.returncode, 0, installed.stderr)
            release_binary = managed / "releases/1.0.0/tool"
            self.assertTrue(release_binary.is_file())
            release_binary.write_bytes(b"damaged")
            mv_log = root / "mv.log"
            fake_bin = root / "fake-bin"
            fake_bin.mkdir()
            real_sha = shutil.which("sha256sum")
            delegate = (
                f'exec {real_sha} "$@"'
                if real_sha
                else f'exec {shutil.which("shasum")} -a 256 "$@"'
            )
            fake_sha = fake_bin / "sha256sum"
            fake_sha.write_text(
                "#!/bin/sh\n"
                "for argument do\n"
                "  case $argument in *'.staging.'*) exit 1 ;; esac\n"
                "done\n"
                f"{delegate}\n",
                encoding="utf-8",
            )
            fake_sha.chmod(0o755)
            fake_mv = fake_bin / "mv"
            fake_mv.write_text(
                "#!/bin/sh\n"
                f'printf "%s\\n" "$*" >> "{mv_log}"\n'
                f'exec {shutil.which("mv")} "$@"\n',
                encoding="utf-8",
            )
            fake_mv.chmod(0o755)
            env = dict(os.environ, PATH=f"{fake_bin}:{os.environ['PATH']}")

            failed = self._run(bundle, checksum, artifact, mode="repair", env=env)

            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("staged binary checksum mismatch", failed.stderr)
            self.assertFalse(
                mv_log.exists()
                and ".previous-release" in mv_log.read_text(encoding="utf-8")
            )
            self.assertEqual(release_binary.read_bytes(), b"damaged")

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_cleanup_failure_does_not_emit_success_result(self) -> None:
        """A failed lock release must suppress success and unchanged results."""
        with _temporary_directory() as temp:
            root = Path(temp).resolve()
            for installed in (False, True):
                with self.subTest(installed=installed):
                    case_root = root / ("unchanged" if installed else "success")
                    case_root.mkdir()
                    artifact = self._artifact(case_root)
                    bundle, checksum, _ = self._bundle(case_root, artifact)
                    if installed:
                        first = self._run(bundle, checksum, artifact, mode="install")
                        self.assertEqual(first.returncode, 0, first.stderr)
                    fake_bin = case_root / "fake-bin"
                    fake_bin.mkdir()
                    fake_rmdir = fake_bin / "rmdir"
                    fake_rmdir.write_text(
                        "#!/bin/sh\n"
                        '[ "$1" = "$EXPECTED_LOCK" ] && exit 1\n'
                        'exec /bin/rmdir "$@"\n',
                        encoding="utf-8",
                    )
                    fake_rmdir.chmod(0o755)
                    env = dict(
                        os.environ,
                        PATH=f"{fake_bin}:{os.environ['PATH']}",
                        EXPECTED_LOCK=str(case_root / "managed/install.lock"),
                    )
                    completed = self._run(
                        bundle, checksum, artifact, mode="install", env=env
                    )
                    self.assertNotEqual(completed.returncode, 0)
                    self.assertEqual(completed.stdout, "")
                    self.assertIn("rollback status=2", completed.stderr)

    @unittest.skipUnless(
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        or sys.platform.startswith("linux")
        and platform.machine() == "x86_64",
        "native Unix runtime test requires a supported target",
    )
    def test_unix_allows_double_dots_inside_path_component(self) -> None:
        """A filename containing two dots is not parent traversal."""
        with _temporary_directory() as temp:
            root = Path(temp).resolve()
            artifact = self._artifact(root)
            bundle, checksum, state = self._bundle(
                root, artifact, managed_root=root / "my..app"
            )

            completed = self._run(bundle, checksum, artifact, mode="install")

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertTrue(state.exists())

    @unittest.skipUnless(
        sys.platform == "win32",
        "PowerShell runtime test requires Windows",
    )
    def test_windows_dry_run_install_and_noop(self) -> None:
        """Exercise PowerShell mode transitions on Windows."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            artifact = root / "tool.zip"
            with zipfile.ZipFile(artifact, "w") as archive:
                archive.writestr("tool.exe", b"binary")
            bundle, checksum, state = self._bundle(root, artifact)
            for mode, result in (
                ("dry-run", "dry-run"),
                ("install", "success"),
                ("install", "unchanged"),
            ):
                completed = self._run(bundle, checksum, artifact, mode=mode)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(json.loads(completed.stdout)["result"], result)
            self.assertTrue(state.exists())

    @unittest.skipUnless(
        sys.platform == "win32",
        "PowerShell iex runtime test requires Windows",
    )
    def test_windows_iex_pipeline_applies_environment_overrides(self) -> None:
        """Mirror the `irm ... | iex` delivery through in-memory execution."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            artifact = root / "tool.zip"
            with zipfile.ZipFile(artifact, "w") as archive:
                archive.writestr("tool.exe", b"binary")
            bundle, _, state = self._bundle(root, artifact)

            dry_run = self._run_iex(bundle, artifact, mode="dry-run")
            self.assertEqual(dry_run.returncode, 0, dry_run.stderr)
            payload = json.loads(dry_run.stdout)
            self.assertEqual(payload["result"], "dry-run")
            self.assertEqual(payload["releaseVersion"], "1.0.0")
            self.assertFalse(state.exists())

            invalid = self._run_iex(bundle, artifact, mode="bogus")
            self.assertNotEqual(invalid.returncode, 0)
            self.assertIn("Mode", invalid.stderr)

    @unittest.skipUnless(
        sys.platform == "win32",
        "PowerShell runtime test requires Windows",
    )
    def test_windows_rejects_broad_managed_root_before_writes(self) -> None:
        """Keep the runtime breadth check even if assembly is bypassed."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            artifact = root / "tool.zip"
            with zipfile.ZipFile(artifact, "w") as archive:
                archive.writestr("tool.exe", b"binary")
            bundle, checksum, _ = self._bundle(root, artifact)
            installed_script = bundle / "installer.ps1"
            original = installed_script.read_text(encoding="utf-8")

            for managed_root in (
                "C:\\Windows",
                "\\\\server\\share",
                "\\\\server\\Users\\me",
            ):
                with self.subTest(managed_root=managed_root):
                    rewritten = re.sub(
                        r"\$MANAGED_ROOT = \S+",
                        lambda _match, value=managed_root: (
                            f"$MANAGED_ROOT = '{value}'"
                        ),
                        original,
                        count=1,
                    )
                    self.assertNotEqual(rewritten, original)
                    installed_script.write_text(rewritten, encoding="utf-8")

                    completed = self._run(bundle, checksum, artifact, mode="dry-run")

                    self.assertNotEqual(completed.returncode, 0)
                    self.assertTrue(
                        any(
                            message in completed.stderr
                            for message in (
                                "managed root is too broad",
                                "invalid managed root",
                                "path escapes managed root",
                            )
                        ),
                        completed.stderr,
                    )

    @unittest.skipUnless(
        sys.platform == "win32",
        "PowerShell runtime test requires Windows",
    )
    def test_windows_repair_requires_matching_installed_state(self) -> None:
        """Repair needs the installed release and its original checksums."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            managed = root / "managed"
            first_root = root / "first"
            first_root.mkdir()
            first_artifact = first_root / "tool.zip"
            with zipfile.ZipFile(first_artifact, "w") as archive:
                archive.writestr("tool.exe", b"original")
            first_bundle, first_checksum, state = self._bundle(
                first_root, first_artifact, managed_root=managed
            )
            absent = self._run(
                first_bundle, first_checksum, first_artifact, mode="repair"
            )
            self.assertNotEqual(absent.returncode, 0)
            self.assertFalse(state.exists())

            installed = self._run(
                first_bundle, first_checksum, first_artifact, mode="install"
            )
            self.assertEqual(installed.returncode, 0, installed.stderr)
            previous_state = state.read_bytes()
            release_binary = managed / "releases/1.0.0/tool.exe"
            release_binary.write_bytes(b"damaged")
            second_root = root / "second"
            second_root.mkdir()
            second_artifact = second_root / "tool.zip"
            with zipfile.ZipFile(second_artifact, "w") as archive:
                archive.writestr("tool.exe", b"different")
            second_bundle, second_checksum, _ = self._bundle(
                second_root, second_artifact, managed_root=managed
            )
            mismatch = self._run(
                second_bundle, second_checksum, second_artifact, mode="repair"
            )
            self.assertNotEqual(mismatch.returncode, 0)
            self.assertEqual(state.read_bytes(), previous_state)
            self.assertEqual(release_binary.read_bytes(), b"damaged")

    @unittest.skipUnless(
        sys.platform == "win32",
        "PowerShell runtime test requires Windows",
    )
    def test_windows_upgrade_rejects_same_version_checksum_change(self) -> None:
        """Reject a repacked artifact that reuses the installed version."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            managed = root / "managed"
            first_root = root / "first"
            first_root.mkdir()
            first_artifact = first_root / "tool.zip"
            with zipfile.ZipFile(first_artifact, "w") as archive:
                archive.writestr("tool.exe", b"original")
            first_bundle, first_checksum, state = self._bundle(
                first_root, first_artifact, managed_root=managed
            )
            installed = self._run(
                first_bundle, first_checksum, first_artifact, mode="install"
            )
            self.assertEqual(installed.returncode, 0, installed.stderr)
            previous_state = state.read_bytes()
            second_root = root / "second"
            second_root.mkdir()
            second_artifact = second_root / "tool.zip"
            with zipfile.ZipFile(second_artifact, "w") as archive:
                archive.writestr("tool.exe", b"different")
            second_bundle, second_checksum, _ = self._bundle(
                second_root,
                second_artifact,
                managed_root=managed,
                release_path=managed / "releases" / "1.0.0-repack",
            )

            rejected = self._run(
                second_bundle, second_checksum, second_artifact, mode="upgrade"
            )

            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("same release version", rejected.stderr)
            self.assertEqual(state.read_bytes(), previous_state)
            self.assertFalse((managed / "releases/1.0.0-repack").exists())

    @unittest.skipUnless(
        sys.platform == "win32",
        "PowerShell runtime test requires Windows",
    )
    def test_windows_lock_conflict_fails_before_fetch(self) -> None:
        """Reject a concurrent run instead of starting a fixed download."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            managed = root / "managed"
            bundle_root = root / "bundle"
            bundle_root.mkdir()
            artifact = bundle_root / "tool.zip"
            with zipfile.ZipFile(artifact, "w") as archive:
                archive.writestr("tool.exe", b"binary")
            bundle, checksum, _ = self._bundle(
                bundle_root, artifact, managed_root=managed
            )
            lock = managed / "install.lock"
            lock.parent.mkdir(parents=True)
            lock.write_bytes(b"held")

            completed = self._run(
                bundle, checksum, artifact, mode="install", source_mode="online"
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn(
                "another installation owns the runtime lock", completed.stderr
            )

    @unittest.skipUnless(
        sys.platform == "win32",
        "PowerShell runtime test requires Windows",
    )
    def test_windows_installer_ignores_path_tar(self) -> None:
        """Ignore a PATH tar so extraction keeps using the bundled bsdtar."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            artifact = root / "tool.zip"
            with zipfile.ZipFile(artifact, "w") as archive:
                archive.writestr("tool.exe", b"binary")
            bundle, checksum, state = self._bundle(root, artifact)
            fake_bin = root / "fake-bin"
            fake_bin.mkdir()
            # PATH 上の tar が選ばれると展開に失敗する stub を先頭へ置く。
            fake_tar = fake_bin / "tar.cmd"
            fake_tar.write_text("@echo off\r\nexit /b 1\r\n", encoding="utf-8")
            environment = dict(os.environ)
            environment["PATH"] = f"{fake_bin}{os.pathsep}{environment['PATH']}"

            installed = self._run(
                bundle, checksum, artifact, mode="install", env=environment
            )

            self.assertEqual(installed.returncode, 0, installed.stderr)
            self.assertTrue(state.exists())
            self.assertEqual(
                (root / "managed/releases/1.0.0/tool.exe").read_bytes(), b"binary"
            )

    @unittest.skipUnless(
        sys.platform == "win32",
        "PowerShell runtime test requires Windows",
    )
    def test_windows_repair_keeps_release_until_staging_succeeds(self) -> None:
        """Keep the installed release while the staged archive is unverified."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            managed = root / "managed"
            bundle_root = root / "bundle"
            bundle_root.mkdir()
            artifact = bundle_root / "tool.zip"
            with zipfile.ZipFile(artifact, "w") as archive:
                archive.writestr("tool.exe", b"original")
            bundle, checksum, _ = self._bundle(
                bundle_root, artifact, managed_root=managed
            )
            installed = self._run(bundle, checksum, artifact, mode="install")
            self.assertEqual(installed.returncode, 0, installed.stderr)
            release_binary = managed / "releases/1.0.0/tool.exe"
            release_binary.write_bytes(b"damaged")
            real_tar = Path(os.environ["SystemRoot"]) / "System32" / "tar.exe"
            fake_bin = root / "fake-bin"
            fake_bin.mkdir()
            tar_log = root / "tar.log"
            fake_tar = fake_bin / "tar.cmd"
            fake_tar.write_text(
                "@echo off\r\n"
                f'echo %* >> "{tar_log}"\r\n'
                'echo %* | findstr /C:".staging" >nul && exit /b 1\r\n'
                f'"{real_tar}" %*\r\n',
                encoding="utf-8",
            )
            # 同梱 tar の絶対解決は固定のため、組立済み script の解決式だけを stub へ
            # 差し替え、managed staging の extraction 失敗を再現する。
            script_path = bundle / "installer.ps1"
            script = script_path.read_text(encoding="utf-8")
            resolved = "Join-Path $env:SystemRoot 'System32\\tar.exe'"
            self.assertIn(resolved, script)
            script_path.write_text(
                script.replace(resolved, f"'{fake_tar}'"), encoding="utf-8"
            )

            failed = self._run(bundle, checksum, artifact, mode="repair")

            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("archive extraction failed", failed.stderr)
            self.assertIn(".staging", tar_log.read_text(encoding="utf-8"))
            self.assertEqual(release_binary.read_bytes(), b"damaged")
            self.assertFalse(list(managed.glob(".previous-release-*")))

    @unittest.skipUnless(
        sys.platform == "win32",
        "PowerShell runtime test requires Windows",
    )
    def test_windows_launcher_replace_failure_keeps_previous_launcher(self) -> None:
        """Keep the previous launcher and leave no temporary launcher behind."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            environment = dict(os.environ)
            environment["LOCALAPPDATA"] = str(root)
            first_root = root / "first"
            first_root.mkdir()
            first_output, first_artifact = self._per_user_windows_bundle(first_root)
            installed = self._run(
                first_output, "", first_artifact, mode="install", env=environment
            )
            self.assertEqual(installed.returncode, 0, installed.stderr)
            launcher = root / "Programs/example-vendor/example-app/bin/example-app.exe"
            previous_launcher = launcher.read_bytes()
            launcher.chmod(stat.S_IREAD)
            second_root = root / "second"
            second_root.mkdir()
            second_output, second_artifact = self._per_user_windows_bundle(
                second_root, version="2.0.0"
            )

            failed = self._run(
                second_output, "", second_artifact, mode="upgrade", env=environment
            )

            self.assertNotEqual(failed.returncode, 0)
            launcher.chmod(stat.S_IWRITE)
            self.assertEqual(launcher.read_bytes(), previous_launcher)
            self.assertFalse(list(launcher.parent.glob(".launcher-*.tmp")))

    @unittest.skipUnless(
        sys.platform == "win32",
        "PowerShell runtime test requires Windows",
    )
    def test_windows_rejects_unmanaged_launcher_copy(self) -> None:
        """Keep an existing non-managed launcher copy unchanged."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            output, artifact = self._per_user_windows_bundle(root)
            environment = dict(os.environ)
            environment["LOCALAPPDATA"] = str(root)
            launcher = root / "Programs/example-vendor/example-app/bin/example-app.exe"
            launcher.parent.mkdir(parents=True)
            launcher.write_bytes(b"user file")

            completed = self._run(output, "", artifact, mode="install", env=environment)

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("not installer-managed", completed.stderr)
            self.assertEqual(launcher.read_bytes(), b"user file")

    @unittest.skipUnless(
        sys.platform == "win32",
        "PowerShell runtime test requires Windows",
    )
    def test_windows_rejects_launcher_parent_traversal(self) -> None:
        """Reject empty and relative launcher components if assembly is bypassed."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            output, artifact = self._per_user_windows_bundle(root)
            environment = dict(os.environ)
            environment["LOCALAPPDATA"] = str(root)
            script_path = output / "installer.ps1"
            script = script_path.read_text(encoding="utf-8")
            rewritten = re.sub(
                r"\$LAUNCHER_PATH = \S+",
                lambda _match: (
                    "$LAUNCHER_PATH = '%LOCALAPPDATA%\\Programs\\..\\evil.exe'"
                ),
                script,
                count=1,
            )
            self.assertNotEqual(rewritten, script)
            script_path.write_text(rewritten, encoding="utf-8")

            completed = self._run(output, "", artifact, mode="dry-run", env=environment)

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("must not contain", completed.stderr)

    @unittest.skipUnless(sys.platform == "win32", "requires Windows junctions")
    def test_windows_rejects_relative_launcher_when_assembly_is_bypassed(self) -> None:
        """Reject relative runtime input before working-directory resolution."""
        for launcher in ("example-app.exe", "C:example-app.exe"):
            with self.subTest(launcher=launcher), tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve()
                output, artifact = self._per_user_windows_bundle(root, system_wide=True)
                environment = dict(os.environ, ProgramFiles=str(root / "Program Files"))
                script_path = output / "installer.ps1"
                script = script_path.read_text(encoding="utf-8")
                rewritten = re.sub(
                    r"\$LAUNCHER_PATH = [^\n]+",
                    f"$LAUNCHER_PATH = '{launcher}'",
                    script,
                    count=1,
                )
                self.assertNotEqual(rewritten, script)
                script_path.write_text(rewritten, encoding="utf-8")
                completed = self._run(
                    output, "", artifact, mode="dry-run", env=environment
                )
                self.assertNotEqual(completed.returncode, 0)
                self.assertIn("launcher path must be absolute", completed.stderr)
                self.assertFalse((root / "managed").exists())

    @unittest.skipUnless(sys.platform == "win32", "requires Windows junctions")
    def test_windows_rejects_launcher_parent_junction_without_changes(self) -> None:
        """Reject redirected Windows launcher parents before placement."""
        for mode in ("install", "dry-run"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve()
                output, artifact = self._per_user_windows_bundle(root)
                environment = dict(os.environ, LOCALAPPDATA=str(root))
                outside = root / "outside"
                outside.mkdir()
                junction = root / "Programs"
                created = subprocess.run(
                    ["cmd", "/c", "mklink", "/J", str(junction), str(outside)],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(created.returncode, 0, created.stderr)
                try:
                    completed = self._run(
                        output, "", artifact, mode=mode, env=environment
                    )
                    self.assertNotEqual(completed.returncode, 0)
                    self.assertIn("reparse point", completed.stderr)
                    self.assertEqual(list(outside.iterdir()), [])
                    self.assertFalse((root / "example-vendor").exists())
                finally:
                    junction.rmdir()

    @unittest.skipUnless(sys.platform == "win32", "requires Windows runtime")
    def test_windows_system_wide_checks_target_program_files(self) -> None:
        """Accept the target base and reject a different base without placement."""
        for accepted in (True, False):
            with self.subTest(accepted=accepted), tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve()
                output, artifact = self._per_user_windows_bundle(root, system_wide=True)
                script_path = output / "installer.ps1"
                script = script_path.read_text(encoding="utf-8")
                boundary_error = "throw 'launcher path is outside the allowed base'"
                self.assertEqual(script.count(boundary_error), 1)
                diagnostic_error = (
                    "throw ('launcher path is outside the allowed base: ' + "
                    "(@{ launcher = $launcher; allowedBase = $launcherBase; "
                    "programFiles = $env:ProgramFiles } | ConvertTo-Json -Compress))"
                )
                script_path.write_text(
                    script.replace(boundary_error, diagnostic_error), encoding="utf-8"
                )
                program_files = root / ("Program Files" if accepted else "other-base")
                environment = dict(os.environ, ProgramFiles=str(program_files))
                completed = self._run(
                    output, "", artifact, mode="install", env=environment
                )
                if accepted:
                    self.assertEqual(completed.returncode, 0, completed.stderr)
                    self.assertTrue((root / "Program Files/example-app.exe").is_file())
                else:
                    self.assertNotEqual(completed.returncode, 0)
                    self.assertIn("outside the allowed base", completed.stderr)
                    self.assertFalse((root / "managed").exists())
                    self.assertFalse((root / "Program Files").exists())

    @unittest.skipUnless(sys.platform == "win32", "requires Windows runtime")
    def test_windows_dry_run_rejects_unsafe_existing_state(self) -> None:
        """Reject unsafe existing Windows paths without changing them."""
        for case in ("launcher", "state", "pointer"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve()
                output, artifact = self._per_user_windows_bundle(root)
                environment = dict(os.environ, LOCALAPPDATA=str(root))
                managed = root / "example-vendor/example-app/standalone"
                paths = {
                    "launcher": root
                    / "Programs/example-vendor/example-app/bin/example-app.exe",
                    "state": managed / "state/install.state",
                    "pointer": managed / "current",
                }
                path = paths[case]
                path.parent.mkdir(parents=True)
                path.write_bytes(b"user data" if case != "pointer" else b"")
                before = path.read_bytes()
                completed = self._run(
                    output, "", artifact, mode="dry-run", env=environment
                )
                self.assertNotEqual(completed.returncode, 0)
                self.assertEqual(path.read_bytes(), before)
                self.assertFalse((managed / "releases").exists())
                self.assertFalse((managed / "install.lock").exists())


if __name__ == "__main__":
    unittest.main()
