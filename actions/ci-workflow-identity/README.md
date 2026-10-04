# ci-workflow-identity

`ci-workflow-identity` は、reusable workflow を呼び出した snapshot が default branch 上の同一 commit であることを検証し、検証済みの workflow commit SHA を出力します。権限、job 境界、公開処理、用途固有の公開判断は所有しません。

既存consumerとの互換性のため公開契約を維持しています。標準publication経路では使用しません。現行の信頼境界は [runner trust policy](../../skills/ci-github/references/runner-trust-policy.reference.md) を参照してください。

## 入力

| input | 必須 | 内容 |
| --- | --- | --- |
| `repository` | yes | 期待する repository の `owner/name` |
| `default-branch` | yes | 期待する default branch 名 |
| `expected-caller-workflow-path` | yes | 期待する caller workflow の path |
| `expected-called-workflow-path` | yes | 期待する reusable workflow の path |
| `caller-workflow-ref` | yes | caller workflow の `github.workflow_ref` |
| `caller-workflow-sha` | yes | caller workflow の `github.workflow_sha` |
| `called-workflow-repository` | yes | 被呼出 workflow の `job.workflow_repository` |
| `called-workflow-file-path` | yes | 被呼出 workflow の `job.workflow_file_path` |
| `called-workflow-ref` | yes | 被呼出 workflow の `job.workflow_ref` |
| `called-workflow-sha` | yes | 被呼出 workflow の `job.workflow_sha` |

## 出力

| output | 内容 |
| --- | --- |
| `sha` | 検証済み workflow snapshot の commit SHA |

検証は、caller ref が `{repository}/{caller-path}@refs/heads/{default-branch}` と一致すること、被呼出 repository と path が期待値と一致すること、被呼出 ref が同じ形式で一致すること、両 SHA が 40 桁小文字 hex で一致することを確認します。不一致は Action を失敗終了させ、公開処理へ進みません。`GITHUB_OUTPUT` が未設定または改行を含む場合は失敗します。

## 使用例

```yaml
- name: Verify workflow identity
  id: workflow-identity
  uses: a3-suite/a3-ci-github/actions/ci-workflow-identity@<40-char-commit-sha>
  with:
    repository: ${{ github.repository }}
    default-branch: ${{ github.event.repository.default_branch }}
    expected-caller-workflow-path: .github/workflows/release-publication-caller.yml
    expected-called-workflow-path: .github/workflows/release-publication.yml
    caller-workflow-ref: ${{ github.workflow_ref }}
    caller-workflow-sha: ${{ github.workflow_sha }}
    called-workflow-repository: ${{ job.workflow_repository }}
    called-workflow-file-path: ${{ job.workflow_file_path }}
    called-workflow-ref: ${{ job.workflow_ref }}
    called-workflow-sha: ${{ job.workflow_sha }}
```

Action の実行時に `skills/` や `ci-github` スキルのファイルを要求しません。公開 API は同梱の `action.yml` を正本とします。

## 検証

```sh
npm test
npm run lint
npm run build
```
