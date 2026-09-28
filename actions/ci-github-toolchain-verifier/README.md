# ci-github-toolchain-verifier

GitHub CI で利用する `gh`、`jq`、`sha256sum` の存在と完全一致バージョンを検証するときに使います。

```yaml
- uses: a3-suite/a3-actions/actions/ci-github-toolchain-verifier@<40-char-commit-sha>
  with:
    mode: gh-jq-sha256
    gh-version: '2.80.0'
    jq-version: '1.7'
    sha256sum-version: '9.5'
```

`mode` は `jq`、`gh-jq`、`jq-sha256`、`gh-jq-sha256` のいずれかです。選択した command の
バージョン input が空、不正、または実行環境のバージョンと不一致の場合、Action は失敗します。

処理本体は同じ ref の `runtime/github-toolchain/verify-github-toolchain.sh` を使用し、成功時は `verified=true` を出力します。
