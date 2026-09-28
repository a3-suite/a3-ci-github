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
- Release gate: 未完了。`implementationSource.releaseTag` の `v0.1.0` は未公開であるため、`exact-release-tag` と `release-tag-mapping` は未充足です。registry は `availabilityGate.status: release-pending` とし、初回Releaseで peeled target と `exactRef` の一致を確認した後に `available` へ更新します。
- 旧repositoryからの削除またはarchive: 未実施。別途承認まで行いません。
- 利用側の新しい固定SHAへの接続: `release-pending` により未実施。初回Releaseとavailability gateの確認までconsumer接続を行いません。

## 終了条件

cutover後は本書のauthority記述を運用正本として残さず、履歴で追跡できる移行記録へ縮約またはarchiveします。
