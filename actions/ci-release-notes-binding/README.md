# ci-release-notes-binding

`ci-release-notes-binding` は `ci.release-notes.v1` の本文 digest と `ci.release-notes-approval.v1` の承認 digest・release identity を read-only で結合します。GitHub release の作成、本文生成、権限、tag の解決は所有しません。

入力は handoff JSON、approval JSON、期待する `release-identity`。出力は `status`、identity、本文 `digest`、`approval-id` です。schema、source contract、identity、本文 digest、approval digest が一致しない場合は失敗します。

approval JSON と `release-identity` は caller が trusted control / 承認済み handoff から取得して渡してください。この Action は指定された2つの JSON の整合だけを検証し、承認者や発行元の信頼性を独自には保証しません。untrusted な入力だけで承認を成立させないでください。

```yaml
- uses: a3-suite/a3-actions/actions/ci-release-notes-binding@<40-char-commit-sha>
  with:
    handoff-json: .ci/release-notes.json
    approval-json: .ci/release-notes-approval.json
    release-identity: v1.2.3
```
