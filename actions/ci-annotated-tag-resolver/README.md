# ci-annotated-tag-resolver

Annotated tag を GitHub API で解決し、tag object と source commit の SHA を出力します。tag が lightweight tag の場合は失敗します。

```yaml
- uses: a3-suite/a3-actions/actions/ci-annotated-tag-resolver@<40-char-commit-sha>
  id: tag
  with:
    repository: ${{ github.repository }}
    tag: ${{ inputs.release-tag }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

`github-token` は read-only API 用に渡します。GitHub API の URL は runner の `GITHUB_API_URL` を使い、Action 入力では変更できません。Action は checkout、version 決定、公開操作を行いません。
