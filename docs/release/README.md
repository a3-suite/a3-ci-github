# Release

各 Action は bundle 済みの `dist/` を同一コミットに含めて配布します。

## Release ref

- リリース ref の命名・起点・承認条件は、git-branch-strategy と git の正本で判定します。
- 本リポジトリの初回リリース候補は version tag `v0.1.0` と major alias `v0` です。alias は検証済みリリースと同一コミットに付与します。
- 実際のタグ作成・push は、対象コミットと検証結果を確認した別の release 操作で行います。
