# ci-config-snapshot

`ci-config-snapshot` は runtime、workflow、preset の設定を runtime 優先で解決し、`ci.config-snapshot.v1` の JSON と SHA-256 digest を出力します。workflow の job 境界、権限、runner、project adapter は所有しません。

## 入出力

- `sources-json`（必須）: `runtime`、`workflow`、`preset` の文字列 map を持つ JSON。
- `snapshot-path`（必須）: snapshot JSON の出力先。
- `output-path`（任意）: `config_snapshot_path` と `config_snapshot_digest` を追記する出力ファイル。空値は `GITHUB_OUTPUT`。
- outputs: `status`、`snapshot-path`、`digest`。

不正な key、空値、改行・NUL を含む値、JSON、path は失敗として扱います。実行時に `skills/` は要求しません。

```yaml
- uses: a3-suite/a3-actions/actions/ci-config-snapshot@<40-char-commit-sha>
  with:
    sources-json: '{"preset":{"MODE":"release"},"runtime":{"MODE":"dry-run"}}'
    snapshot-path: .ci/config-snapshot.json
```
