# ci-change-scope

`ci-change-scope` は base/head の差分を読み、documentation-only pattern に従って CI と documentation checks の実行要否を返します。差分が取得できない場合は両方を実行する値と `unresolved` status を返します。workflow の trigger、job 境界、required check は所有しません。

## 入出力

`base-sha`、`head-sha`、`event-name`、`pr-base-sha`、`before-sha` を入力し、`docs-only-patterns` はカンマ区切りで指定します。outputs は `status`、`run-ci`、`run-docs`、`files`、`docs-files`、`other-files` です。`git diff --name-only` を実行するため、workflow で checkout と read-only git access を用意してください。

```yaml
- uses: a3-suite/a3-actions/actions/ci-change-scope@<40-char-commit-sha>
  id: scope
  with:
    base-sha: ${{ github.event.pull_request.base.sha }}
    head-sha: ${{ github.sha }}
```
