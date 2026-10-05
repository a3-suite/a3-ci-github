"""Provider assembly checks; mocked host labels do not establish native OS proof."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import assembly
import test_runtime_installer


class StandardAssemblyTest(unittest.TestCase):
    def test_profiles_reject_unsupported_inputs_and_colliding_assets(self) -> None:
        temporary_root = ROOT / "tests/tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary_root) as temporary:
            config_path = Path(temporary) / "assembly.json"
            native = {"schemaVersion": "installer.assembly.v1", "useCase": "github-release-native", "verificationProfile": "native-offline-dry-run-v1", "platforms": {"linux-x86_64": {"manifest": "product.json", "assetName": "install.sh"}}}
            config_path.write_text(json.dumps(native))
            self.assertEqual(assembly.config_for({"configPath": str(config_path)}), native)
            for changes in [{"unknown": True}, {"verificationProfile": "unselected"}, {"useCase": "npm-package"}, {"platforms": {}}, {"platforms": {"windows-arm64": {}}}, {"platforms": {"linux-x86_64": {"manifest": "product.json", "assetName": "manifest-linux-x86_64.json"}}}]:
                with self.subTest(changes=changes):
                    config_path.write_text(json.dumps({**native, **changes}))
                    with self.assertRaises((ValueError, TypeError)):
                        assembly.config_for({"configPath": str(config_path)})

    @unittest.skipIf(sys.platform == "win32", "Unix archive fixture; Windows has native boundary CI")
    def test_native_provider_boundary_rejects_transport_drift(self) -> None:
        """Run the native profile and reject altered records before emitting a handoff."""
        temporary_root = ROOT / "tests/tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary_root) as temporary:
            root = Path(temporary).resolve()
            runtime = test_runtime_installer.RuntimeInstallerTest()
            artifact = runtime._artifact(root)
            bundle, _, _ = runtime._bundle(root, artifact)
            manifest = json.loads(next(bundle.glob("manifest-*.json")).read_text())
            target = manifest["targetPlatformId"]
            (root / "product.json").write_text(json.dumps(manifest))
            config = {"schemaVersion": "installer.assembly.v1", "useCase": "github-release-native", "verificationProfile": "native-offline-dry-run-v1", "platforms": {target: {"manifest": "product.json", "assetName": "install.sh"}}}
            (root / "assembly.json").write_text(json.dumps(config))
            standard = root / "standard" / ("release-build-" + target)
            standard.mkdir(parents=True)
            shutil.copyfile(artifact, standard / artifact.name)
            checksum = assembly.digest(artifact)
            (standard / (artifact.name + ".sha256")).write_text(f"{checksum}  {artifact.name}\n")
            build = {"schema_version": "1", "kind": "ci-release-build-manifest", "source_sha": test_runtime_installer.REVISION, "version": "1.0.0", "platform_id": target, "platform_target": "fixture", "assets": [{"path": artifact.name, "sha256": checksum, "checksum_path": artifact.name + ".sha256"}]}
            (standard / "asset-manifest.json").write_text(json.dumps(build))
            supplemental = root / "supplemental"
            supplemental.mkdir()
            output = supplemental / ("supplemental-build-" + target)
            request = {"sourceRoot": str(root), "configPath": str(root / "assembly.json"), "authority": {"source_sha": test_runtime_installer.REVISION, "version": "1.0.0", "tag": "v1.0.0", "publication": {"repository": "example-org/example-app"}}, "assemblyId": "assembly-1", "providerRevision": "a" * 40, "standardBuildRoot": str(standard), "outputDirectory": str(output), "operation": "build-platform"}
            result = self._run_provider(request)
            self.assertEqual(result.returncode, 0, result.stderr)
            build_path = standard / "asset-manifest.json"
            for index, (field, value) in enumerate([("version", "2.0.0"), ("assets", []), ("assets", [{**build["assets"][0], "sha256": "0" * 64}])]):
                with self.subTest(build_field=field, index=index):
                    changed = {**build, field: value}
                    build_path.write_text(json.dumps(changed))
                    rejected = root / f"failed-build-{index}"
                    attempt = self._run_provider({**request, "outputDirectory": str(rejected)})
                    self.assertEqual(attempt.returncode, 1, attempt.stderr)
                    self.assertFalse((rejected / "platform-record.json").exists())
                    self.assertFalse((rejected / "tmp").exists())
                    build_path.write_text(json.dumps(build))
            extra = standard / "extra"
            extra.write_text("unexpected")
            attempt = self._run_provider({**request, "outputDirectory": str(root / "failed-extra")})
            self.assertEqual(attempt.returncode, 1, attempt.stderr)
            self.assertFalse((root / "failed-extra/platform-record.json").exists())
            extra.unlink()
            assemble_request = {**request, "operation": "assemble", "standardBuildRoot": str(root / "standard"), "supplementalBuildRoot": str(supplemental)}
            success = self._run_provider({**assemble_request, "outputDirectory": str(root / "handoff")})
            self.assertEqual(success.returncode, 0, success.stderr)
            self.assertEqual(len(assembly.read_json(root / "handoff/supplemental-manifest.json")["assets"]), 2)
            self.assertFalse((root / "managed").exists())
            cases = [
                (output / "platform-record.json", "sourceSha", "b" * 40),
                (output / "platform-record.json", "files", {}),
                (output / "platform-record.json", "artifactChecksum", "0" * 64),
                (output / "candidate/installer-verification-evidence.json", "status", "failed"),
                (output / "candidate/installer-asset-evidence.json", "asset_checksum", "sha256:" + "0" * 64),
                (output / "candidate/installer-asset-evidence.json", "assembly_id", "other"),
                (standard / "asset-manifest.json", "assets", [{**build["assets"][0], "checksum_path": "wrong.sha256"}]),
                (standard / "asset-manifest.json", "version", "2.0.0"),
            ]
            for index, (filename, field, value) in enumerate(cases):
                with self.subTest(field=field):
                    original = filename.read_bytes()
                    data = json.loads(original)
                    data[field] = value
                    filename.write_text(json.dumps(data))
                    record_path = output / "platform-record.json"
                    record_original = record_path.read_bytes()
                    if filename.parent.name == "candidate":
                        record = json.loads(record_original)
                        record["files"][filename.name] = assembly.digest(filename)
                        record_path.write_text(json.dumps(record))
                    failed = root / f"failed-{index}"
                    attempt = self._run_provider({**assemble_request, "outputDirectory": str(failed)})
                    self.assertEqual(attempt.returncode, 1, attempt.stderr)
                    self.assertIn("installer-assembly-failed", attempt.stderr)
                    self.assertFalse((failed / "supplemental-manifest.json").exists())
                    self.assertFalse((failed / "tmp").exists())
                    filename.write_bytes(original)
                    if filename != record_path:
                        record_path.write_bytes(record_original)
            extra = supplemental / "unexpected"
            extra.mkdir()
            attempt = self._run_provider({**assemble_request, "outputDirectory": str(root / "failed-platform-set")})
            self.assertEqual(attempt.returncode, 1, attempt.stderr)
            self.assertFalse((root / "failed-platform-set/supplemental-manifest.json").exists())
            extra.rmdir()
            product_path = root / "product.json"
            product_original = product_path.read_bytes()
            bad_manifest = json.loads(product_original)
            bad_manifest["source"]["kind"] = "local"
            product_path.write_text(json.dumps(bad_manifest))
            attempt = self._run_provider({**request, "outputDirectory": str(root / "failed-source")})
            self.assertEqual(attempt.returncode, 1, attempt.stderr)
            self.assertFalse((root / "failed-source/platform-record.json").exists())
            product_path.write_bytes(product_original)
            invalid = self._run_provider({**request, "operation": "unknown", "outputDirectory": str(root / "invalid-operation")})
            self.assertEqual(invalid.returncode, 1)
            self.assertFalse((root / "invalid-operation/tmp").exists())

    @staticmethod
    def _run_provider(request: dict) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, str(ROOT / "src/assembly.py")], input=json.dumps(request), capture_output=True, text=True, check=False)

    def test_native_verification_rejects_successful_process_with_wrong_result(self) -> None:
        result = subprocess.CompletedProcess([], 0, stdout='{"result":"installed"}')
        with patch.object(assembly.subprocess, "run", return_value=result), self.assertRaisesRegex(ValueError, "installer-verification-failed"):
            assembly.verify_native(ROOT, "install.sh", "manifest.json", ROOT / "tool.tar.gz")

    def test_provider_rejects_invalid_config_and_generated_values(self) -> None:
        temporary_root = ROOT / "tests/tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary_root) as temporary:
            root = Path(temporary)
            path = root / "assembly.json"
            for payload in ["[]", "{}", "{"]:
                path.write_text(payload)
                result = self._run_provider({"configPath": str(path)})
                self.assertEqual(result.returncode, 1, result.stderr)
            with self.assertRaisesRegex(ValueError, "installer-input-invalid"):
                assembly.read_json(root / "missing")
            with self.assertRaisesRegex(ValueError, "installer-input-invalid"):
                assembly.digest(root)
            for value in ["../unsafe", "", 42]:
                with self.subTest(value=value), self.assertRaisesRegex(ValueError, "installer-name-invalid"):
                    assembly.name(value)
            platforms = {target: {"manifest": "product.json", "assetName": f"install-{target}.sh"} for target in ["linux-x86_64", "macos-arm64"]}
            shared = {"schemaVersion": "installer.assembly.v1", "useCase": "github-release-native-shared", "verificationProfile": "shared-exact-payload-v1", "platforms": platforms, "sharedWrapper": {"assetName": "install.sh", "deliveryUrls": {}}}
            path.write_text(json.dumps(shared))
            with self.assertRaisesRegex(ValueError, "installer-wrapper-urls-invalid"):
                assembly.config_for({"configPath": str(path)})
            del shared["sharedWrapper"]
            path.write_text(json.dumps(shared))
            with self.assertRaisesRegex(ValueError, "installer-shared-platform-unsupported"):
                assembly.config_for({"configPath": str(path)})
            with self.assertRaisesRegex(ValueError, "installer-generated-value-conflict"):
                assembly.generated("conflict", "expected", "<marker>")

    @unittest.skipIf(sys.platform == "win32", "standard shared wrapper is Unix only")
    def test_shared_profile_executes_exact_wrapper_and_native_payloads(self) -> None:
        temporary_root = ROOT / "tests/tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary_root) as temporary:
            root = Path(temporary).resolve()
            legacy = test_runtime_installer.RuntimeInstallerTest()
            artifact = legacy._artifact(root)
            bundle, _, _ = legacy._bundle(root, artifact)
            template = json.loads(next(bundle.glob("manifest-*.json")).read_text())
            # These records simulate cross-runner transport; only wrapper dispatch is executed here.
            for key, marker in [("releaseVersion", "<release-version>"), ("targetPlatformId", "<target-platform-id>")]:
                template[key] = marker
            template["provenance"]["ciRunId"] = "assembly-1"
            (root / "product.json").write_text(json.dumps(template))
            platforms = {target: {"manifest": "product.json", "assetName": f"install-{target}.sh"} for target in ["linux-x86_64", "macos-arm64"]}
            config = {"schemaVersion": "installer.assembly.v1", "useCase": "github-release-native-shared", "verificationProfile": "shared-exact-payload-v1", "platforms": platforms, "sharedWrapper": {"assetName": "install.sh", "deliveryUrls": {target: f"https://github.com/example-org/example-app/releases/download/v1.0.0/{entry['assetName']}" for target, entry in platforms.items()}}}
            (root / "assembly.json").write_text(json.dumps(config))
            standard_root, supplemental_root = root / "standard", root / "supplemental"
            standard_root.mkdir()
            supplemental_root.mkdir()
            request = {"sourceRoot": str(root), "configPath": str(root / "assembly.json"), "authority": {"source_sha": test_runtime_installer.REVISION, "version": "1.0.0", "tag": "v1.0.0", "publication": {"repository": "example-org/example-app"}}, "assemblyId": "assembly-1", "providerRevision": "a" * 40}
            for target in platforms:
                standard = standard_root / ("release-build-" + target)
                standard.mkdir()
                shutil.copyfile(artifact, standard / artifact.name)
                checksum = assembly.digest(artifact)
                (standard / (artifact.name + ".sha256")).write_text(f"{checksum}  {artifact.name}\n")
                assembly.write_json(standard / "asset-manifest.json", {"schema_version": "1", "kind": "ci-release-build-manifest", "source_sha": test_runtime_installer.REVISION, "version": "1.0.0", "platform_id": target, "platform_target": "fixture", "assets": [{"path": artifact.name, "sha256": checksum, "checksum_path": artifact.name + ".sha256"}]})
                output = supplemental_root / ("supplemental-build-" + target)
                output.mkdir()
                scratch = root / ("scratch-" + target)
                scratch.mkdir()
                with patch.object(assembly.platform, "system", return_value="Linux" if target.startswith("linux") else "Darwin"), patch.object(assembly.platform, "machine", return_value="x86_64" if target.startswith("linux") else "arm64"), patch.object(assembly, "verify_native"):
                    assembly.platform_record({**request, "standardBuildRoot": str(standard)}, config, output, scratch)
            assembly_request = {**request, "operation": "assemble", "standardBuildRoot": str(standard_root), "supplementalBuildRoot": str(supplemental_root)}
            failed_output = root / "failed-handoff"
            with patch.object(assembly, "verify_wrapper", side_effect=ValueError("injected-wrapper-profile-failure")), self.assertRaisesRegex(ValueError, "injected-wrapper-profile-failure"):
                assembly.run({**assembly_request, "outputDirectory": str(failed_output)})
            self.assertEqual(list(failed_output.iterdir()), [])
            wrong_result = subprocess.CompletedProcess([], 0, stdout='{"result":"installed"}')
            with patch.object(assembly.subprocess, "run", return_value=wrong_result), self.assertRaisesRegex(ValueError, "installer-wrapper-verification-failed"):
                assembly.run({**assembly_request, "outputDirectory": str(root / "failed-result")})
            self.assertFalse((root / "failed-result/supplemental-manifest.json").exists())
            assembly.run({**assembly_request, "outputDirectory": str(root / "handoff")})
            handoff = assembly.read_json(root / "handoff/supplemental-manifest.json")
            self.assertEqual(len(handoff["assets"]), 5)
            self.assertFalse((root / "handoff/tmp").exists())
            self.assertFalse((root / "managed").exists())


if __name__ == "__main__":
    unittest.main()
