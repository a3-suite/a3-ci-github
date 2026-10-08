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
| `provider-references` | provider固定参照ゲート | staged snapshotに`.github/workflows/`、`actions/`、provider pin registry、または本ゲート実装の変更が含まれる | provider固定参照ゲートの「実行」 | provider固定参照ゲートの「終了条件」 |
| `fixed-reference-order` | 固定参照更新順序ゲート | staged snapshotにAction、Actionへ組み込む共有runtime、canonical workflow、provider callee、またはpreset registryの実装・接続・公開参照変更が含まれる | 固定参照更新順序ゲートの「確認（手動）」 | 固定参照更新順序ゲートの「終了条件」 |
| `skill-deploy-parity` | スキル配備整合ゲート | staged snapshot に `skills/` の公開root配下の配備対象変更が含まれる | スキル配備整合ゲートの「実行」 | スキル配備整合ゲートの「終了条件」 |

## 共通 git への返却
- 本書のゲート一覧を期待する `gate_id` 集合とし、各ゲートについて適用判定を行う。非適用を含む各判定結果を1件ずつ返す。
- 各ゲートは共通 `git` の `local_gate_result` 契約に従う結果を返す。
- 返却項目の意味と集約規則は共通 `git` スキルに委譲し、本書では a3-ci-github 固有の値だけを設定する。
- `commit author`、コミットメッセージ、push の有無、最終承認表示は git スキルが所有する。

## ゲート実行順序
1. provider固定参照ゲートを実行し、続いて固定参照更新順序ゲートの適用条件を確認し、該当する場合は手動確認する。
2. スキル配備整合ゲートの適用条件を確認し、該当する場合は実行する。
3. 成功、停止、判定不能、非適用を含む各ゲート結果を git スキルのコミットフローへ返し、後続へ進むかは git スキルの集約規則に委譲する。

## provider固定参照ゲート

### 実行

検証依存を復元したrepository rootから実行する。入力はindexの同一snapshotであり、未ステージのworkflowを検査結果へ混ぜない。

```sh
node runtime/repository/check-provider-references.mjs --staged --contracts --preparation
```

実行するゲート本体と依存がstaged snapshotと一致することを確認する。一致しない場合はsnapshotをmaterializeした検証環境で実行する。検査対象と規則の正本は当該executor、実行順序は[Action構築方針](../../../../docs/maintenance/action-construction.md#固定参照の更新順序)を参照する。

### 終了条件

- 適用条件に該当しなければ`非適用`。
- 終了コード0は`PASS`、診断ありの1は`STOP`、実行不能・解析失敗・snapshot変化の2は`判定不能`。
- pending-releaseはprovider内部の外部Action placeholderを許可する理由にならない。consumer canonicalの置換用placeholderは本ゲートの対象外。
- `preparationOnly: true` は全Action targetとavailabilityGateがpendingの準備コミットだけの許容であり、接続契約は未達。`interfaceDiagnostics` と `connection.diagnostics` を確認結果へ残す。Actionのavailable targetがある場合、この許容は適用しない。calleeのsource宣言はこの免除の根拠にしない。接続更新の判定は `--preparation` を外して実行する。

## 固定参照更新順序ゲート

### 確認（手動）
- 更新順序の正本は[Action構築方針](../../../../docs/maintenance/action-construction.md#固定参照の更新順序)。手順を本ゲートへ複製しない。
- staged snapshotの変更を実装準備、公開済みActionへの接続、再利用workflowの公開準備、callerの生成・接続に分類し、正本の順序に照合する。
- 利用可能として接続する参照は、registryとcanonical sourceの一致、固定SHAの実体と必要な契約、要求される公開・受入証拠を確認する。作業ツリーの実装や別SHAの成功を接続先の証拠に読み替えない。
- 準備段階で残したpending状態・placeholderと、後続の公開・受入・切替が必要な箇所を確認結果へ明示する。未公開という理由だけで準備コミットを停止しない。

### 終了条件
- 適用条件を満たさない場合は`非適用`。
- 正本の順序と接続先の証拠が整合する、またはpending状態を維持した準備コミットとして整合する場合は`PASS`。
- 将来SHAの自己参照、未確定・不適合なActionへの接続、registryとcanonical sourceのAction参照不一致、manifestとcalleeの固定参照不一致は`STOP`。templateのcallee placeholderは導入時生成の入力として維持する。
- 必要な正本・参照先・証拠を確認できなければ`判定不能`。未確認の段階を成功として補完しない。

### 再実行条件
- staged snapshot、参照先SHA、または根拠にした公開・Hosted受入状態が変わった場合は結果を失効させ、影響範囲を再確認する。

## 直前実行証拠の共通採用条件
- 共通採用条件は git スキルのコミットフローに委譲し、本書では再定義しない。
- 本書では、各ゲートに固有の追加条件だけを定義する。

## スキル配備整合ゲート

### 適用条件
- staged snapshot に `skills/` の公開root配下の配備対象変更が含まれる場合に適用する。
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
- staged snapshot から対象 skill root を解決できない、または 変更対象の公開rootの `SKILL.md` が index に存在しない。
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
