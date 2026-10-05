// Generated from fixed owner Git objects by generate-standard-quality-bundles.mjs.
export const STANDARD_QUALITY_BUNDLES = [
  {
    "id": "rust-cargo-quality",
    "owner": "rust",
    "sourceRepository": "https://github.com/izumilufty/a3-prompts",
    "sourceRevision": "1b1d1e5b159bfab0c502dcbc04b2a184f4460834",
    "sourcePath": "skills/rust/rust/assets/ci/adapter-bundles/rust-quality.yml",
    "sha256": "a396fb2bb095e87ac8b9770eac2358033ce1b7ac09c67ec9f7147f44419aa35a",
    "descriptor": "schemaVersion: \"1\"\nkind: ci-adapter-bundle\nid: rust-cargo-quality\ncontract: quality-scripts\nlanguageProfiles: [rust]\nprovider: provider-neutral\nexecutionBoundary: read-only\nsourceCheckout: fixed-source\ncopyable: true\nowner: rust\nassets: []\nprojectSettings:\n  requiredFiles: []\n  requiredScripts: []\n  requiredEnvironmentPaths: [CI_CARGO_MANIFEST_PATH, CI_CARGO_LOCK_PATH]\ntoolchain:\n  versionEnv: CI_TOOLCHAIN_VERSION\n  verify:\n    command: rustc\n    args: [--version]\npreparation:\n  - id: dependency-restore\n    command: cargo\n    args: [fetch, --locked, --manifest-path, \"${CI_CARGO_MANIFEST_PATH}\"]\ncommands:\n  - id: format\n    command: cargo\n    args: [fmt, --manifest-path, \"${CI_CARGO_MANIFEST_PATH}\", --all, --, --check]\n  - id: lint\n    command: cargo\n    args: [clippy, --manifest-path, \"${CI_CARGO_MANIFEST_PATH}\", --workspace, --all-targets, --all-features, --, -D, warnings]\n  - id: test\n    command: cargo\n    args: [test, --manifest-path, \"${CI_CARGO_MANIFEST_PATH}\", --workspace, --all-features]\n  - id: security\n    command: cargo\n    args: [audit, --file, \"${CI_CARGO_LOCK_PATH}\"]\n  - id: structure\n    command: cargo\n    args: [metadata, --manifest-path, \"${CI_CARGO_MANIFEST_PATH}\", --no-deps, --format-version, \"1\"]\n"
  },
  {
    "id": "python-uv-quality",
    "owner": "python",
    "sourceRepository": "https://github.com/izumilufty/a3-prompts",
    "sourceRevision": "1b1d1e5b159bfab0c502dcbc04b2a184f4460834",
    "sourcePath": "skills/python/python/assets/ci/adapter-bundles/python-quality.yml",
    "sha256": "ac4c9f128f0bb27c321e56ac530216a5918658a619abe11fbd4963adc83b224d",
    "descriptor": "schemaVersion: \"1\"\nkind: ci-adapter-bundle\nid: python-uv-quality\ncontract: quality-scripts\nlanguageProfiles: [python]\nprovider: provider-neutral\nexecutionBoundary: read-only\nsourceCheckout: fixed-source\ncopyable: true\nowner: python\nassets: []\nprojectSettings:\n  requiredFiles: [pyproject.toml, uv.lock]\n  requiredScripts: []\ntoolchain:\n  versionEnv: CI_TOOLCHAIN_VERSION\n  verify:\n    command: python\n    args: [--version]\npreparation:\n  - id: dependency-restore\n    command: uv\n    args: [sync, --locked, --python, \"${CI_TOOLCHAIN_VERSION}\"]\ncommands:\n  - id: format\n    command: uv\n    args: [run, ruff, format, --check, .]\n  - id: lint\n    command: uv\n    args: [run, ruff, check, .]\n  - id: test\n    command: uv\n    args: [run, pytest]\n  - id: security\n    command: uv\n    args: [run, pip-audit]\n  - id: structure\n    command: python\n    args: [-m, compileall, -q, .]\n"
  },
  {
    "id": "typescript-npm-quality",
    "owner": "typescript",
    "sourceRepository": "https://github.com/izumilufty/a3-prompts",
    "sourceRevision": "1b1d1e5b159bfab0c502dcbc04b2a184f4460834",
    "sourcePath": "skills/javascript/typescript/assets/ci/adapter-bundles/typescript-quality.yml",
    "sha256": "a1ecdced4f8863b804bd42f793c9dc51d54ba82bb2bcd2549034e8bd93047b26",
    "descriptor": "schemaVersion: \"1\"\nkind: ci-adapter-bundle\nid: typescript-npm-quality\ncontract: quality-scripts\nlanguageProfiles: [typescript]\nprovider: provider-neutral\nexecutionBoundary: read-only\nsourceCheckout: fixed-source\ncopyable: true\nowner: typescript\nassets: []\nprojectSettings:\n  requiredFiles: [package.json, package-lock.json]\n  requiredScripts: [\"format:check\", lint, typecheck, test]\ntoolchain:\n  versionEnv: CI_TOOLCHAIN_VERSION\n  verify:\n    command: node\n    args: [--version]\npreparation:\n  - id: dependency-restore\n    command: npm\n    args: [ci, --ignore-scripts, --no-audit, --no-fund]\ncommands:\n  - id: format\n    command: npm\n    args: [run, format:check]\n  - id: lint\n    command: npm\n    args: [run, lint]\n  - id: typecheck\n    command: npm\n    args: [run, typecheck]\n  - id: test\n    command: npm\n    args: [test]\n  - id: security\n    command: npm\n    args: [audit, --audit-level=high]\n  - id: structure\n    command: npm\n    args: [pack, --dry-run]\n"
  }
] as const;
