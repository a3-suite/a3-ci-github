# ci-release-request-handoff

annotated tag から解決済みの source identity を、version 解決を authority に委譲する
`ci.release-request.v1` handoff へ書き出します。Action は承認や公開可否を判断しません。

```yaml
- uses: a3-suite/a3-actions/actions/ci-release-request-handoff@<40-char-commit-sha>
  with:
    output-directory: release-request
    tag-source-sha: ${{ steps.tag.outputs.source-sha }}
    tag-object-sha: ${{ steps.tag.outputs.tag-object-sha }}
    github-ref: ${{ github.ref }}
    github-ref-name: ${{ github.ref_name }}
    request-run-id: ${{ github.run_id }}
    request-actor: ${{ github.actor }}
```
