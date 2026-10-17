# ci-package-publication-request

`ci-package-publication-request` は package publication request handoff を生成または検証し、`verify-trigger` で起動元 `workflow_run` の repository、event、branch を検証します。artifact 転送、job 権限、publish は所有しません。

## 入出力

- `operation`（必須）: `verify-trigger`、`create`、`verify` のいずれか。`verify-trigger` は `workflow_run` event の payload を読み、起動元が default branch 上で成功した `package-publication-request` の `workflow_dispatch` であることを、artifact の取得前に検証します。
- `request-path`: request JSON のパス。既定値は `package-publication-request/request.json`。
- `create`: `source-sha`、`version`、`target-identity`、`language-profile`、`toolchain` が必須。
- `verify`: workflow が独立に確認した `expected-source-sha` が必須。
- outputs: 全 operation が `status` を出力します。`create` と `verify` は加えて `request-path` と検証済みの各 request field を出力します。
