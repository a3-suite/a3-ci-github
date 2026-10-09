# 公開スキルデプロイコンテキスト

## 固定する入力

| 入力 | 値 |
| --- | --- |
| source root | `{project-root}/skills` |
| selectable skill | source rootでSKILL.mdを持つ公開root（ci-github / installer） |
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

- `commit-gate` スキルの `skill-deploy-parity` は、このコンテキストの固定入力を `project-skill-deploy` へ渡して差分を確認する。
- 配備先rootは、利用者が指定した絶対pathを `git config --local a3-ci-github.skillDeployRoot "{destination-root}"` で保存する。個人環境のpathを追跡ファイルへ記録しない。未設定の場合はゲートを `STOP` とし、非適用として通さない。
- コミット対象の変更があるときは公開root全体を検査する。公開スキルの差分だけを条件とせず、過去の未配備差分も削除を伴わない範囲で反映する。staged snapshotと一致しない公開ソースは配備しない。
- 使用する CLI は `{destination-root}/project-skill-deploy/scripts/deploy_project_skills.py` とし、`A3_PROJECT_SKILL_DEPLOY_CLI` で上書きできる。
- コミットゲートは削除を伴わない更新差分だけを自動反映し、削除、prune、管理外 skill の削除では停止する。この自動反映を、外部書き込みの明示許可として扱う。

## 旧スキル置換

- 旧スキルと新スキルを異なる destination root へ恒久的に二重配置しない。
- 旧スキルだけに存在する `assets/` と `scripts/` は stale 候補として扱う。
- stale の削除は、新しい公開文書の配置成功と削除対象の明示確認後に限る。
- runtime 配布、consumer 接続、旧パス利用者の移行完了を、Agent Skill の配置成功だけで保証したことにしない。

## 完了条件

### 差分確認

- 更新、stale、管理外、prune 候補が分類・報告され、外部書き込みが行われていない。

### 反映

- 許可された管理対象について、`{destination-root}/{skill-name}` のファイル集合と内容が canonical source に一致する。
- 未許可の stale と管理外候補は一致条件から除外し、未処理理由とともに報告されている。
- 外部書き込みと削除の実施有無、対象、件数を分けて報告できる。
- repository-owned の実装資産が Agent Skill 配備先へ複製されていない。

## installer所有元の切替

正式な固定runtime提供と新スキルの配備を確認してからa3-promptsの旧installer rootを撤去する。同名SKILL.mdの案内stubは残さない。切替中は旧側のinstaller配備を止め、通常配備による上書きとpruneを避ける。外部配備と旧資材削除は、それぞれ具体的対象への承認を得て実施する。
