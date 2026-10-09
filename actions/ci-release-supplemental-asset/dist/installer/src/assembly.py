"""Provider-owned standard assembly; the Node boundary binds all project inputs."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from types import ModuleType

from builder_common import _checksum_bytes

ROOT = Path(__file__).resolve().parent
OWNER_CONTRACT = "installer.asset-assembly-evidence-contract"
POSIX_SHELL = "/bin/sh"
NATIVE_TARGETS = {
    "x86_64-unknown-linux-gnu": "linux-x86_64",
    "aarch64-apple-darwin": "macos-arm64",
    "x86_64-pc-windows-msvc": "windows-x86_64",
}
PLATFORMS = set(NATIVE_TARGETS.values())
SHARED_PLATFORMS = {"linux-x86_64", "macos-arm64"}


def load_builder(name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), ROOT / f"{name}.py")
    if spec is None or spec.loader is None:
        raise ValueError("installer-runtime-missing")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def obj(value: object) -> dict:
    if not isinstance(value, dict):
        raise TypeError("installer-config-invalid")
    return value


def read_json(path: Path) -> dict:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1048576:
        raise ValueError("installer-input-invalid")
    return obj(json.loads(path.read_text(encoding="utf-8")))


def digest(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise ValueError("installer-input-invalid")
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, value: dict) -> None:
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, sort_keys=True, separators=(",", ":"))
        stream.write("\n")


def name(value: object) -> str:
    import re
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,199}", value):
        raise ValueError("installer-name-invalid")
    return value


def exact(value: dict, keys: set[str]) -> None:
    if set(value) != keys:
        raise ValueError("installer-config-fields-invalid")


def config_for(request: dict) -> dict:
    config = read_json(Path(request["configPath"]))
    exact(config, {"schemaVersion", "useCase", "verificationProfile", "platforms"} | ({"sharedWrapper"} if "sharedWrapper" in config else set()))
    if config["schemaVersion"] != "installer.assembly.v1" or config["useCase"] not in {"github-release-native", "github-release-native-shared"}:
        raise ValueError("installer-use-case-unsupported")
    shared = config["useCase"] == "github-release-native-shared"
    if config["verificationProfile"] != ("shared-exact-payload-v1" if shared else "native-offline-dry-run-v1"):
        raise ValueError("installer-verification-profile-unsupported")
    platforms = obj(config["platforms"])
    if not platforms or not set(platforms) <= PLATFORMS:
        raise ValueError("installer-platform-unsupported")
    if shared != ("sharedWrapper" in config) or (shared and not SHARED_PLATFORMS <= set(platforms)):
        raise ValueError("installer-shared-platform-unsupported")
    for entry in platforms.values():
        exact(obj(entry), {"manifest", "assetName"})
        name(entry["assetName"])
    if shared:
        wrapper = obj(config["sharedWrapper"])
        exact(wrapper, {"assetName", "deliveryUrls"})
        name(wrapper["assetName"])
        if set(obj(wrapper["deliveryUrls"])) != SHARED_PLATFORMS:
            raise ValueError("installer-wrapper-urls-invalid")
    published_names = []
    for target, entry in platforms.items():
        published_names.extend([entry["assetName"], f"manifest-{target}.json"])
    if shared:
        published_names.append(config["sharedWrapper"]["assetName"])
    outputs = [suffix_name for asset in published_names for suffix_name in [asset, asset + ".sha256", asset + ".owner.json", asset + ".provenance.json", asset + ".verification.json"]]
    if len(set(outputs)) != len(outputs) or "supplemental-manifest.json" in outputs:
        raise ValueError("installer-asset-name-collision")
    return config


def platform_bindings(request: dict, config: dict) -> dict[str, dict]:
    bindings = {}
    for native in config["platforms"]:
        candidates = [entry for entry in request["releasePlatforms"] if NATIVE_TARGETS.get(entry["target"]) == native]
        if len(candidates) != 1:
            raise ValueError("installer-platform-binding-invalid")
        bindings[native] = candidates[0]
    return bindings


def generated(value: object, expected: str, marker: str) -> str:
    if value not in {marker, expected}:
        raise ValueError("installer-generated-value-conflict")
    return expected


def manifest_for(request: dict, entry: dict, build: dict, native: str) -> dict:
    manifest = read_json(Path(request["sourceRoot"]) / entry["manifest"])
    authority = request["authority"]
    publication = obj(authority["publication"])
    owner, repository = publication["repository"].split("/")
    asset = obj(build["assets"][0])
    version, tag = authority["version"], authority["tag"]
    manifest["releaseVersion"] = generated(manifest["releaseVersion"], version, "<release-version>")
    manifest["targetPlatformId"] = generated(manifest["targetPlatformId"], native, "<target-platform-id>")
    source = obj(manifest["source"])
    exact(source, {"kind", "owner", "repository", "fixedReference"})
    if source["kind"] != "github-release":
        raise ValueError("installer-source-unsupported")
    for key, value, marker in [("owner", owner, "<repository-owner>"), ("repository", repository, "<repository-name>"), ("fixedReference", tag, "<release-tag>")]:
        source[key] = generated(source[key], value, marker)
    artifact = obj(manifest["artifact"])
    exact(artifact, {"url", "fileName", "checksum"})
    for key, value, marker in [("url", f"https://github.com/{owner}/{repository}/releases/download/{tag}/{asset['path']}", "<fixed-release-asset-url>"), ("fileName", asset["path"], "<artifact-file-name>"), ("checksum", "sha256:" + asset["sha256"], "sha256:<artifact-sha256>")]:
        artifact[key] = generated(artifact[key], value, marker)
    provenance = obj(manifest["provenance"])
    exact(provenance, {"sourceTag", "sourceCommit", "ciRunId"})
    for key, value, marker in [("sourceTag", tag, "<release-tag>"), ("sourceCommit", authority["source_sha"], "<source-commit-sha>"), ("ciRunId", request["assemblyId"], "<ci-run-or-assembly-id>")]:
        provenance[key] = generated(provenance[key], value, marker)
    return manifest


def verify_native(candidate: Path, asset_name: str, manifest_name: str, artifact: Path) -> None:
    environment = None
    if sys.platform == "win32":
        # A Python child of PowerShell 7 inherits incompatible module paths for 5.1.
        environment = {key: value for key, value in os.environ.items() if key.upper() != "PSMODULEPATH"}
        command = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(candidate / asset_name), "-Mode", "dry-run", "-Source", "offline", "-Manifest", str(candidate / manifest_name), "-Artifact", str(artifact), "-Json"]
    else:
        command = ["bash", str(candidate / asset_name), "--mode", "dry-run", "--source", "offline", "--manifest", str(candidate / manifest_name), "--artifact", str(artifact), "--json"]
    result = subprocess.run(command, capture_output=True, text=True, check=True, env=environment)
    if obj(json.loads(result.stdout)).get("result") != "dry-run":
        raise ValueError("installer-verification-failed")


def platform_record(request: dict, config: dict, output: Path, scratch: Path) -> None:
    standard = Path(request["standardBuildRoot"])
    build = read_json(standard / "asset-manifest.json")
    exact(build, {"schema_version", "kind", "source_sha", "version", "platform_id", "platform_target", "assets"})
    authority = request["authority"]
    bindings = platform_bindings(request, config)
    target = NATIVE_TARGETS.get(build["platform_target"])
    binding = bindings.get(target)
    native_target = {("Linux", "x86_64"): "linux-x86_64", ("Darwin", "arm64"): "macos-arm64", ("Windows", "AMD64"): "windows-x86_64"}.get((platform.system(), platform.machine()))
    if build["schema_version"] != "1" or build["kind"] != "ci-release-build-manifest" or build["source_sha"] != authority["source_sha"] or build["version"] != authority["version"] or target != native_target or binding is None or build["platform_id"] != binding["id"] or build["platform_target"] != binding["target"]:
        raise ValueError("installer-build-identity-invalid")
    if not isinstance(build["assets"], list) or len(build["assets"]) != 1:
        raise ValueError("installer-build-assets-invalid")
    asset = obj(build["assets"][0])
    exact(asset, {"path", "sha256", "checksum_path"})
    archive = standard / name(asset["path"])
    checksum_path = name(asset["checksum_path"])
    if checksum_path != archive.name + ".sha256" or digest(archive) != asset["sha256"] or (standard / checksum_path).read_bytes() != _checksum_bytes(asset["sha256"], archive.name):
        raise ValueError("installer-artifact-checksum-invalid")
    if {p.name for p in standard.iterdir()} != {archive.name, checksum_path, "asset-manifest.json"}:
        raise ValueError("installer-build-assets-invalid")
    entry = config["platforms"][target]
    manifest = manifest_for(request, entry, build, target)
    manifest_path = scratch / "manifest.json"
    write_json(manifest_path, manifest)
    builder = load_builder("build-installer")
    candidate = output / "candidate"
    builder.assemble_candidate(source_dir=ROOT / "platform", manifest_path=manifest_path, output_dir=candidate, asset_name=entry["assetName"], source_revision=authority["source_sha"], assembly_id=request["assemblyId"])
    record = read_json(candidate / "installer-asset-candidate.json")
    verify_native(candidate, entry["assetName"], record["manifest_name"], archive)
    verification = {"status": "passed", "suite": "native-offline-dry-run-v1", **{key: record[key] for key in ["asset_checksum", "source_revision", "manifest_checksum", "installer_source_checksum"]}}
    verification_path = scratch / "verification.json"
    write_json(verification_path, verification)
    builder.finalize_evidence(output_dir=candidate, verification_evidence_path=verification_path)
    write_json(output / "platform-record.json", {"schema": "installer.platform.v1", "platformId": binding["id"], "platformTarget": binding["target"], "nativePlatformId": target, "sourceSha": authority["source_sha"], "version": authority["version"], "assemblyId": request["assemblyId"], "providerRevision": request["providerRevision"], "configChecksum": digest(Path(request["configPath"])), "assetName": entry["assetName"], "artifactName": archive.name, "artifactChecksum": asset["sha256"], "files": {p.name: digest(p) for p in candidate.iterdir()}})


def checked_platforms(request: dict, config: dict, scratch: Path) -> dict[str, Path]:
    root = Path(request["supplementalBuildRoot"])
    bindings = platform_bindings(request, config)
    if {p.name for p in root.iterdir()} != {"supplemental-build-" + binding["id"] for binding in bindings.values()}:
        raise ValueError("installer-platform-set-invalid")
    candidates = {}
    authority = request["authority"]
    for target, entry in config["platforms"].items():
        binding = bindings[target]
        directory = root / ("supplemental-build-" + binding["id"])
        record = read_json(directory / "platform-record.json")
        if any(record.get(key) != value for key, value in {"schema": "installer.platform.v1", "platformId": binding["id"], "platformTarget": binding["target"], "nativePlatformId": target, "sourceSha": authority["source_sha"], "version": authority["version"], "assemblyId": request["assemblyId"], "providerRevision": request["providerRevision"], "configChecksum": digest(Path(request["configPath"])), "assetName": entry["assetName"]}.items()):
            raise ValueError("installer-platform-evidence-invalid")
        candidate = directory / "candidate"
        if record["files"] != {p.name: digest(p) for p in candidate.iterdir()}:
            raise ValueError("installer-platform-evidence-invalid")
        evidence = read_json(candidate / "installer-asset-evidence.json")
        verification = read_json(candidate / "installer-verification-evidence.json")
        if verification.get("status") != "passed" or verification.get("suite") != "native-offline-dry-run-v1" or evidence.get("asset_checksum") != "sha256:" + digest(candidate / entry["assetName"]):
            raise ValueError("installer-platform-evidence-invalid")
        standard = Path(request["standardBuildRoot"]) / ("release-build-" + bindings[target]["id"])
        build = read_json(standard / "asset-manifest.json")
        exact(build, {"schema_version", "kind", "source_sha", "version", "platform_id", "platform_target", "assets"})
        if build["schema_version"] != "1" or build["kind"] != "ci-release-build-manifest" or build["source_sha"] != authority["source_sha"] or build["version"] != authority["version"] or build["platform_id"] != binding["id"] or build["platform_target"] != binding["target"] or len(build["assets"]) != 1:
            raise ValueError("installer-build-identity-invalid")
        asset = obj(build["assets"][0])
        exact(asset, {"path", "sha256", "checksum_path"})
        archive_name = name(asset["path"])
        if asset["checksum_path"] != archive_name + ".sha256" or (standard / (archive_name + ".sha256")).read_bytes() != _checksum_bytes(asset["sha256"], archive_name) or {p.name for p in standard.iterdir()} != {"asset-manifest.json", archive_name, archive_name + ".sha256"}:
            raise ValueError("installer-build-assets-invalid")
        if record["artifactName"] != asset["path"] or record["artifactChecksum"] != asset["sha256"] or digest(standard / name(asset["path"])) != asset["sha256"]:
            raise ValueError("installer-artifact-checksum-invalid")
        # Rebuild from this provider: matching supplied hashes does not prove ownership.
        expected_manifest = scratch / f"{target}.json"
        write_json(expected_manifest, manifest_for(request, entry, build, target))
        rebuilt = scratch / target
        builder = load_builder("build-installer")
        builder.assemble_candidate(source_dir=ROOT / "platform", manifest_path=expected_manifest, output_dir=rebuilt, asset_name=entry["assetName"], source_revision=authority["source_sha"], assembly_id=request["assemblyId"])
        builder.finalize_evidence(output_dir=rebuilt, verification_evidence_path=candidate / "installer-verification-evidence.json")
        if record["files"] != {p.name: digest(p) for p in rebuilt.iterdir()}:
            raise ValueError("installer-provider-candidate-mismatch")
        candidates[target] = candidate
    return candidates


def verify_wrapper(request: dict, config: dict, wrapper: Path, candidates: dict[str, Path], scratch: Path) -> None:
    # Delivery is a controlled test double; the wrapper and dispatched candidates are exact output bytes.
    harness = scratch / "delivery"
    harness.mkdir()
    curl = harness / "curl"
    curl.write_text("#!" + sys.executable + "\nimport json,os,shutil,sys\nm=json.loads(os.environ['INSTALLER_TEST_DELIVERY'])\na=sys.argv[1:]\nurl=a[-1]\nif url not in m: sys.exit(9)\nshutil.copyfile(m[url],a[a.index('--output')+1])\n")
    curl.chmod(0o700)
    uname = harness / "uname"
    uname.write_text('#!' + POSIX_SHELL + '\ncase "$1" in -s) printf "%s\\n" "$INSTALLER_TEST_OS" ;; -m) printf "%s\\n" "$INSTALLER_TEST_ARCH" ;; *) exit 9 ;; esac\n')
    uname.chmod(0o700)
    bindings = platform_bindings(request, config)
    delivery = {url: str(candidates[target] / config["platforms"][target]["assetName"]) for target, url in config["sharedWrapper"]["deliveryUrls"].items()}
    for target, candidate in candidates.items():
        standard = Path(request["standardBuildRoot"]) / ("release-build-" + bindings[target]["id"])
        build = read_json(standard / "asset-manifest.json")
        env = {**os.environ, "PATH": str(harness) + os.pathsep + os.environ["PATH"], "INSTALLER_TEST_DELIVERY": json.dumps(delivery), "INSTALLER_TEST_OS": "Linux" if target == "linux-x86_64" else "Darwin", "INSTALLER_TEST_ARCH": "x86_64" if target == "linux-x86_64" else "arm64", "INSTALLER_MODE": "dry-run", "INSTALLER_SOURCE": "offline", "INSTALLER_MANIFEST": str(candidate / f"manifest-{target}.json"), "INSTALLER_ARTIFACT": str(standard / name(build["assets"][0]["path"])), "INSTALLER_JSON": "1", "INSTALLER_SMOKE_HELP": "0"}
        result = subprocess.run(["sh", str(wrapper)], env=env, capture_output=True, text=True, check=True)
        if obj(json.loads(result.stdout)).get("result") != "dry-run":
            raise ValueError("installer-wrapper-verification-failed")


def publish_record(request: dict, output: Path, asset: Path, owner_evidence: dict) -> dict:
    asset_name = name(asset.name)
    shutil.copyfile(asset, output / asset_name)
    checksum = digest(output / asset_name)
    (output / (asset_name + ".sha256")).write_bytes(_checksum_bytes(checksum, asset_name))
    evidence_name = asset_name + ".owner.json"
    evidence = {"installerEvidence": owner_evidence, "providerRevision": request["providerRevision"], "configChecksum": digest(Path(request["configPath"]))}
    write_json(output / evidence_name, evidence)
    provenance_name = asset_name + ".provenance.json"
    write_json(output / provenance_name, {"source_sha": request["authority"]["source_sha"], "version": request["authority"]["version"], "provider_revision": request["providerRevision"], "config_sha256": digest(Path(request["configPath"]))})
    verification_name = asset_name + ".verification.json"
    evidence_digest, provenance_digest = digest(output / evidence_name), digest(output / provenance_name)
    write_json(output / verification_name, {"status": "success", "owner_contract": OWNER_CONTRACT, "source_sha": request["authority"]["source_sha"], "asset_sha256": checksum, "owner_evidence_sha256": evidence_digest, "provenance_sha256": provenance_digest})
    return {"path": asset_name, "sha256": checksum, "checksum_path": asset_name + ".sha256", "owner_evidence_path": evidence_name, "owner_evidence_sha256": evidence_digest, "provenance_path": provenance_name, "verification_path": verification_name}


def assemble(request: dict, config: dict, output: Path, scratch: Path) -> None:
    candidates = checked_platforms(request, config, scratch)
    verified_assets = []
    for target, candidate in candidates.items():
        evidence = read_json(candidate / "installer-asset-evidence.json")
        for asset_name in [config["platforms"][target]["assetName"], f"manifest-{target}.json"]:
            verified_assets.append((candidate / asset_name, evidence))
    if config["useCase"] == "github-release-native-shared":
        builder = load_builder("build-shared-wrapper")
        candidate = scratch / "wrapper"
        wrapper_name = config["sharedWrapper"]["assetName"]
        wrapper_candidates = {target: candidates[target] for target in config["sharedWrapper"]["deliveryUrls"]}
        paths = {target: path / config["platforms"][target]["assetName"] for target, path in wrapper_candidates.items()}
        builder.assemble_candidate(source_dir=ROOT / "wrapper", installer_paths=paths, installer_urls=config["sharedWrapper"]["deliveryUrls"], output_dir=candidate, asset_name=wrapper_name, source_revision=request["authority"]["source_sha"], assembly_id=request["assemblyId"])
        record = read_json(candidate / "installer-asset-candidate.json")
        verify_wrapper(request, config, candidate / wrapper_name, wrapper_candidates, scratch)
        verification_path = scratch / "wrapper-verification.json"
        write_json(verification_path, {"status": "passed", "suite": "shared-exact-payload-v1", "wrapper_checksum": record["asset_checksum"], "source_revision": record["source_revision"], "platform_installer_checksums": {target: "sha256:" + digest(file) for target, file in paths.items()}})
        builder.finalize_evidence(output_dir=candidate, verification_evidence_path=verification_path)
        verified_assets.append((candidate / wrapper_name, read_json(candidate / "installer-asset-evidence.json")))
    assets = [publish_record(request, output, asset, evidence) for asset, evidence in verified_assets]
    write_json(output / "supplemental-manifest.json", {"schema_version": "1", "kind": "ci-github-supplemental-handoff", "owner_contract": OWNER_CONTRACT, "source_sha": request["authority"]["source_sha"], "version": request["authority"]["version"], "assets": assets})


def run(request: dict) -> None:
    config = config_for(request)
    output = Path(request["outputDirectory"])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.mkdir()
    temporary_root = output / "tmp"
    temporary_root.mkdir()
    try:
        with tempfile.TemporaryDirectory(prefix="installer-verify-", dir=temporary_root) as directory:
            if request["operation"] == "build-platform":
                platform_record(request, config, output, Path(directory))
            elif request["operation"] == "assemble":
                assemble(request, config, output, Path(directory))
            else:
                raise ValueError("installer-operation-invalid")
    finally:
        temporary_root.rmdir()


def main() -> int:
    try:
        run(obj(json.load(sys.stdin)))
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        sys.stderr.write("installer-assembly-failed\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
