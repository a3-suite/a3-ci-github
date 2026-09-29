# ci-github スキルデプロイコンテキスト

## 固定する入力

| 入力 | 値 |
| --- | --- |
| source root | `{project-root}/skills` |
| selectable skill | `ci-github` |
| canonical source | `{project-root}/skills/ci-github` |
| destination root | 利用者が明示した外部スキルルート |
| destination skill root | `{destination-root}/ci-github` |

`{project-root}` と `{destination-root}` は実行前に絶対パスへ解決する。配備先を環境や過去の配置から推測しない。

## 配備境界

- 配備ファイル集合は canonical source の現在の通常ファイルから導出し、別の一覧を正本として保持しない。
- `_build` などの予約領域、symlink、非通常ファイル、source と destination の重複判定は `project-skill-deploy` の契約へ委譲する。
- `workflows/`、`actions/`、`runtime/`、`lint-rules/` は repository-owned であり、Agent Skill の配備対象に含めない。
- 配備先の既存 `ci-github` は直接編集せず、canonical source から再反映する。

## 委譲境界

- 差分検査、候補分類、反映、再検査の順序と判定は `project-skill-deploy` を正本とし、このスキルでは再定義しない。
- 委譲時は上記の固定入力を渡し、外部書き込みまたは削除の明示許可がない場合は検査結果の報告で停止する。
- リポジトリ固有の判断は、Agent Skill以外の資産を配備対象へ追加しないことと、旧実装資産の削除を移行完了の証拠にしないことに限定する。

## 旧スキル置換

- 旧スキルと新スキルを異なる destination root へ恒久的に二重配置しない。
- 旧スキルだけに存在する `assets/` と `scripts/` は stale 候補として扱う。
- stale の削除は、新しい公開文書の配置成功と削除対象の明示確認後に限る。
- runtime 配布、consumer 接続、旧パス利用者の移行完了を、Agent Skill の配置成功だけで保証したことにしない。

## 完了条件

### 差分確認

- 更新、stale、管理外、prune 候補が分類・報告され、外部書き込みが行われていない。

### 反映

- 許可された管理対象について、`{destination-root}/ci-github` のファイル集合と内容が canonical source に一致する。
- 未許可の stale と管理外候補は一致条件から除外し、未処理理由とともに報告されている。
- 外部書き込みと削除の実施有無、対象、件数を分けて報告できる。
- repository-owned の実装資産が Agent Skill 配備先へ複製されていない。
