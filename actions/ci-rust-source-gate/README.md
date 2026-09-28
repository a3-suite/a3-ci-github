# ci-rust-source-gate

Rust CLI の Release authority に記録された language profile と source SHA を、現在の checkout に照合します。

```yaml
- uses: a3-suite/a3-actions/actions/ci-rust-source-gate@<40-char-commit-sha>
  with:
    language-profile: rust
    authority-path: authority/authority.json
```

authority が存在しない、profile が `rust` ではない、source SHA が40桁小文字SHAではない、または
checkout の `HEAD` と一致しない場合は失敗します。処理本体は同じ ref の
`runtime/rust-release/ci-source-gate.sh` です。成功時は `verified=true` を出力します。
