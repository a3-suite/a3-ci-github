# 適用先 CI 資産の検証ガイド

## 目的

適用先 project に配置した CI 資産について、何をテスト対象にするか、どの証拠で監査完了と適合を判定するかを決める。

## 正本と対象境界

- CI の用途、入出力、停止条件は本スキルの workflow／preset／script 契約を正本とする。
- 監査モード、検証フェーズ、監査 status、証拠適用性、監査完了と適合 success の境界は `ci-audit-contract.reference.yml` を正本とする。本ガイドでは再定義しない。
- 意味監査 subject の発見、適用、owner 委譲、CI 側の接続確認、報告項目は `ci-audit-subjects.reference.yml` を正本とする。本ガイドでは個別subjectの判断規則を補完しない。
- SDD を利用する project は、project の contract registry で外部観測可能な CI 境界を契約対象として宣言する。
- 配布元スキルのリソースは適用先の実行時依存にしない。適用先では、選択した provider が所有する workflow／設定 root と `.ci/` の全資産を棚卸しし、保証対象は provider workflow、workflow から到達する `.ci/`、project-local adapter、および正本が必須とする管理資産から導出する。provider 固有の物理 path は provider 固有の検証ガイドへ委譲する。
- SDD の利用有無にかかわらず、CI runtime に SDD CLI や DSL を組み込まない。

## テスト対象の判定

1. 選択した provider が所有する workflow／設定 root と `.ci/` の全資産を棚卸しし、配置済み workflow、正本が必須とする管理資産、workflow から到達する資産を抽出する。
2. 入出力、停止条件、権限、identity、artifact、公開状態のいずれかへ影響する資産を保証対象にする。
3. `ci-audit-subjects.reference.yml` の `repository-root-readme` を意味監査の必須 subject として登録し、同 subject の `ownerSkill` が要求する前提と `delegation.ciInputs` を準備する。委譲は provider 固有証拠を揃えた後、ユースケースシミュレーションで実行する。
4. 同subject catalogの `repository-ci-documentation.discovery` を順に適用して候補と個別扱いを確定する。適用対象は同 subject の意味監査へ渡し、対象がない場合は `inapplicable` を適用する。
5. 同subject catalogの `installer-distribution.adoptionAssessment` を先に適用し、定義済みの handling を保持する。続いて `installer-distribution.appliesWhen`、`discovery`、`inapplicable` と、監査契約の `statusClassification` から適用判定を導出する。適用対象なら `delegation.ciInputs` を準備し、provider 固有証拠を揃えた後、ユースケースシミュレーションで一度だけ委譲する。修正が必要な場合は同 subject の `remediationPriority` を適用し、読み取り専用監査と修正許可のある監査を `modeHandling` で分ける。
6. 外部から観測できる仕様や安全不変条件は契約証拠へ接続する。
7. 契約証拠を確保した後、局所保証、再発防止、テスト資産互換性に固有の観測が必要かを判定する。補助証拠の追加可否は監査モードに従う。
8. 到達不能な補助ファイル、導入元スキルの内部実装、provider の再利用単位本体は適用先の実装テスト対象にしない。ただし適用先での固定 ref、入出力、権限、配置結果との接続は確認する。
9. 棚卸しした各ファイルを、CI に必要な資産、別 owner が管理する非 CI 資産、削除または置換が必要な重複・未到達・旧資産のいずれかへ分類し、根拠を記録する。別 owner の資産は owner と用途を確認して CI 監査の保証対象から除外し、到達不能という理由だけで不要と判定しない。未分類のファイルが残る間は意味監査を完了扱いにしない。

## ユースケースシミュレーション

導入済み workflow の網羅性は、配置ファイルの一覧ではなく、選択したユースケースから実行経路をたどって監査する。

1. `ci-workflow-use-cases.reference.yml` から、選択した preset と execution mode に対応する通常ユースケースを抽出する。
2. 同じ正本から、`appliesTo` が選択した preset、`selected-preset`、`all`、または対象 workflow が実際に到達する境界に該当する例外を抽出する。project owner が追加した停止条件がある場合は、その正本から追加する。
3. `ci-preset-contracts.reference.yml` から、各シナリオに適用する入力、出力、停止条件、完了条件を解決する。
4. 各シナリオについて、入口から終了まで次の対応を一件として記録する。
   - 正本のユースケースまたは例外
   - 前提と入力
   - trigger から job、step、再利用単位、adapter までの到達経路
   - 出力、status、外部副作用
   - 停止、owner handoff、再実行の条件
   - 確認に使った静的証拠と、後続フェーズで取得または再利用する契約テスト、provider 実行証拠、remote 証拠の対象 identity
5. 通常経路は入力が一度だけ固定され、期待する出力と evidence へ到達することを机上実行する。例外経路は正本の `decision` と preset の停止・完了条件から期待結果を解決する。停止が必要な場合は後続のwriteや成功集約へ進まず、成功完了が許可される場合は副作用を繰り返さずに完了条件を満たすことを机上実行する。
6. 再実行経路は、identity、入力、権限、remote 状態の再確認を通り、以前の成功や部分状態を根拠なく再利用しないことを確認する。
7. 契約が順序、状態遷移、または停止条件を定義する stage を workflow が実行する場合、`ci-audit-subjects.reference.yml` の `ci-workflow-sequence` を適用し、同 subject の `evidenceRequirements` に従って各契約シーケンスを実行可能な検査（契約テスト、validator、静的検査）の identity と直近結果へ対応付ける。机上の推論やレビュー記録は実行結果の代替にせず、検査が未接続の場合は `test-gap`、契約が沈黙または不足する場合は `contract-gap` として分類する。
8. 次の双方向照合で抜け漏れを判定する。
   - 抽出した全シナリオに、到達可能な実装経路と観測可能な終了状態がある。
   - `ci-workflow-sequence` が適用対象の場合、契約シーケンスが実行可能な検査へ接続され、未接続または契約不足が `test-gap` / `contract-gap` として報告されている。
   - 配置済み workflow の各入口、分岐、write経路、owner handoff に、対応するシナリオまたは対象外の根拠がある。
   - preset の必須入力、出力、停止条件が少なくとも一つのシナリオで確認され、未接続の項目がない。
   - `repository-root-readme` は `delegation.resultHandling` に従って委譲結果を集約する。
   - `repository-ci-documentation` が適用対象の場合、同 subject の `reviewRequirements` を全対象文書へ適用する。
   - `project-owned-ci-adapter` が適用対象の場合、workflow 接続、適用する script 契約の identity／version、後続の `contract-evidence` で取得または再利用する project 契約テスト証拠の対象 identity を特定する。証拠の取得・照合・subject status の確定はここでは行わない。
   - `installer-distribution` が適用対象の場合、provider 固有証拠を含む入力を揃えて一度だけ委譲し、返却結果を保持して、installer owner が選択した公開経路と CI の実装経路を照合する。

机上シミュレーションは hosted runner、secret、権限、外部サービスの実動作を証明しない。必須観測の開始・継続可否と、完了した観測の証拠十分性は、静的経路の成立とは分けて `auditContract.statusClassification` の condition へ照合する。

preflight が `success` でも、機械監査または意味監査を省略して適合扱いにしない。provider の再利用単位とローカル実装の重複、registry 外 workflow、到達不能 asset、provider が所有する root／`.ci/` の未分類資産、workflow の処理単位と契約の不一致は、`semanticCandidates` を起点に owner・処理契約・入出力・停止条件・副作用を照合し、候補ごとの判断と証拠を残す。候補と意味監査のstatusは `ci-audit-contract.reference.yml` の `reporting.semanticCandidateStatus` と `reporting.statuses.semantic-audit` から導出する。

`repository-root-readme` は、同 subject の `requirement` と `delegation` を適用し、provider 固有証拠を含む入力を揃えて一度だけ委譲する。委譲結果を `statusClassification` へ渡し、CI 監査側で委譲先の監査を代替または再判定しない。

`repository-ci-documentation` は、候補抽出だけで完了させず、`decisionOwner` が `reviewRequirements` を適用し、`reportingFields` を揃えてから subject status を集約する。

`installer-distribution` の委譲後は、同 subject の `publicationPathCheck` と `remediationPriority` を適用し、本ガイドで判定条件、優先順、監査モード別の処理、完了条件、具体的な修正内容を補完しない。

他スキルの結果を使う場合は `repository-ci-documentation.evidenceRoles` の提供範囲、除外範囲、適用条件、制約、委譲条件をそのまま適用する。個別扱いは `discovery.handledSeparately` から解決し、本ガイドで owner や責務を再定義しない。

finding は review スキルへ渡し、正本との不一致は `contract-gap`、実装経路の欠落または迂回は `implementation-gap`、必要な検証経路の未接続は `test-gap`、正本や必要な実行証拠を確定できない場合は `undecidable-needs-confirmation` として区別する。

| 対象 | 基本の証拠 |
| --- | --- |
| provider workflow 定義 | preflight、実行条件・安全条件に関わる設定の契約確認、構文、asset mapping、trigger、permissions、外部再利用単位の固定参照の静的確認。実行意味が対象なら provider 実行環境の証拠も取得 |
| `.ci/scripts/`、`.ci/provider/`、`.ci/trusted/` | 入力、出力、終了状態、主要失敗経路の契約確認。補助テストの必要性と追加可否は監査モードに従う |
| `.ci/adapters/` | language / project 契約の契約確認。局所分岐や互換性は補助テスト |
| 撤去漏れの検出対象である旧 `.ci/runtime/` | 通常の配置資産として受容せず、参照元とownerを確認して移行未完了として報告する |
| provider が提供する再利用単位 | 提供元の契約。適用先では固定参照、入出力、権限、配置結果との接続だけを確認 |

## 契約証拠と補助証拠

- 契約証拠は、project の契約正本（contract registry が存在する場合）または `ci` の preset／script 契約が定める外部観測可能な振る舞いを直接検証する。
- 補助証拠は契約保証を代替せず、`contract-test-supplement`、`local-regression-prevention`、`test-asset-compatibility` のいずれかの固有目的を持つ。
- coverage 率だけを理由に補助テストを追加しない。
- 補助テストは選択した test level と依存境界を説明できる場合だけ採用する。
- 契約対象外の内部実装を契約テストとして扱わない。

契約証拠または補助証拠を動的に取得する前に、project owner が定めた実行方法から、実行コマンド、管理対象資産への書き込み、外部の永続状態への書き込み、cache／temp／coverageなどの一時状態を確認し、根拠と解決した出力先を記録する。

`project-owned-ci-adapter` が適用対象の場合、ユースケースシミュレーションで特定した対象について project 契約テスト証拠を取得または再利用し、監査対象 revision への結合と同 subject の `evidenceRequirements` を照合してから subject status を確定する。preflight 成功で代替しない。

| 動的証拠の副作用 | read-only 監査での扱い |
| --- | --- |
| 管理対象資産と外部の永続状態へ書き込まない | 実行する |
| 一時状態の全出力先を検査ツール所有の状態へ分離できる | 出力先を固定して実行する |
| 管理対象資産または外部の永続状態へ書き込む | 実行せず、必須監査操作を開始できない観測として分類入力へ記録する |
| 副作用または出力先を確認できない | 実行せず、必須監査操作を開始できない観測として分類入力へ記録する |

ここで外部状態は repository 外の永続状態を指し、実行中に作成して終了時に破棄する検査ツール専用の一時状態を含めない。

実行後に管理対象資産の状態不変を確認する。事後確認は実行前の副作用判定を代替せず、変更を観測した場合はその証拠を保持して監査を停止する。スキル専用ローカル状態は管理対象資産から除外し、remediation でもcache、temp、coverageなどを検査ツール所有の状態へ分離する。管理対象資産または外部の永続状態への変更は明示された許可範囲だけに限定する。

## SDD 利用 project の契約対象

次の境界を project の契約対象として推奨する。

- `quality-gate`: required check や merge 判定に使う場合
- `release-request`: request、承認、handoff
- `release-publication`: authority、source identity、artifact、checksum、公開状態
- `package-publication`: version plan、package handoff、registry 状態、非上書き条件

`.ci` 内部の分岐や helper は、上記契約を実現する実装または補助証拠として扱う。契約の意味は project の SDD registry に置き、本スキルで別の DSL を作らない。

## 反復監査のローカルキャッシュ

短期間に監査を繰り返す場合は、`ci-audit-contract.reference.yml` の `evidenceApplicability.localCache` を適用してよい。キャッシュは監査の正本、適合根拠、実施済み判定の代替として扱わない。

監査ごとに同契約の `reuseEvaluation` と `localCache.read` を適用し、再利用できない証拠は現在の監査で取得する。継続不能な snapshot の扱いは `localCache.disposal.incompatibleContinuation`、監査後の更新と保存失敗は `localCache.write` に従い、本ガイドで判断規則を補完しない。

利用前に同契約の `versionControl` を確認する。更新時の一時領域は同契約の `atomicReplace` と temp-management スキルに従い、キャッシュ本体を一時物の後処理として削除しない。

## 検証順序

最初に `ci-audit-contract.reference.yml` の `preAudit` を適用し、監査モード、監査対象 identity、provider preflight の結果と証拠を記録する。後続監査の開始可否は同契約の `preAudit.continuation` だけから導出する。対象状態と外部状態の変更可否、および検査ツール所有の一時状態は同契約の `modes` に従う。

その後、同契約の `auditContract.phases` を記載順に適用する。`conditional` のフェーズは、対象外の根拠を記録できる場合だけ省略する。各フェーズの結果には、監査対象 identity、status、証拠の provenance、証拠種別に必要な identity binding、証拠取得の実施区分 `executed` または `reused` を残す。`reused` は適用性を今回確認した証拠の再利用であり、`未実施` へ読み替えない。

各フェーズの観測と意味監査 subject の結果は `ci-audit-contract.reference.yml` の `auditContract.statusClassification` へ照合し、`reporting.statuses.semantic-audit.subjectAggregation` を含む集約を経て、全体結果を同じ正本の `result` で確定する。本ガイドでは status の意味、優先順位、終端規則を補完しない。

証拠取得では、既存の provider 実行証拠または remote readback と、状態を変更しない観測を優先する。新しい外部副作用を伴う実行を、監査証拠を得る目的だけで開始しない。観測の開始可否と、完了した観測の証拠十分性は `auditContract.statusClassification` へそのまま渡す。新しい実行が必要な場合は監査から独立した操作として扱い、対象 owner の運用契約、authority、安全条件、明示的な実行承認を満たしてから、その結果を監査証拠へ接続する。

## 配置と責務

- `.ci/` は CI runtime 資産と設定だけを置く。
- テスト実装と fixture は project の既存 `tests/` 規約へ置き、必要な場合だけ `tests/ci/` を選ぶ。
- language skill は format、lint、test、build の具体的な検証を所有する。
- provider 固有スキルは workflow、再利用単位、権限、artifact、provider 実行環境への写像を所有する。
- project owner は adapter、project 固有設定、契約テスト、補助テストを所有する。

## 判定

個別 status の意味と全体結果は `ci-audit-contract.reference.yml` の `statuses` と `result` から導出する。provider preflight の `status` は事前の機械検証結果であり、監査全体の status へ直接読み替えない。監査者は provider 固有の事情で意味や優先順位を変更しない。監査完了は適合の `success` を意味しない。

## 監査完了条件

`ci-audit-contract.reference.yml` の `completion.requires` をすべて満たした状態を監査完了とする。証拠不足を理由付きで終端 status に分類した監査は完了できるが、そのことだけでは適合を示さない。

## 適合 success 条件

`ci-audit-contract.reference.yml` の `conformanceSuccess` を満たす場合だけ適合を `success` とする。preflight 後の provider 固有の必須確認は一つの共通監査フェーズへ写像して集約し、共通契約と並立する完了条件や適合条件を追加しない。
