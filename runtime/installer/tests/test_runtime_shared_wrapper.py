"""Exercise the assembled shared wrapper through the POSIX pipe path."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

BUNDLE_ROOT = Path(__file__).resolve().parents[1]
BUILDER = BUNDLE_ROOT / "src/build-shared-wrapper.py"
SOURCE = BUNDLE_ROOT / "src/wrapper"
REVISION = "0123456789abcdef0123456789abcdef01234567"
PLATFORMS = ("linux-x86_64", "macos-arm64")
UNAME = {
    "linux-x86_64": ("Linux", "x86_64"),
    "macos-arm64": ("Darwin", "arm64"),
    "unsupported": ("FreeBSD", "amd64"),
}


def _temporary_directory() -> tempfile.TemporaryDirectory[str]:
    temp_root = BUNDLE_ROOT / "tests/tmp"
    if temp_root.is_symlink():
        raise RuntimeError("test temporary root must not be a symlink")
    temp_root.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=temp_root)


class SharedWrapperRuntimeTest(unittest.TestCase):
    """Check the shared wrapper through its public pipe execution boundary."""

    def test_sh_wrapper_selects_platform_payload_and_forwards_env(self) -> None:
        """Detect the platform, verify the payload, then execute it."""
        for platform in PLATFORMS:
            with self.subTest(platform=platform), _temporary_directory() as temporary_root:
                root = Path(temporary_root)
                wrapper, payload_log = self._bundle(root)
                environment = self._environment(
                    root, platform, payload_log, mode="upgrade"
                )

                completed = self._run(wrapper, environment)

                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(
                    payload_log.read_text(encoding="utf-8"),
                    "ran\narg=--mode\narg=upgrade\n",
                )

    def test_dash_runs_the_same_posix_wrapper(self) -> None:
        """Keep the wrapper POSIX sh compatible, not bash specific."""
        if shutil.which("dash") is None:
            self.skipTest("dash is not available")
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root)
            wrapper, payload_log = self._bundle(root)
            environment = self._environment(
                root, "linux-x86_64", payload_log, mode=None
            )

            completed = self._run(wrapper, environment, shell="dash")

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(payload_log.read_text(encoding="utf-8"), "ran\n")

    def test_sh_wrapper_rejects_payload_checksum_mismatch(self) -> None:
        """Do not execute a payload that does not match the embedded checksum."""
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root)
            wrapper, payload_log = self._bundle(root)
            tampered = root / "tampered" / "install-linux-x86_64.sh"
            tampered.parent.mkdir()
            tampered.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            environment = self._environment(
                root, "linux-x86_64", payload_log, mode=None
            )
            environment["FAKE_CURL_DIR"] = str(tampered.parent)
            environment["FAKE_CURL_NAME"] = tampered.name

            completed = self._run(wrapper, environment)

            self.assertEqual(completed.returncode, 2)
            self.assertIn("checksum mismatch", completed.stderr)
            self.assertFalse(payload_log.exists())

    def test_sh_wrapper_rejects_unknown_platform(self) -> None:
        """Reject platforms outside the standard candidates before download."""
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root)
            wrapper, payload_log = self._bundle(root)
            environment = self._environment(root, "unsupported", payload_log, mode=None)

            completed = self._run(wrapper, environment)

            self.assertEqual(completed.returncode, 2)
            self.assertIn("unsupported target platform", completed.stderr)
            self.assertFalse(payload_log.exists())

    def test_truncated_wrapper_does_not_execute_payload(self) -> None:
        """Every byte-level truncation of the piped wrapper must stop the payload."""
        with _temporary_directory() as temporary_root:
            root = Path(temporary_root)
            wrapper, payload_log = self._bundle(root)
            script = wrapper.read_bytes()
            tail_start = script.index(b"runner=")
            environment = self._environment(
                root, "linux-x86_64", payload_log, mode="dry-run"
            )
            # 末尾の改行だけを落とした切断は内容欠落ではないため除外する。
            for offset in range(1, len(script) - tail_start - 1):
                completed = subprocess.run(
                    ["sh"],
                    input=script[: tail_start + offset],
                    check=False,
                    capture_output=True,
                    env=environment,
                )

                self.assertFalse(
                    payload_log.exists(),
                    f"cut offset {offset}: {completed.stderr.decode(errors='replace')}",
                )

    def _bundle(self, root: Path) -> tuple[Path, Path]:
        payload_dir = root / "payloads"
        payload_dir.mkdir()
        installer_args: list[str] = []
        for platform in PLATFORMS:
            payload = payload_dir / f"install-{platform}.sh"
            payload.write_text(
                "#!/usr/bin/env bash\n"
                "set -eu\n"
                'printf "ran\\n" >> "$PAYLOAD_LOG"\n'
                'for arg in "$@"; do\n'
                '  printf "arg=%s\\n" "$arg" >> "$PAYLOAD_LOG"\n'
                "done\n",
                encoding="utf-8",
            )
            payload.chmod(0o755)
            installer_args += [
                "--platform-installer",
                f"{platform}={payload}",
                "--installer-url",
                (
                    f"{platform}="
                    "https://github.com/example-org/example-app/releases/download/"
                    f"v1.0.0/{payload.name}"
                ),
            ]
        output = root / "output"
        completed = subprocess.run(
            [
                sys.executable,
                str(BUILDER),
                "assemble",
                "--source-dir",
                str(SOURCE),
                "--output-dir",
                str(output),
                "--asset-name",
                "install.sh",
                "--source-revision",
                REVISION,
                "--assembly-id",
                "assembly-1",
                *installer_args,
            ],
            cwd=BUNDLE_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return output / "install.sh", root / "payload.log"

    def _environment(
        self,
        root: Path,
        platform: str,
        payload_log: Path,
        *,
        mode: str | None,
    ) -> dict[str, str]:
        fake_bin = root / "fake-bin"
        if not fake_bin.exists():
            fake_bin.mkdir()
            uname_s, uname_m = UNAME.get(platform, UNAME["unsupported"])
            uname = fake_bin / "uname"
            uname.write_text(
                "#!/bin/sh\n"
                'case "$1" in\n'
                f"  -s) printf '%s\\n' '{uname_s}' ;;\n"
                f"  -m) printf '%s\\n' '{uname_m}' ;;\n"
                "esac\n",
                encoding="utf-8",
            )
            uname.chmod(0o755)
            curl = fake_bin / "curl"
            curl.write_text(
                "#!/bin/sh\n"
                "out=''\n"
                "url=''\n"
                "while [ $# -gt 0 ]; do\n"
                '  case "$1" in\n'
                "    --output) out=$2; shift 2 ;;\n"
                "    --*) shift ;;\n"
                "    *) url=$1; shift ;;\n"
                "  esac\n"
                "done\n"
                "name=${FAKE_CURL_NAME:-${url##*/}}\n"
                'cp "$FAKE_CURL_DIR/$name" "$out"\n',
                encoding="utf-8",
            )
            curl.chmod(0o755)
        environment = os.environ.copy()
        environment["PATH"] = f"{fake_bin}:{environment['PATH']}"
        environment["FAKE_CURL_DIR"] = str(root / "payloads")
        environment["PAYLOAD_LOG"] = str(payload_log)
        if mode is not None:
            environment["INSTALLER_MODE"] = mode
        return environment

    def _run(
        self,
        wrapper: Path,
        environment: dict[str, str],
        *,
        shell: str = "sh",
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [shell, str(wrapper)],
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )


if __name__ == "__main__":
    unittest.main()
