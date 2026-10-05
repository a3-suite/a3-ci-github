# 移行記録

## 目的

`a3-ci-github` の再構築で使用した移行元と、切替時点の受入結果を記録します。本書の version、SHA、alias は移行時点の記録です。現行の正本は [DEVELOPMENT.md の SSOT](../../DEVELOPMENT.md#ssot)、Action binding は [Action registry](../../skills/ci-github/references/ci-github-preset-assets.reference.yml) を参照してください。

## Baseline

| コピー元 | revision | 対象 |
| --- | --- | --- |
| `a3-suite/a3-actions` | `c4ec3fc9b53b235642e873936ce7d05aecc72cac` | Action、共通runtime、Action契約SDD、回帰資産 |
| `izumilufty/a3-prompts` | `cc4cc0e52c451f0cafe8104b0ff98333152b897e` | CIスキル文書、canonical workflow、preflight、lint rule |

## 切替時点の受入結果

- source cutover: canonical workflow と Action registry を `a3-suite/a3-ci-github` の固定SHAへ切り替えました。
- Release gate: 完了。annotated `v0.1.0` の peeled target `312c534de67720de060689d78ada17da9c84c4e2` をremoteで確認し、registryの`implementationSource.exactRef`とcanonical workflowのAction参照を同じSHAへ固定しました。
- 切替時点の Release: `v0.1.3`（annotated。公開 asset は manifest、単独実行可能な fetch CLI、`SHA256SUMS` の3点）。`v0` と `v0.1` alias を `v0.1.3` へ接続しました。
- 利用側の新しい固定SHAへの接続: clean consumer で `v0.1.3` の配布 manifest を起点とする fetch、verify、plan、apply、rollback を確認しました。
- 旧 owner 資産の削除: 完了。`izumilufty/a3-prompts` の旧 GitHub CI スキル資産を削除し、外部スキルルートを本リポジトリの `skills/ci-github` へ置換しました。
- `a3-suite/a3-actions` の公開資産: 既存 consumer 向けに維持し、削除または archive は別途承認事項として残しました。現行の保全条件は [README.md](../../README.md) を参照してください。
