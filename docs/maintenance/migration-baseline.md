# 移行baseline

## 目的

`a3-ci-github` の再構築中に、コピー元とコピー先のauthorityを混同せず、二重更新と早すぎる公開切替を防ぎます。

## Baseline

| コピー元 | revision | 対象 |
| --- | --- | --- |
| `a3-suite/a3-actions` | `c4ec3fc9b53b235642e873936ce7d05aecc72cac` | Action、共通runtime、Action契約SDD、回帰資産 |
| `izumilufty/a3-prompts` | `cc4cc0e52c451f0cafe8104b0ff98333152b897e` | CIスキル文書、canonical workflow、preflight、lint rule |

## Authority

- cutover完了までは、公開済みActionとその固定SHAについて `a3-actions` をauthorityとします。
- cutover完了までは、既存CIスキルとcanonical workflowについて `a3-prompts` をauthorityとします。
- このリポジトリへ取り込んだ資産は、契約再構築と受入検証の対象です。
- 同じ変更をコピー元とコピー先で独立に実装しません。移行中に必要な修正はauthority側で確定し、baseline更新として取り込みます。

## Cutover条件

- SDD上の要求、契約、設計、実装写像がcurrentとして検証される。
- Action、workflow、runtime、skillの責務境界が重複なく定義される。
- Action配布物、canonical workflow、materialize、preflightの回帰が成功する。
- 新しいrepository、Action path、固定SHA、Release tagの公開契約が確定する。
- 利用側で新しい固定SHAを使った代表フローが成功する。
- コピー元からの削除またはarchive方針が別途承認される。

## 終了条件

cutover後は本書のauthority記述を運用正本として残さず、履歴で追跡できる移行記録へ縮約またはarchiveします。
