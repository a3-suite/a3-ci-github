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

## 共通 git への返却
- 本書のゲート一覧を期待する `gate_id` 集合とし、各ゲートについて適用判定を行う。非適用を含む各判定結果を1件ずつ返す。
- 各ゲートは共通 `git` の `local_gate_result` 契約に従う結果を返す。
- 返却項目の意味と集約規則は共通 `git` スキルに委譲し、本書では a3-ci-github 固有の値だけを設定する。
- `commit author`、コミットメッセージ、push の有無、最終承認表示は git スキルが所有する。

## ゲート実行順序
1. provider固定参照ゲートを実行し、続いて固定参照更新順序ゲートの適用条件を確認し、該当する場合は手動確認する。
2. 成功、停止、判定不能、非適用を含む各ゲート結果を git スキルのコミットフローへ返し、後続へ進むかは git スキルの集約規則に委譲する。

## provider固定参照ゲート

### 実行

検証依存を復元したrepository rootから実行する。入力はindexの同一snapshotであり、未ステージのworkflowを検査結果へ混ぜない。

確定済み実装SHAへの接続・公開準備コミットでは、事前tagを要求しない候補検査を実行する。

```sh
node {project-root}/runtime/repository/check-provider-references.mjs --staged --candidate --contracts
```

実装準備コミットでは、既存の固定参照に対する検査を実行する。対象版の実装資材とdistの検証は別途実行し、既存固定参照の成功を新しい実装の成功と取り違えない。

`--preparation`は既存の実装SHAの到達可能性・版・実行資材・固定参照先の契約を検証し、最終tagを要求しない。成功時も`preparationOnly: true`、`implementationBindingStatus: unverified`を返す。新しいstaged実装の資材同一性と接続は、実装コミット確定後の接続候補検査で確認する。

```sh
node {project-root}/runtime/repository/check-provider-references.mjs --staged --contracts --preparation
```

実行するゲート本体と依存がstaged snapshotと一致することを確認する。一致しない場合はsnapshotをmaterializeした検証環境で実行する。検査対象と規則の正本は当該executor、実行順序は `{project-root}/docs/maintenance/action-construction.md` の「固定参照の更新順序」を参照する。

### 終了条件

- 適用条件に該当しなければ`非適用`。
- 終了コード0は`PASS`、診断ありの1は`STOP`、実行不能・解析失敗・snapshot変化の2は`判定不能`。
- pending-releaseはprovider内部の外部Action placeholderを許可する理由にならない。consumer canonicalの置換用placeholderは本ゲートの対象外。
- `preparationOnly: true` は実装準備を示し、新実装の接続・利用可能化を証明しない。既存固定参照の検査成功と、全Action targetとavailabilityGateがpendingで接続診断を残す状態を区別し、`interfaceDiagnostics` と `connection.diagnostics` を確認結果へ残す。接続診断の免除は後者の準備コミットだけに限り、Actionのavailable targetがある場合は適用しない。calleeのsource宣言はこの免除の根拠にしない。接続更新には上記の候補検査を使い、`--preparation`を付けない。

## 固定参照更新順序ゲート

### 確認（手動）
- 更新順序の正本は `{project-root}/docs/maintenance/action-construction.md` の「固定参照の更新順序」。手順を本ゲートへ複製しない。
- staged snapshotの変更を実装準備、確定済み実装SHAへの接続、再利用workflowの公開準備、callerの生成・接続に分類し、正本の順序に照合する。実装の事前Releaseや接続専用の次版を要求しない。
- 候補の接続は正本のpublication契約に従って到達可能性・実行資材の同一性と固定SHA先の契約を確認する。consumerの利用可能状態は当該Releaseの公開後に確認する。作業ツリーの実装や別SHAの成功を接続先の証拠に読み替えない。
- 準備段階で残したpending状態・placeholderと、後続の公開・受入・切替が必要な箇所を確認結果へ明示する。未公開という理由だけで準備コミットを停止しない。

### 終了条件
- 適用条件を満たさない場合は`非適用`。
- 正本の順序と接続先の証拠が整合し候補検査が成功する、または既存固定参照の検査と実装検証が成功した実装準備コミットとして整合する場合は`PASS`。最終tag作成後の公開検査はRelease workflowで再実行する。
- 将来SHAの自己参照、未確定・不適合なActionへの接続、registryとcanonical sourceのAction参照不一致、manifestとcalleeの固定参照不一致は`STOP`。templateのcallee placeholderは導入時生成の入力として維持する。
- 必要な正本・参照先・証拠を確認できなければ`判定不能`。未確認の段階を成功として補完しない。

### 再実行条件
- staged snapshot、参照先SHA、または根拠にした公開・Hosted受入状態が変わった場合は結果を失効させ、影響範囲を再確認する。

## 直前実行証拠の共通採用条件
- 共通採用条件は git スキルのコミットフローに委譲し、本書では再定義しない。
- 本書では、各ゲートに固有の追加条件だけを定義する。
