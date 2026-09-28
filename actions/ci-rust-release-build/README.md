# ci-rust-release-build

固定 source の Rust CLI を、authority と platform manifest に拘束された toolchain／target で buildし、
Release archive、checksum、`asset-manifest.json` を新しい出力ディレクトリへ生成して検証します。

```yaml
- uses: a3-suite/a3-actions/actions/ci-rust-release-build@<40-char-commit-sha>
  with:
    language-profile: rust
    platform-manifest: .ci/platform-manifest.yml
    toolchain-version: '1.90.0'
    platform-id: linux-x64
    platform-target: x86_64-unknown-linux-gnu
    authority-path: authority/authority.json
    output-directory: build/linux-x64
    cargo-manifest-path: Cargo.toml
    release-binary-name: example-cli
    release-asset-prefix: example-cli
```

入力と authority、checkout、manifest digest、manifest 内の platform ID／target、Cargo package version が
一致しない場合、toolchain が完全固定版ではない場合、または出力先が既に存在する場合は失敗します。加えて、
生成 binary の `--version` 出力に authority の version が独立トークン（`{version}`、`v{version}`、
`V{version}` のいずれかと完全一致）として報告されていることを確認します。失敗時は
`binary-version-mismatch` と `expected=`／`received=` を stderr に出します。処理本体は同じ ref の
`runtime/rust-release/ci-release-build.sh` とOS別の補助スクリプトです。全処理の成功後に
`completed=true` を出力します。
