# 公開スキルデプロイコンテキスト

## 固定する入力

| 入力 | 値 |
| --- | --- |
| source root | `{project-root}/skills` |
| selectable skill | source rootでSKILL.mdを持つ公開root（ci-github / ci-release-installer） |
| canonical source | `{project-root}/skills/{skill-name}` |
| destination root | 利用者が明示した外部スキルルート |
| destination skill root | `{destination-root}/{skill-name}` |

`{project-root}` と `{destination-root}` は実行前に絶対パスへ解決する。配備先を環境や過去の配置から推測しない。

## 配備境界

- 配備ファイル集合は canonical source の現在の通常ファイルから導出し、別の一覧を正本として保持しない。
- `_build` などの予約領域、symlink、非通常ファイル、source と destination の重複判定は `project-skill-deploy` の契約へ委譲する。
- `workflows/`、`actions/`、`runtime/`、`lint-rules/` は repository-owned であり、Agent Skill の配備対象に含めない。
- 配備先の既存公開スキル は直接編集せず、canonical source から再反映する。

## 委譲境界

- 差分検査、候補分類、反映、再検査の順序と判定は `project-skill-deploy` を正本とし、このスキルでは再定義しない。
- 委譲時は上記の固定入力を渡し、外部書き込みまたは削除の明示許可がない場合は検査結果の報告で停止する。
- リポジトリ固有の判断は、Agent Skill以外の資産を配備対象へ追加しないことと、旧実装資産の削除を移行完了の証拠にしないことに限定する。

## コミットゲート連携

- `commit-gate` スキルの `skill-deploy-parity` は、このコンテキストの固定入力を `project-skill-deploy` へ渡す。ゲートの適用・停止・終了条件は commit-gate スキルのコミットゲートガイドを正本とする。
- 配備先rootは、利用者が指定した絶対pathを `git config --local a3-ci-github.skillDeployRoot "{destination-root}"` で保存する。個人環境のpathを追跡ファイルへ記録しない。
- 利用者がこの配備先rootを設定したことを、そのrootへの削除を伴わない更新反映に対する継続的な明示許可とする。削除とpruneは、この許可に含めず、対象ごとの明示許可を要する。
- 委譲するCLIは `project-skill-deploy` の公開CLIとする。配備先rootが `project-skill-deploy` を含む利用者のスキルルートであることを前提に `{destination-root}/project-skill-deploy/scripts/deploy_project_skills.py` を使い、別の場所にある場合は `A3_PROJECT_SKILL_DEPLOY_CLI` で指定する。

## 完了条件

### 差分確認

- 更新、stale、管理外、prune 候補が分類・報告され、外部書き込みが行われていない。

### 反映

- 許可された管理対象について、`{destination-root}/{skill-name}` のファイル集合と内容が canonical source に一致する。
- 未許可の stale と管理外候補は一致条件から除外し、未処理理由とともに報告されている。
- 外部書き込みと削除の実施有無、対象、件数を分けて報告できる。
- repository-owned の実装資産が Agent Skill 配備先へ複製されていない。
