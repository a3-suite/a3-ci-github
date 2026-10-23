# CI 監査の詳細確認ガイド

## 目的

`references/verify-applied-ci-preset.guide.md`の基本監査を超えて、経路の机上実行、失敗診断、実行証跡、installer監査を行う場合の手順を示す。適用するのは、検出結果対応ガイドから差分がある経路として渡された場合、subject catalogの適用条件に該当する場合、または詳細の確認・証跡監査を依頼された場合に限る。status、判断規則、報告項目は`references/ci-audit-contract.reference.yml`と`references/ci-audit-subjects.reference.yml`を正本とし、本ガイドでは再定義しない。

## ユースケースシミュレーション

`references/ci-workflow-use-cases.reference.yml`から選択presetの通常ユースケースと適用される例外を抽出し、`references/ci-preset-contracts.reference.yml`で入力・出力・停止条件を解決する。対象は呼び出し元が渡した経路とし、詳細の確認を依頼された場合だけplanが`reuse`の標準経路を含める。

- event・filterが入口条件を表し、jobの`if`・`needs`、`permissions`、environment、secret注入、checkout対象がその経路のtrustと副作用に一致する。
- Actionとreusable workflowの入出力、artifactの生成・受渡し・取得、summaryと最終statusがpreset契約の出力と停止条件へ接続される。
- write経路では、前段の失敗、不一致、artifact欠落、権限不足、remote状態不明からpublishへ到達しない。
- 標準Release flowでは、tag requestがhandoffで停止し、認証済みdispatcherの手動publication requestだけがdefault branchのcallerを経てpublishへ到達する。publication requestのrun identity、event、actor、default branch、workflow pathと、承認ID・digest・期限のpublish直前の再検証を、workflow、owner契約、契約テストへ照合する。tag requestの成功をpublication callerへ直接接続する`workflow_run`連鎖は不一致とする。実公開runやactorの実観測は公開後確認へ分ける。
- rerunでは`run_attempt`だけを根拠に状態を再利用せず、request、source、handoff、remote identityを再確認する。
- `vars.`の参照を実行経路ごとに必須・条件付き・不要へ分類し、workflow input、固定値、Secret、project assetで供給できる値の参照は設定不一致とする。branch protection、ruleset、required checkなどのGitHub設定の読み取りは必須にせず、`references/workflow-authoring-policy.reference.md`の事前確認に従う。

対象workflowの入口、分岐、write job、owner handoffに対応するシナリオまたは対象外の根拠があることを逆向きにも確認する。契約が順序、状態遷移、停止条件を定義するstageは`ci-workflow-sequence`の`stageChecks`を適用し、未接続は`test-gap`、契約不足は`contract-gap`とする。式を静的に確定できない場合は推測せず、証拠不足として`statusClassification`へ渡す。机上シミュレーションはhosted runner、secret、権限、外部サービスの実動作を証明しない。

## 失敗診断

`ci-failure-diagnostics`の`authorityResolution`で固定providerと対象ownerの正本を解決する。caller/callee、Action、public CLI、project adapterから到達する失敗と保持経路を`stageChecks`へ対応付け、構成監査では診断・保持経路と検査の接続を、証跡監査では実際の最終ログ・既存証跡を照合する。共通境界は`evidenceOwnership`に従って提供元の契約テスト結果を再利用し、consumerへ共通テストをコピーさせない。provider操作のHTTP診断は`references/release-asset-publication-contract.reference.yml`の`failureAttribution`も照合する。

## installer監査

`installer-distribution`が適用対象の場合、公開経路と証拠を`delegation.ciInputs`へ加えてci-release-installerスキルへ一度だけ委譲する。ownerが返す固定providerの対応根拠、OS別の期待入口・現入口とREADMEコマンド、移行可否・維持理由を差分表へ受け取り、`publicationPathCheck`を実経路へ写像する。比較の完了条件を満たさない返却結果はownerへ差し戻し、installerの判定をCI側で代替しない。修正の優先順位は`remediationPriority`に従う。

## 証跡監査

証跡監査を選択した場合だけ実施する。未選択なら未実施と未依頼理由を記録し、構成のstatusへ混ぜない。

動的な検査を実行する前に、project ownerが定めた実行方法から、管理対象資産・外部の永続状態への書き込みと一時状態の出力先を確認する。

| 動的証拠の副作用 | read-only 監査での扱い |
| --- | --- |
| 管理対象資産と外部の永続状態へ書き込まない | 実行する |
| 一時状態の全出力先を検査ツール所有の状態へ分離できる | 出力先を固定して実行する |
| 管理対象資産または外部の永続状態へ書き込む、または副作用・出力先を確認できない | 実行せず、必須監査操作を開始できない観測として記録する |

実行後に管理対象資産の状態不変を確認し、変更を観測した場合は証拠を保持して監査を停止する。

- **契約証拠**（`contract-evidence`）: language adapterと`.ci` entrypointの代表正常系、主要失敗、境界条件の実行結果を取得または再利用する。適用対象の`project-owned-ci-adapter`、`ci-workflow-sequence`、`ci-failure-diagnostics`の`stageChecks.execution-evidence`を照合し、欠落・期限切れ・失敗はpreflightや構成監査の成功で代替しない。
- **補助証拠**（`supplemental-evidence`）: 局所分岐、再発防止、fixture／runtime互換性の検査が必要な場合だけ既存の結果を照合する。coverage率だけを理由に補助テストを追加せず、補助テストを契約保証の代替にしない。
- **実行証拠**（`runtime-evidence`）: `appliesWhen`に該当する場合だけ、対象identityに結合できる既存の非公開実行証拠を優先して取得する。`quality-gate`はmerge gate checkの名前またはtriggerの意味を変える変更、`release-request`はtag preparation・request identity・handoff、`release-publication`は手動request・default branch caller・authority・source identity・候補artifact・checksum・不一致時停止、`package-publication`はversion planと非上書き条件を対象とする。実Release／Packageの作成、実公開run、公開済みassetの取得は監査の必須証拠にせず、公開後確認として別記する。新しいhosted実行は監査から独立した操作として、対象ownerの運用契約と明示的な実行承認に従う。

結果を再利用する場合は`evidenceApplicability`を適用し、構成監査の結果を実行証跡の結果へ流用しない。

## 配置と責務

- `.ci/` には workflow runtime、adapter、設定だけを置く。preflight runtimeや導入元スキルのpathを実行時資産に含めない。
- 契約テストと補助テストは project の既存 `tests/` 規約へ置き、必要な場合だけ `tests/ci/` を使用する。
- language skill は format、lint、test、build の具体的な検証を、project owner は adapter、project 固有設定、契約テスト、補助テストを所有する。
- SDD を利用する project は、`quality-gate`（required checkやmerge判定に使う場合）、`release-request`、`release-publication`、`package-publication` の外部観測可能な境界を project の契約対象として宣言し、`.ci` 内部の分岐や helper はその実装または補助証拠として扱う。
