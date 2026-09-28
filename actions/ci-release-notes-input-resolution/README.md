# ci-release-notes-input-resolution

外部の approved release notes handoff を検証し、publication workflow が使うディレクトリへコピーします。
`ci-release-notes-binding` の本文・承認 digest 検証は行いません。

```yaml
- uses: a3-suite/a3-actions/actions/ci-release-notes-input-resolution@<40-char-commit-sha>
  with:
    input-handoff-directory: release-notes-handoff
    output-directory: release-request
```
