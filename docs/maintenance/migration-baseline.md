# 移行baseline

## 目的

`a3-ci-github` の再構築中に、コピー元とコピー先のauthorityを混同せず、二重更新と早すぎる公開切替を防ぎます。

## Baseline

| コピー元 | revision | 対象 |
| --- | --- | --- |
| `a3-suite/a3-actions` | `c4ec3fc9b53b235642e873936ce7d05aecc72cac` | Action、共通runtime、Action契約SDD、回帰資産 |
| `izumilufty/a3-prompts` | `cc4cc0e52c451f0cafe8104b0ff98333152b897e` | CIスキル文書、canonical workflow、preflight、lint rule |

## Authority

- canonical workflow と Action registry の Action binding は、source cutover により `a3-suite/a3-ci-github` の固定SHAをauthorityとします。
- 本リポジトリのskill文書、canonical workflow、Action、runtimeは、このリポジトリを正本として管理します。
- `a3-suite/a3-actions` と `izumilufty/a3-prompts` の公開資産は既存consumer向けに維持し、削除またはarchiveは別途承認まで行いません。
- 同じ契約を本リポジトリとコピー元で独立に更新しません。コピー元の変更が必要な場合は、本リポジトリへ取り込む形で反映します。

## Cutover状態

- source cutover: 完了。canonical workflow と Action registry は `a3-suite/a3-ci-github` の固定SHAを参照します。
- Release gate: 完了。annotated `v0.1.0` の peeled target `312c534de67720de060689d78ada17da9c84c4e2` をremoteで確認し、registryの`implementationSource.exactRef`とcanonical workflowのAction参照を同じSHAへ固定しました。
- 最新 Release: `v0.1.3`（annotated。公開 asset は manifest、単独実行可能な fetch CLI、`SHA256SUMS` の3点）。`v0` と `v0.1` alias は `v0.1.3` を指します。
- 利用側の新しい固定SHAへの接続: clean consumer で `v0.1.3` の配布 manifest を起点とする fetch、verify、plan、apply、rollback を確認しました。
- 旧 owner 資産の削除: 完了。`izumilufty/a3-prompts` の旧 GitHub CI スキル資産を削除し、外部スキルルートを本リポジトリの `skills/ci-github` へ置換しました。
- `a3-suite/a3-actions` の公開資産: 既存 consumer 向けに維持中です。削除または archive は別途承認まで行いません。

## 終了条件

cutover後は本書のauthority記述を運用正本として残さず、履歴で追跡できる移行記録へ縮約またはarchiveします。
