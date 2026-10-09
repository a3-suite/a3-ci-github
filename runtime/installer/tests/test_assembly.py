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
            unix = {"linux-x86_64", "macos-arm64"}
            platforms = {target: {"manifest": f"{target}.json", "assetName": f"install-{target}.ps1" if target.startswith("windows") else f"install-{target}.sh"} for target in ["linux-x86_64", "macos-arm64", "windows-x86_64"]}
            shared = {"schemaVersion": "installer.assembly.v1", "useCase": "github-release-native-shared", "verificationProfile": "shared-exact-payload-v1", "platforms": platforms, "sharedWrapper": {"assetName": "install.sh", "deliveryUrls": {target: f"https://example.invalid/{platforms[target]['assetName']}" for target in unix}}}
            for selected in [platforms, {target: platforms[target] for target in unix}]:
                with self.subTest(selected=selected):
                    value = {**shared, "platforms": selected}
                    config_path.write_text(json.dumps(value))
                    self.assertEqual(assembly.config_for({"configPath": str(config_path)}), value)
            example = json.loads((ROOT.parents[1] / "skills/installer/assets/examples/standard-assembly.example.json").read_text(encoding="utf-8"))
            config_path.write_text(json.dumps(example))
            self.assertEqual(assembly.config_for({"configPath": str(config_path)}), example)
            for urls in [{}, {"linux-x86_64": "https://example.invalid/linux.sh"}, {**shared["sharedWrapper"]["deliveryUrls"], "windows-x86_64": "https://example.invalid/windows.ps1"}]:
                with self.subTest(urls=urls):
                    config_path.write_text(json.dumps({**shared, "sharedWrapper": {**shared["sharedWrapper"], "deliveryUrls": urls}}))
                    with self.assertRaisesRegex(ValueError, "installer-wrapper-urls-invalid"):
                        assembly.config_for({"configPath": str(config_path)})
            for selected in [{"windows-x86_64": platforms["windows-x86_64"]}, {"linux-x86_64": platforms["linux-x86_64"]}]:
                with self.subTest(selected=selected):
                    config_path.write_text(json.dumps({**shared, "platforms": selected}))
                    with self.assertRaisesRegex(ValueError, "installer-shared-platform-unsupported"):
                        assembly.config_for({"configPath": str(config_path)})
            for changes in [{"unknown": True}, {"verificationProfile": "unselected"}, {"useCase": "npm-package"}, {"platforms": {}}, {"platforms": {"windows-arm64": {}}}, {"platforms": {"linux-x86_64": {"manifest": "product.json", "assetName": "manifest-linux-x86_64.json"}}}]:
                with self.subTest(changes=changes):
                    config_path.write_text(json.dumps({**native, **changes}))
                    with self.assertRaises((ValueError, TypeError)):
                        assembly.config_for({"configPath": str(config_path)})

    def test_native_bindings_use_targets_and_preserve_release_subsets(self) -> None:
        platforms = [
            {"id": "linux-release", "target": "x86_64-unknown-linux-gnu"},
            {"id": "macos-release", "target": "aarch64-apple-darwin"},
            {"id": "windows-release", "target": "x86_64-pc-windows-msvc"},
            {"id": "unselected", "target": "aarch64-unknown-linux-musl"},
        ]
        for native, expected_id in [("linux-x86_64", "linux-release"), ("macos-arm64", "macos-release"), ("windows-x86_64", "windows-release")]:
            with self.subTest(native=native):
                config = {"platforms": {native: {}}}
                self.assertEqual(assembly.platform_bindings({"releasePlatforms": platforms}, config)[native]["id"], expected_id)
                for entries in [[], [{"id": "unsupported", "target": "unsupported"}], platforms + [{"id": "ambiguous", "target": next(p["target"] for p in platforms if p["id"] == expected_id)}]]:
                    with self.subTest(entries=entries), self.assertRaisesRegex(ValueError, "installer-platform-binding-invalid"):
                        assembly.platform_bindings({"releasePlatforms": entries}, config)

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
            release_id = "release-native"
            triple = "aarch64-apple-darwin" if sys.platform == "darwin" else "x86_64-unknown-linux-gnu"
            release_platforms = [{"id": release_id, "target": triple, "runner": "macos-14" if sys.platform == "darwin" else "ubuntu-24.04"}]
            (root / "product.json").write_text(json.dumps(manifest))
            config = {"schemaVersion": "installer.assembly.v1", "useCase": "github-release-native", "verificationProfile": "native-offline-dry-run-v1", "platforms": {target: {"manifest": "product.json", "assetName": "install.sh"}}}
            (root / "assembly.json").write_text(json.dumps(config))
            standard = root / "standard" / ("release-build-" + release_id)
            standard.mkdir(parents=True)
            shutil.copyfile(artifact, standard / artifact.name)
            checksum = assembly.digest(artifact)
            (standard / (artifact.name + ".sha256")).write_bytes(f"{checksum}  {artifact.name}\n".encode("utf-8"))
            build = {"schema_version": "1", "kind": "ci-release-build-manifest", "source_sha": test_runtime_installer.REVISION, "version": "1.0.0", "platform_id": release_id, "platform_target": triple, "assets": [{"path": artifact.name, "sha256": checksum, "checksum_path": artifact.name + ".sha256"}]}
            (standard / "asset-manifest.json").write_text(json.dumps(build))
            supplemental = root / "supplemental"
            supplemental.mkdir()
            output = supplemental / ("supplemental-build-" + release_id)
            request = {"releasePlatforms": release_platforms, "sourceRoot": str(root), "configPath": str(root / "assembly.json"), "authority": {"source_sha": test_runtime_installer.REVISION, "version": "1.0.0", "tag": "v1.0.0", "publication": {"repository": "example-org/example-app"}}, "assemblyId": "assembly-1", "providerRevision": "a" * 40, "standardBuildRoot": str(standard), "outputDirectory": str(output), "operation": "build-platform"}
            result = self._run_provider(request)
            self.assertEqual(result.returncode, 0, result.stderr)
            build_path = standard / "asset-manifest.json"
            for index, (field, value) in enumerate([("version", "2.0.0"), ("platform_id", "other-release"), ("platform_target", "unsupported"), ("assets", []), ("assets", [{**build["assets"][0], "sha256": "0" * 64}])]):
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
                (output / "platform-record.json", "platformId", "other-release"),
                (output / "platform-record.json", "platformTarget", "unsupported"),
                (output / "platform-record.json", "nativePlatformId", "windows-x86_64"),
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
            windows_root = root / "windows"
            windows_root.mkdir()
            windows_bundle, windows_artifact = legacy._per_user_windows_bundle(windows_root)
            shutil.copyfile(windows_bundle / "manifest-windows-x86_64.json", root / "windows.json")
            platforms["windows-x86_64"] = {"manifest": "windows.json", "assetName": "install-windows-x86_64.ps1"}
            (root / "assembly.json").write_text(json.dumps(config))
            release_platforms = [{"id": "release-linux", "target": "x86_64-unknown-linux-gnu"}, {"id": "release-macos", "target": "aarch64-apple-darwin"}, {"id": "release-windows", "target": "x86_64-pc-windows-msvc"}]
            standard_root, supplemental_root = root / "standard", root / "supplemental"
            standard_root.mkdir()
            supplemental_root.mkdir()
            request = {"releasePlatforms": release_platforms, "sourceRoot": str(root), "configPath": str(root / "assembly.json"), "authority": {"source_sha": test_runtime_installer.REVISION, "version": "1.0.0", "tag": "v1.0.0", "publication": {"repository": "example-org/example-app"}}, "assemblyId": "assembly-1", "providerRevision": "a" * 40}
            for target in platforms:
                binding = next(entry for entry in release_platforms if assembly.NATIVE_TARGETS[entry["target"]] == target)
                selected_artifact = windows_artifact if target == "windows-x86_64" else artifact
                standard = standard_root / ("release-build-" + binding["id"])
                standard.mkdir()
                shutil.copyfile(selected_artifact, standard / selected_artifact.name)
                checksum = assembly.digest(selected_artifact)
                (standard / (selected_artifact.name + ".sha256")).write_bytes(f"{checksum}  {selected_artifact.name}\n".encode("utf-8"))
                assembly.write_json(standard / "asset-manifest.json", {"schema_version": "1", "kind": "ci-release-build-manifest", "source_sha": test_runtime_installer.REVISION, "version": "1.0.0", "platform_id": binding["id"], "platform_target": binding["target"], "assets": [{"path": selected_artifact.name, "sha256": checksum, "checksum_path": selected_artifact.name + ".sha256"}]})
                output = supplemental_root / ("supplemental-build-" + binding["id"])
                output.mkdir()
                scratch = root / ("scratch-" + target)
                scratch.mkdir()
                host = {"linux-x86_64": ("Linux", "x86_64"), "macos-arm64": ("Darwin", "arm64"), "windows-x86_64": ("Windows", "AMD64")}[target]
                with patch.object(assembly.platform, "system", return_value=host[0]), patch.object(assembly.platform, "machine", return_value=host[1]), patch.object(assembly, "verify_native") as native_verification:
                    assembly.platform_record({**request, "standardBuildRoot": str(standard)}, config, output, scratch)
                    native_verification.assert_called_once_with(output / "candidate", platforms[target]["assetName"], f"manifest-{target}.json", standard / selected_artifact.name)
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
            self.assertEqual({entry["path"] for entry in handoff["assets"]}, {"install.sh", *(entry["assetName"] for entry in platforms.values()), *(f"manifest-{target}.json" for target in platforms)})
            wrapper_evidence = assembly.read_json(root / "handoff/install.sh.owner.json")["installerEvidence"]
            self.assertEqual(set(wrapper_evidence["platform_installers"]), {"linux-x86_64", "macos-arm64"})
            windows_script = supplemental_root / "supplemental-build-release-windows/candidate/install-windows-x86_64.ps1"
            windows_script.write_bytes(windows_script.read_bytes() + b"\n# changed after verification\n")
            with self.assertRaisesRegex(ValueError, "installer-platform-evidence-invalid"):
                assembly.run({**assembly_request, "outputDirectory": str(root / "failed-windows")})
            self.assertFalse((root / "failed-windows/supplemental-manifest.json").exists())
            self.assertFalse((root / "handoff/tmp").exists())
            self.assertFalse((root / "managed").exists())


if __name__ == "__main__":
    unittest.main()
