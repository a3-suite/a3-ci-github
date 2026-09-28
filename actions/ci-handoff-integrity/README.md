# ci-handoff-integrity

`ci-handoff-integrity` は handoff descriptor、manifest、成果物の digest と source/version/target identity を read-only で検証します。descriptor と manifest の path は handoff root 配下の相対ファイルだけを受け付け、symlink escape を拒否します。

入力は `handoff-root`、`descriptor`、`source-sha`、`version`、`target-identity`。出力は `status`、正規化した `descriptor` / `manifest`、`manifest-digest`、`entries` です。失敗は Action failure として返します。

```yaml
- uses: a3-suite/a3-actions/actions/ci-handoff-integrity@<40-char-commit-sha>
  with:
    handoff-root: .ci/handoff
    descriptor: handoff.json
    source-sha: ${{ github.sha }}
    version: 1.0.0
    target-identity: linux-x64
```
