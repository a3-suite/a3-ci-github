# 適用先 GitHub CI プリセット検証ガイド

## 目的

リリース前に、最新の公開済み安定版が提供する標準構成と、適用先のGitHub Actions workflow・`.ci/`資産の整合を中心に監査する。標準へ合わせる差分と必要な固有差分を明らかにし、安全性・動作・リリース前の検証証拠で裏付ける。目的と対象境界は`ci-audit-contract.reference.yml`の`auditContract.purpose`に固定する。

`verify-applied-ci-assets.guide.md` でテスト対象と証拠役割を決め、このガイドで GitHub Actions 固有の検証へ写像する。

## 前提

- コピー先 project には配布元 repository の配置ディレクトリが存在しない。
- preflight は `{ci-github-source-root}` の runtime から導入先 root を検査し、導入先へコピーしない。
- preset の意味、入出力、停止条件は `ci-preset-contracts.reference.yml` を参照する。
- GitHub Actions の asset 集合、Action mapping、permissions、runner、artifact は本スキルの registry と policy を参照する。
- 共通の監査意味論は `ci-audit-contract.reference.yml` を参照し、本ガイドでは再定義しない。
- 共通の意味監査 subject は `ci-audit-subjects.reference.yml` を参照し、本ガイドでは発見、適用、owner 委譲、報告項目を再定義しない。
- 共通ガイドの provider 所有 root は `.github/`、provider の再利用単位は GitHub Action／reusable workflow、再利用単位の選択順位と移行候補は registry の `providerActions.selectionOrder`／`actionization.targets` へ写像する。`.ci/` は共通の project-local CI 資産 root として併せて棚卸しする。

## 入力

- 監査モードと、repository / revision を含む監査対象 identity
- read-only 監査で検査ツールが使う、`{project-root}/.a3-skills/ci-github/` のスキル専用ローカル状態 root
- `.github/` と `.ci/` の全資産の棚卸し。配置済み workflow、adapter、script、trusted control、policy、管理文書、配布同一性 lock、および撤去漏れの検出対象である旧 `.ci/runtime/` を含む
- project の契約正本（存在する場合）と language adapter
- project root の `README.md` と、`repository-root-readme.ownerSkill` が要求する project の正本解決入口
- repository 内で CI の判断または手順を定義・制約する追跡対象文書（存在する場合）
- Repository / Organization / Environment の設定名
- 適用先 project の既存テスト実行方法

## 検証手順

共通の `target-resolution` でリリース前確認という監査目的、監査モードと監査対象 identity を記録してから provider preflight へ進む。provider preflight の結果は監査前stepとして保持し、後続監査の開始可否は共通契約の `preAudit.continuation` だけから導出する。

同時に`auditContract.stages`で段階を選択し、記録する。既定は構成監査のみ。証跡監査を指定された場合は同じ対象の構成監査から証跡監査へ進む。以下の手順は確認項目ごとに`stages.itemMapping`とsubjectの`stageChecks`へ写像し、実行結果の未取得を構成の不適合へ混ぜない。

監査開始時に`ci-audit-subjects.reference.yml`の必須subject`latest-standard-alignment`を登録し、同subjectの`baselineResolution`で最新の公開済み安定版を比較基準に固定する。GitHub Actionsの実workflow・Action binding・資材・設定・文書を`comparisonScope`へ対応付け、配置済み資産と比較する。差分分類・証拠・判定入力・報告順は同subjectに従う。読み取り専用監査では比較と移行案の提示までとし、既存実装を更新しない。

1. `references/validate-ci-preset.guide.md` の監査モード別手順に従って導入先 root の preflight を実行し、workflow、必要 asset、quality adapter descriptor、Action SHA、設定値の不一致を検出して記録する。読み取り専用監査では変更せず、修正を含む依頼では明示された変更許可の範囲だけを修正して再検証する。Release／Package の stage 別 descriptor が workflow から到達していない場合は追加せず、既存の未接続 descriptor を撤去対象として記録する。

   - `semanticCandidates` を必ず意味監査へ渡す。`.github/` と `.ci/` の全資産について、Action とローカル実装の併存は同一処理か、workflow は選択した用途に必要か、asset は到達経路と owner 契約を持つかを照合する。CI 以外の用途を持つ `.github/` 資産は owner と用途を確認して対象外理由を記録する。registry の `provider.staticValidation[].configPaths` に宣言された provider 静的検証設定は owner と配置が正本化されているため未分類候補に現れず、意味監査の対象外とする。機械検証が候補を列挙しても、意味監査の判定と根拠を代替しない。未分類のファイルが残る間は意味監査を完了扱いにしない。

2. `{ci-github-source-root}/lint-rules/a3-lint/` のCI向けa3-lintルール、`actionlint`、provider固有の静的検証を実行する。未解決placeholder、未登録Action、mutable ref、権限不一致、または静的検証を開始・継続できない事実を証拠とともに共通契約の `statusClassification` へ渡す。a3-lintは導入・更新・監査時に実行し、projectのworkflow runtime依存にしない。actionlint の project 固有設定は `.github/actionlint.yaml` を正本 path とし、内容は project-owned とする（registry の `provider.staticValidation` が owner を宣言）。
   - `.ci/provider-action-pins.yml`（registry の `providerActions.pinCompanion` から適用時に生成した承認値）と配置済み workflow の実行参照を照合し、不一致を許容しない。照合は project 内の file を入力に行い、provider の静的検証ツールの出力とは分けて記録する。

3. workflow の trigger、required check、runner、permissions、Action input/output、artifact handoff を、配置済み asset と project の設定 source に照合する。

   - `vars.` の参照は実行経路ごとに必須・条件付き・不要へ分類する。未選択 variant 専用または条件付きの Variable が未設定でも、到達しない経路の欠測として停止しない。
   - 到達する経路で必要な Variable の欠落・値の制約違反・正本との不一致を設定不一致として扱う。到達しない経路の未設定は不一致にしない。不要な値を Variable へ重複配置している場合も設定不一致とする。

4. `.ci/README.md` の保守状態を確認する。

   - README はすべての適用先 project に存在し、採用 preset / flow、差分または差分なし、差分がある場合は標準で成立しない理由、owner、正本への導線、検証証跡、更新・撤去条件が記録されていることを確認する。project 固有差分がない場合も省略しない。
   - README がない、空欄だけ、または導線が切れている場合は対象契約違反として `statusClassification` へ渡す。変更を含む依頼では導入ガイドのテンプレートから作成・更新して再確認する。読み取り専用監査では不足を報告し、監査者が無断で変更しない。
   - README の decision、停止条件、共有契約が正本と異なる場合は、README の修正ではなく正本との不一致として扱う。
   - 固定項目は常に記載し、オプション項目は該当時だけ記載する。標準からの差異がない場合、補足の自由記述は不要とする。差異がある場合は、標準で成立しない理由、owner、正本・検証導線を追跡できることを確認する。
   - `ci-audit-subjects.reference.yml` の `repository-root-readme` に必要な入力として、workflow、provider registry、policy、manifest、リリース前確認に適用するhosted設定・検証証拠を準備する。この手順では委譲せず、手順5の意味監査へ渡す。
   - `repository-ci-documentation.discovery` を適用して候補と個別扱いを確定する。適用対象は手順5の意味監査へ渡し、対象がない場合は `inapplicable` を適用する。
   - 共通検証で確定した `installer-distribution` の適用判定を手順5の意味監査へ渡し、GitHub Actions 固有の適用条件を追加しない。

5. `ci-workflow-use-cases.reference.yml` のユースケースシミュレーションで抽出した各シナリオを、GitHub Actions の実行経路へ写像する。

   以下の公開経路は、構成監査では配置済みの実装・設定・契約テストへの対応付けで照合する。テストの実行結果は選択した証跡監査で照合する。実tag作成、実publication request、実公開成功の発生をシミュレーションの成立条件にしない。

   - event と filter が入口条件を表すことを確認する。
   - job の `if` と `needs` を順に評価し、成功、失敗、skip、cancel 時の到達先を確認する。
   - job と workflow の `permissions`、environment、secret 注入、checkout 対象が、その経路の trust と副作用に一致することを確認する。
   - Action と reusable workflow の入出力、artifact の生成・受渡し・取得、summary と最終statusが preset 契約の出力と停止条件へ接続されることを確認する。
   - write経路では、前段の失敗、不一致、artifact欠落、権限不足、remote状態不明から publish へ到達しないことを確認する。
   - publication request は、`workflow_dispatch` のrun identity、event、actor、default branch、workflow pathを検証する実装を、workflow、hosted設定、project owner契約、契約テストへ照合する。actorのauthorizationを照合する経路と、不一致・確認不能で停止する経路を確認する。実公開runの発生やactorの実観測は公開後確認へ分け、未発生だけで意味監査を非成功にしない。actorの存在確認はauthorizationの意味確認や、タグ作成前の人間による本文承認の証明を代替しない。
   - 標準 Release flow では、git スキルによる release identity と本文の事前承認後に annotated tag を作成し、その push が request handoff で停止することを確認する。tag request の成功後に、認証済み dispatcher が同じ承認済み本文と publication authorization の一意な approval ID、digest、期限を渡す手動 publication request だけが default branch の caller を経て publish へ到達することを確認する。publication request が request と notes handoff を同一 run に生成し、caller が workflow path、event、default branch、run ID、head SHAを、publication が actor／triggering actor の存在、artifact digest、release identity、approval ID／期限を再検証することを確認する。承認期限は authority 入口だけでなく publish 直前にも再検証する。tag request の成功を publication caller へ直接接続する `workflow_run` 連鎖は不一致とする。
   - `repository-root-readme.delegation` へ GitHub Actions 固有の正本と実経路を検証証跡として追加し、この時点で一度だけ委譲する。返却結果を `resultHandling` で共通 status へ集約する。
   - `repository-ci-documentation` が適用対象の場合、GitHub上の実経路として workflow、固定 SHA Action、owner 契約、手動操作を照合先に追加し、共通契約の `reviewRequirements` と `reportingFields` を適用する。
   - `project-owned-ci-adapter`が適用対象の場合、workflow接続、適用する契約、必須テストの配置と対応付けを構成監査で確認して記録する。実行結果の取得・照合と証跡監査のsubject statusは手順6で扱う。
   - rerun では `run_attempt` だけを根拠に状態を再利用せず、request、source、handoff、remote identity を再確認する経路をたどる。
   - 共通処理を project-owned の entrypoint へ接続した場合は、`review-ci-workflow.guide.md` の候補比較を適用する。`providerActions.selectionOrder` または `actionization.targets` に契約適合する候補がある、あるいは選択済み binding が充足しない登録済み extension ではない、という対象契約違反を観測した場合は、配置成立の事実と分けて `statusClassification` へ渡す。preflight は未登録の project-owned fallback を補完しない。また、コードの意味的同一性を推測せず、候補比較の記録と契約テストの証拠を別に確認する。

   workflow の全入口、条件分岐、write job、owner handoff も逆向きにたどり、対応するシナリオまたは対象外の根拠があることを確認する。静的に式を確定できない場合は、監査操作の完了有無と証拠不足の事実を記録し、推測せず `statusClassification` へ渡す。

   **標準比較工程**: シミュレーション後、整合判定の前に次を順に実施する。

   1. `latest-standard-alignment.comparisonScope`の各項目について標準と現状を対応付ける。project-localのセットアップガイドも文書の比較対象に含め、既存ガイドとの一致だけを標準適合の根拠にしない。
   2. `installer-distribution`が適用対象なら、GitHub Actions固有の公開経路と証拠を`delegation.ciInputs`へ加えてinstallerスキルへ一度だけ委譲する。ownerが返す固定providerの対応根拠、OS別の期待入口・現入口とREADMEコマンド、移行可否・維持理由を既存の差分表へ受け取る。同subjectの`publicationPathCheck`を実経路へ写像する。
   3. 対象identity・比較基準・段階とowner結果の結合を確認し、`latest-standard-alignment`の比較完了条件を照合して差分の必要性と移行対象を判定する。固定providerの対応根拠やOS別比較が欠ける場合はownerへ差し戻し、既存のstatus分類へ渡す。installerの判定をCI側で代替せず、修正の優先順位は`remediationPriority`に従う。

6. 構成監査では契約対象と実行可能な検査導線の対応を確認する。証跡監査を選択した場合は、`verify-applied-ci-assets.guide.md`の副作用判定を先に適用し、language adapterと`.ci` entrypointの代表正常系、主要失敗、境界条件の実行結果を取得または再利用する。実行時は入力、出力、終了状態、証跡と管理対象資産の状態不変を確認する。管理対象資産／外部の永続状態への書き込みが必要、または副作用不明ならread-onlyでは実行せず、必須操作の開始・継続不能を証跡監査の`statusClassification`へ渡す。未選択の実行確認は未依頼として記録する。

   - 証跡監査で`project-owned-ci-adapter`が適用対象の場合、手順5で特定した契約テストの結果を取得または再利用し、対象revisionとの結合と`stageChecks.execution-evidence`を照合する。欠落・期限切れ・失敗は証跡監査の非成功として保持し、preflightや構成監査の成功で代替しない。

7. 局所分岐、再発防止、fixture／runtime互換性の検査導線が必要かを構成監査で判定する。不要なら対象外理由を記録する。必要な導線の欠落は構成監査の`test-gap`とする。証跡監査を選択した場合は既存の補助テスト結果を照合し、操作の開始可否と完了後の証拠不足を分けて共通`statusClassification`へ渡す。テスト追加は明示された変更許可の範囲に限定し、補助テストを契約保証の代替にしない。

8. 共通監査契約の`runtime-evidence.appliesWhen`に該当するリリース前確認だけで、次の設定・検証証拠を取得する。対象外の経路では実行証拠フェーズを対象外とする理由を記録する。

   `stages.itemMapping`に従い、providerの必要設定を読み取る確認は構成監査、動的な実行結果の照合は選択した証跡監査へ分ける。runtime-evidence全体を証跡監査へ移して設定確認を省略しない。

   - `quality-gate`: required check または trigger の意味を確認する変更
   - `release-request`: tag preparation、request identity、handoffの実装・設定・契約テスト
   - `release-publication`: 手動request、default branch caller、notes identity、authority、source identity、候補artifact、checksum、公開後readbackと不一致時停止の実装・設定・契約テスト
   - `package-publication`: version plan、公開先registryの設定・既存状態、非上書き条件の実装・契約テスト

   状態を変更しないGitHub設定の観測と、対象identityに結合できる既存の非公開実行証拠を優先する。実Release／Packageの作成、実公開run、公開済みassetの取得成功は監査の必須証拠にしない。これらは公開後確認として別記する。リリース前に必要な設定・非公開実行の観測を開始・継続できない事実、または完了した観測の証拠不足は、共通の`statusClassification`へ渡す。新しいhosted実行は`verify-applied-ci-assets.guide.md`の証拠取得境界に従って監査から独立した操作として扱う。

## 共通監査前段・フェーズ・集約への写像

| 共通 step / phase / aggregation ID | GitHub Actions での適用箇所 |
| --- | --- |
| `target-resolution` | 前提と入力から対象 repository、revision、preset、設定 source を固定する |
| `provider-preflight` | 手順1で配置資産、固定 Action ref、設定を preflight する |
| `static-validation` | 手順2から4で workflow、設定、README、到達資産を静的に検証する |
| `use-case-simulation` | 手順5で通常・例外・再実行経路と意味監査 subject を GitHub Actions の実経路へ写像する |
| `contract-evidence` | 手順6で構成監査の検査導線と、選択した証跡監査の実行結果を分ける |
| `supplemental-evidence` | 手順7で必要な検査導線と、選択した証跡監査の補助結果を分ける |
| `runtime-evidence` | 手順8でリリース前に必要なhosted設定・非公開実行証拠を対象identityに結合し、実公開・公開後確認は分ける |
| `result-aggregation` | 機械監査、意味監査subject、意味候補、適用対象の実行証拠を保持し、監査契約の `reporting` と `result` を適用する |

## テスト資産の配置

- `.ci/` には workflow runtime、adapter、設定だけを置く。
- Release／Package の実行資産は、選択した固定 SHA Action binding または `requiredExtensions` の直接接続を正本とし、未接続の用途別 descriptor を完了資産に含めない。管理対象集合は preset、Action binding、その依存閉包から導出し、固定本数で判定しない。
- `release-publication` は source identity gate と固定 source quality job を分離し、build が両方の成功を要求することを確認する。`.ci/platform-manifest.yml` は `platforms[].{id,runner,target}` として検証し、選択された登録済み標準実装の Action 参照と依存資産を preflight で確認する。
- 契約テストと補助テストは project の既存 `tests/` 規約へ置き、必要な場合だけ `tests/ci/` を使用する。
- preflight script、preflight runtime、導入元スキルの配置 path は project の実行時資産に含めない。

## 報告

共通の`latest-standard-alignment.reportFormat`を使用する。GitHub固有の形式を追加せず、必須の詳細根拠は参照先または該当区分へ記載する。

`latest-standard-alignment.reportingFields`と`reportingOrder`に従い、最新標準との整合判定・差分・移行案を先頭に示す。installerの標準差分はowner結果を保持して集約する。安全性・動作・Hostedの確認結果と監査全体のstatusを分けて示す。

構成監査と証跡監査のstatusを分け、全体結果は選択した段階の範囲で表示する。証跡監査が未選択なら未実施と未依頼理由を明記し、構成のstatusへ混ぜない。構成だけの成功を動作確認済みやリリース準備完了へ読み替えない。実公開時のactor・run、remote release、公開済みassetの取得・checksum照合は公開後確認として別記する。

監査レポートの最後に、同subjectの`finalReport`に従って「標準適合度・差分・正当性レビュー」を必ず付ける。共通資産監査と一体で報告する場合は一つにまとめ、installerのownerレビュー結果も保持する。差分なし・未確認の場合も省略しない。

## 判定

個別 status と全体結果は `ci-audit-contract.reference.yml` の `statusClassification` と `result` をそのまま適用する。配置済み資産の不一致、preflight の起動不能、完了した hosted／secret／remote 観測の証拠不足は、それぞれ対応する共通 condition へ写像し、GitHub 固有の status 規則を追加しない。観測事実、根拠、証拠 identity は provider 証拠として保持する。

## 監査完了条件

preflight 後の GitHub Actions 固有の必須確認を上表の一つの共通監査フェーズへ写像し、結果、根拠、証拠 identity を保持する。そのうえで `ci-audit-contract.reference.yml` の `completion` だけから監査完了を導出する。監査完了は適合の `success` を意味しない。

## 適合 success 条件

適合は `ci-audit-contract.reference.yml` の `conformanceSuccess` だけから導出する。`.ci/README.md` の必須確認や `repository-root-readme` の委譲結果を含む GitHub Actions 固有の結果は、対応する共通監査フェーズへ集約済みでなければならず、provider 固有の適合条件を別に追加しない。
