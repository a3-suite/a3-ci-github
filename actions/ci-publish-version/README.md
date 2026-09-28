# ci-publish-version

`ci-publish-version` は、caller が渡した owner-approved version plan を検証して `publish-version` へ具体化する read-only Action です。version strategy、template、component、公開可否、source / artifact identity は選択しません。

source / artifact binding は trusted control または handoff 契約で先に確定し、承認済み plan を入力してください。Action は GitHub API、credential、publish command、workflow job 境界を扱いません。

```yaml
- uses: a3-suite/a3-actions/actions/ci-publish-version@<40-char-commit-sha>
  with:
    version-plan-json: .ci/version-plan.json
```

出力は `status` と `publish-version` です。strategy、field、template、component が不正または不足している場合は `status=failed` としてステップを失敗させます。
