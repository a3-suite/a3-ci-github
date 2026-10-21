# 公開スキルデプロイコンテキスト

## 固定する入力

| 入力 | 値 |
| --- | --- |
| project root | `{project-root}`（実行前に絶対パスへ解決する） |
| 公開スキルの選択 | `{project-root}/.agents/skill-deploy.yml` の `sources`（`skills` 配下で SKILL.md を持つ公開root。ci-github / ci-release-installer） |
| 配備先 | `{project-root}/.env` の `SKILLS_<KEY>_DIR`（Git管理外。雛形は `.env.example`） |
| destination skill root | `{配備先}/{skill-name}` |

設定ファイルと `.env` の書式は `project-skill-deploy` を正本とする。配備先を作業ディレクトリ、環境変数、過去の配置から推測しない。

## 配備境界

- 配備ファイル集合は公開rootの現在の通常ファイルから導出し、別の一覧を正本として保持しない。
- `_build` などの予約領域、symlink、非通常ファイル、source と destination の重複判定は `project-skill-deploy` の契約へ委譲する。
- `workflows/`、`actions/`、`runtime/`、`lint-rules/` は repository-owned であり、Agent Skill の配備対象に含めない。
- 配備先の既存公開スキル は直接編集せず、公開rootから再反映する。

## 委譲境界

- 差分検査、候補分類、反映、再検査の順序と判定は `project-skill-deploy` を正本とし、このスキルでは再定義しない。
- 手動の差分確認と反映は `uv run {project-skill-deploy}/scripts/deploy_project_skills.py --project-root {project-root}` に `--dry-run` などを付けて実行する。外部書き込みまたは削除の明示許可がない場合は、dry-run の結果報告で停止する。
- リポジトリ固有の判断は、Agent Skill以外の資産を配備対象へ追加しないことと、旧実装資産の削除を移行完了の証拠にしないことに限定する。

## コミットゲート連携

- `commit-gate` スキルの `skill-deploy-parity` は、HEAD と staged snapshot を `project-skill-deploy` のスナップショット差分 API へ渡す。ゲートの適用・停止・終了条件は commit-gate スキルのコミットゲートガイドを正本とする。
- 利用者が `.env` に配備先を設定したことを、その配備先への削除を伴わない更新反映に対する継続的な明示許可とする。削除とpruneは、この許可に含めず、対象ごとの明示許可を要する。
- `project-skill-deploy` スキルのrootは、ゲートの実行時に引数で明示する。

## 完了条件

### 差分確認

- 更新、stale、管理外、prune 候補が分類・報告され、外部書き込みが行われていない。

### 反映

- 許可された管理対象について、`{配備先}/{skill-name}` のファイル集合と内容が公開rootに一致する。
- 未許可の stale と管理外候補は一致条件から除外し、未処理理由とともに報告されている。
- 外部書き込みと削除の実施有無、対象、件数を分けて報告できる。
- repository-owned の実装資産が Agent Skill 配備先へ複製されていない。
