# ci-package-publication-request

`ci-package-publication-request` は package publication request handoff を生成または検証します。workflow の repository、event、branch の信頼判定、artifact 転送、job 権限、publish は所有しません。

## 入出力

- `operation`（必須）: `create` または `verify`。
- `request-path`: request JSON のパス。既定値は `package-publication-request/request.json`。
- `create`: `source-sha`、`version`、`target-identity`、`language-profile`、`toolchain` が必須。
- `verify`: workflow が独立に確認した `expected-source-sha` が必須。
- outputs: `status`、`request-path`、検証済みの各 request field。
