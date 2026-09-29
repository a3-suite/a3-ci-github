# リポジトリコミットゲート実行ガイド

## 目的
- staged snapshot に適用する a3-ci-github 固有ゲートと、コミットへ進める終了条件を一意にする。

## 適用境界
- git スキルのコミットフローで確定した staged snapshot だけを判定対象にする。
- リポジトリ固有ゲートは本書に登録されたものだけを適用する。
- git スキルの SDD 適用監査ゲートが `PASS` または `非適用` になった後に実行する。

## ゲート一覧

| `gate_id` | 定義節 | 適用条件 | 実行入口 | status 写像 |
| --- | --- | --- | --- | --- |
| `skill-deploy-parity` | スキル配備整合ゲート | staged snapshot に `skills/ci-github/` 配下の配備対象変更が含まれる | スキル配備整合ゲートの「実行」 | スキル配備整合ゲートの「終了条件」 |

## 共通 git への返却
- 本書のゲート一覧を期待する `gate_id` 集合とし、各ゲートについて適用判定を行う。非適用を含む各判定結果を1件ずつ返す。
- 各ゲートは共通 `git` の `local_gate_result` 契約に従う結果を返す。
- 返却項目の意味と集約規則は共通 `git` スキルに委譲し、本書では a3-ci-github 固有の値だけを設定する。
- `commit author`、コミットメッセージ、push の有無、最終承認表示は git スキルが所有する。

## ゲート実行順序
1. スキル配備整合ゲートの適用条件を確認する。
2. 適用条件を満たす場合はスキル配備整合ゲートを実行する。
3. 成功、停止、判定不能、非適用を含む各ゲート結果を git スキルのコミットフローへ返し、後続へ進むかは git スキルの集約規則に委譲する。

## 直前実行証拠の共通採用条件
- 共通採用条件は git スキルのコミットフローに委譲し、本書では再定義しない。
- 本書では、スキル配備整合証拠に固有の追加条件だけを定義する。

## スキル配備整合ゲート

### 適用条件
- staged snapshot に `skills/ci-github/` 配下の配備対象変更が含まれる場合に適用する。
- 配備対象外は `_build/`、`__pycache__/`、`.git/`、`*.pyc`、`*.pyo` とする。
- 対象 skill root は staged snapshot から解決し、作業ディレクトリや過去の配置から推測しない。

### 証拠の採用条件
- 現行 staged snapshot と、直前実行時に解決した対象 skill root が一致する。
- 対象 root の未ステージ差分と未追跡ファイルの状態が変わっていない。
- 配備先 root、配備 CLI、`project-skill-deploy` の公開契約が変わっていない。
- 直前結果が成功で、実行後に配備先を変更する操作がない。

### 実行
プロジェクトルートで実行する。

```sh
python3 .agents/skills/commit-gate/scripts/check_staged_skill_deploy.py
```

- 配備先 root は `A3_CI_GITHUB_SKILL_DEPLOY_ROOT` で明示する。未設定の場合は実行せず `非適用` とする。
- 差分確認、候補分類、反映、再検査の順序と判定は `skills-deploy` スキルが委譲する `project-skill-deploy` を正本とし、本ゲートでは再定義しない。
- 削除を伴わない更新差分は prune なしで自動反映し、同じ scope を再検査して一致を確認する。
- 削除候補、明示 prune 対象、category replacement root、管理外 skill の削除は自動反映せず `STOP` とする。
- 反映する変更は staged snapshot と一致する作業ツリーの内容に限る。対象 root に未ステージ差分がある場合は実行しない。

### 停止条件
- staged snapshot から対象 skill root を解決できない、または `skills/ci-github/SKILL.md` が index に存在しない。
- 対象 root に未ステージ差分または未追跡ファイルがある。
- 配備先に削除候補、明示 prune 対象、または category replacement root がある。
- 自動反映後も配備先に差分が残る。
- 配備 CLI または配備先 root を解決できない。

### 終了条件
- 適用条件を満たさない場合は `非適用` とする。
- 配備先 root が未設定の場合は `非適用` とし、理由を返す。
- `0`: 更新を反映し、配備先が canonical source と一致する、または一致済み。`PASS`。
- `1`: 検証失敗。`STOP`。
- `2`: 実行エラー。`判定不能`。

### 再実行条件
- staged snapshot、対象 root の未ステージ状態、配備先 root、配備 CLI、`project-skill-deploy` の公開契約のいずれかが変わった場合は、配備整合証拠を失効させて再実行する。
