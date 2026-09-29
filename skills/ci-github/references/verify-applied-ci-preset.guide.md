# 適用先 GitHub CI プリセット検証ガイド

## 目的

適用先 project に配置した GitHub Actions workflow と `.ci/` 資産を、導入前の構成検証から hosted 実行まで確認する。

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

共通の `target-resolution` で監査モードと監査対象 identity を記録してから provider preflight へ進む。provider preflight の結果は監査前stepとして保持し、後続監査の開始可否は共通契約の `preAudit.continuation` だけから導出する。

1. `references/validate-ci-preset.guide.md` の監査モード別手順に従って導入先 root の preflight を実行し、workflow、必要 asset、quality adapter descriptor、Action SHA、設定値の不一致を検出して記録する。読み取り専用監査では変更せず、修正を含む依頼では明示された変更許可の範囲だけを修正して再検証する。Release／Package の stage 別 descriptor が workflow から到達していない場合は追加せず、既存の未接続 descriptor を撤去対象として記録する。

   - `semanticCandidates` を必ず意味監査へ渡す。`.github/` と `.ci/` の全資産について、Action とローカル実装の併存は同一処理か、workflow は選択した用途に必要か、asset は到達経路と owner 契約を持つかを照合する。CI 以外の用途を持つ `.github/` 資産は owner と用途を確認して対象外理由を記録する。registry の `provider.staticValidation[].configPaths` に宣言された provider 静的検証設定は owner と配置が正本化されているため未分類候補に現れず、意味監査の対象外とする。機械検証が候補を列挙しても、意味監査の判定と根拠を代替しない。未分類のファイルが残る間は意味監査を完了扱いにしない。

2. `{ci-github-source-root}/lint-rules/a3-lint/` のCI向けa3-lintルール、`actionlint`、provider固有の静的検証を実行する。未解決placeholder、未登録Action、mutable ref、権限不一致、または静的検証を開始・継続できない事実を証拠とともに共通契約の `statusClassification` へ渡す。a3-lintは導入・更新・監査時に実行し、projectのworkflow runtime依存にしない。actionlint の project 固有設定は `.github/actionlint.yaml` を正本 path とし、内容は project-owned とする（registry の `provider.staticValidation` が owner を宣言）。
   - `.ci/provider-action-pins.yml`（registry の `providerActions.pinCompanion` から適用時に生成した承認値）と配置済み workflow の実行参照を照合し、不一致を許容しない。照合は project 内の file を入力に行い、provider の静的検証ツールの出力とは分けて記録する。

3. workflow の trigger、required check、runner、permissions、Action input/output、artifact handoff を、配置済み asset と project の設定 source に照合する。

   - `vars.` の参照は実行経路ごとに必須・条件付き・不要へ分類する。未選択 variant 専用または条件付きの Variable が未設定でも、到達しない経路の欠測として停止しない。
   - 到達する経路で必要な Variable の欠落・値の制約違反・正本との不一致を設定不一致として扱う。到達しない経路の未設定は不一致にしない。不要な値を Variable へ重複配置している場合も設定不一致とする。

4. `.ci/README.md` の保守状態を確認する。

   - README はすべての適用先 project に存在し、採用 preset / flow、差分または差分なし、owner、正本への導線、検証証跡、更新・撤去条件が記録されていることを確認する。project 固有差分がない場合も省略しない。
   - README がない、空欄だけ、または導線が切れている場合は対象契約違反として `statusClassification` へ渡す。変更を含む依頼では導入ガイドのテンプレートから作成・更新して再確認する。読み取り専用監査では不足を報告し、監査者が無断で変更しない。
   - README の decision、停止条件、共有契約が正本と異なる場合は、README の修正ではなく正本との不一致として扱う。
   - 固定項目は常に記載し、オプション項目は該当時だけ記載する。標準からの差異がない場合、補足の自由記述は不要とする。差異がある場合は、差異の理由、owner、正本・検証導線を追跡できることを確認する。
   - `ci-audit-subjects.reference.yml` の `repository-root-readme` に必要な入力として、workflow、provider registry、policy、manifest、hosted / remote 証拠を準備する。この手順では委譲せず、手順5の意味監査へ渡す。
   - `repository-ci-documentation.discovery` を適用して候補と個別扱いを確定する。適用対象は手順5の意味監査へ渡し、対象がない場合は `inapplicable` を適用する。
   - 共通検証で確定した `installer-distribution` の適用判定を手順5の意味監査へ渡し、GitHub Actions 固有の適用条件を追加しない。

5. `ci-workflow-use-cases.reference.yml` のユースケースシミュレーションで抽出した各シナリオを、GitHub Actions の実行経路へ写像する。

   - event と filter が入口条件を表すことを確認する。
   - job の `if` と `needs` を順に評価し、成功、失敗、skip、cancel 時の到達先を確認する。
   - job と workflow の `permissions`、environment、secret 注入、checkout 対象が、その経路の trust と副作用に一致することを確認する。
   - Action と reusable workflow の入出力、artifact の生成・受渡し・取得、summary と最終statusが preset 契約の出力と停止条件へ接続されることを確認する。
   - write経路では、前段の失敗、不一致、artifact欠落、権限不足、remote状態不明から publish へ到達しないことを確認する。
   - publication request は、GitHub が受理した `workflow_dispatch` の run identity、event、actor、default branch、workflow path を hosted 設定と run metadata で確認する。actor が publication authorization authority であることを project owner 契約と照合し、一致しない、または確認不能なら意味監査を成功にしない。actor の存在確認は authorization の意味確認を代替しない。これは承認済み入力の搬送 provenance であり、タグ作成前の人間による本文承認の証明へ読み替えない。
   - 標準 Release flow では、git スキルによる release identity と本文の事前承認後に annotated tag を作成し、その push が request handoff で停止することを確認する。tag request の成功後に、認証済み dispatcher が同じ承認済み本文と publication authorization の一意な approval ID、digest、期限を渡す手動 publication request だけが default branch の caller を経て publish へ到達することを確認する。publication request が request と notes handoff を同一 run に生成し、caller が workflow path、event、default branch、run ID、head SHAを、publication が actor／triggering actor の存在、artifact digest、release identity、approval ID／期限を再検証することを確認する。承認期限は authority 入口だけでなく publish 直前にも再検証する。tag request の成功を publication caller へ直接接続する `workflow_run` 連鎖は不一致とする。
   - `repository-root-readme.delegation` へ GitHub Actions 固有の正本と実経路を検証証跡として追加し、この時点で一度だけ委譲する。返却結果を `resultHandling` で共通 status へ集約する。
   - `repository-ci-documentation` が適用対象の場合、GitHub上の実経路として workflow、固定 SHA Action、owner 契約、手動操作を照合先に追加し、共通契約の `reviewRequirements` と `reportingFields` を適用する。
   - `project-owned-ci-adapter` が適用対象の場合、workflow から adapter への接続、適用する script 契約の identity／version、手順6で取得または再利用する project 契約テスト証拠の対象 identity を特定する。証拠と subject status はこの手順では記録しない。
   - `installer-distribution` が適用対象の場合、GitHub Actions 固有の公開経路と証拠を `delegation.ciInputs` へ加えて、この時点で一度だけ installer スキルへ委譲する。返却結果を保持し、同 subject の `publicationPathCheck` を GitHub Actions の実経路へ写像する。修正が必要な場合は共通契約の `remediationPriority` をそのまま適用し、GitHub Actions 固有の優先規則を追加しない。
   - rerun では `run_attempt` だけを根拠に状態を再利用せず、request、source、handoff、remote identity を再確認する経路をたどる。
   - 共通処理を project-owned の entrypoint へ接続した場合は、`review-ci-workflow.guide.md` の候補比較を適用する。`providerActions.selectionOrder` または `actionization.targets` に契約適合する候補がある、あるいは選択済み binding が充足しない登録済み extension ではない、という対象契約違反を観測した場合は、配置成立の事実と分けて `statusClassification` へ渡す。preflight は未登録の project-owned fallback を補完しない。また、コードの意味的同一性を推測せず、候補比較の記録と契約テストの証拠を別に確認する。

   workflow の全入口、条件分岐、write job、owner handoff も逆向きにたどり、対応するシナリオまたは対象外の根拠があることを確認する。静的に式を確定できない場合は、監査操作の完了有無と証拠不足の事実を記録し、推測せず `statusClassification` へ渡す。

6. `verify-applied-ci-assets.guide.md` の動的証拠に関する副作用判定を先に適用する。実行可能な project の契約対象ごとに、language adapter と `.ci` entrypoint の代表正常系、主要失敗、境界条件を、解決済みの検査ツール所有状態を使って実行する。入力、出力、終了状態、証跡と管理対象資産の状態不変を確認する。管理対象資産／外部の永続状態への書き込みが必要、または副作用を確認できない場合、read-only では実行せず、必須監査操作を開始・継続できない事実を `statusClassification` へ渡す。

   - `project-owned-ci-adapter` が適用対象の場合、手順5で特定した対象について project 契約テスト証拠を取得または再利用し、監査対象 revision への結合と同 subject の `evidenceRequirements` を照合する。欠落、期限切れ、失敗を非成功として保持し、証拠と subject status を記録する。preflight 成功だけで subject を成功にしない。

7. 契約テストで覆われない局所分岐、再発防止、fixture／runtime 互換性が必要かを判定する。不要な場合は補助証拠フェーズを対象外とする理由を記録する。必要な場合は既存の補助証拠を確認し、不足を `test-gap` として記録する。補助操作の開始可否と完了後の証拠十分性を分けて記録し、共通契約の `statusClassification` へ渡す。修正を含む依頼で補助テストを追加する場合も、明示された変更許可の範囲に限定する。補助テストは契約保証の代替にしない。

8. preset 契約が provider 実行環境または remote readback を要求する経路だけで、次の証拠を取得する。対象外の経路では実行証拠フェーズを対象外とする理由を記録する。

   - `quality-gate`: required check または trigger の意味を確認する変更
   - `release-request`: tag preparation、request identity、handoff
   - `release-publication`: 手動request、default branch caller、notes identity、authority、source identity、artifact、checksum、remote release
   - `package-publication`: version plan、registry 状態、非上書き条件

   既存の hosted run または remote readback と、状態を変更しない GitHub 上の観測を優先する。監査証拠を得る目的だけで Release／Package の実行を新たに開始しない。新しい hosted 実行が必要な場合は、`verify-applied-ci-assets.guide.md` の証拠取得境界に従って監査から独立した操作として扱う。hosted、secret、権限、remote resource の観測を開始・継続できない事実、または完了した観測の証拠が不足・曖昧である事実を記録し、共通の `statusClassification` へ渡す。

## 共通監査前段・フェーズ・集約への写像

| 共通 step / phase / aggregation ID | GitHub Actions での適用箇所 |
| --- | --- |
| `target-resolution` | 前提と入力から対象 repository、revision、preset、設定 source を固定する |
| `provider-preflight` | 手順1で配置資産、固定 Action ref、設定を preflight する |
| `static-validation` | 手順2から4で workflow、設定、README、到達資産を静的に検証する |
| `use-case-simulation` | 手順5で通常・例外・再実行経路と意味監査 subject を GitHub Actions の実経路へ写像する |
| `contract-evidence` | 手順6で契約対象の正常、失敗、境界を検証する |
| `supplemental-evidence` | 手順7で固有目的の有無を判定し、許可された修正時だけ追加する |
| `runtime-evidence` | 手順8で既存 hosted run または remote readback を対象 identity に結合する |
| `result-aggregation` | 機械監査、意味監査subject、意味候補、適用対象の実行証拠を保持し、監査契約の `reporting` と `result` を適用する |

## テスト資産の配置

- `.ci/` には workflow runtime、adapter、設定だけを置く。
- Release／Package の実行資産は、選択した固定 SHA Action binding または `requiredExtensions` の直接接続を正本とし、未接続の用途別 descriptor を完了資産に含めない。管理対象集合は preset、Action binding、その依存閉包から導出し、固定本数で判定しない。
- `release-publication` は source identity gate と固定 source quality job を分離し、build が両方の成功を要求することを確認する。`.ci/platform-manifest.yml` は `platforms[].{id,runner,target}` として検証し、選択された登録済み標準実装の Action 参照と依存資産を preflight で確認する。
- 契約テストと補助テストは project の既存 `tests/` 規約へ置き、必要な場合だけ `tests/ci/` を使用する。
- preflight script、preflight runtime、導入元スキルの配置 path は project の実行時資産に含めない。

## 判定

個別 status と全体結果は `ci-audit-contract.reference.yml` の `statusClassification` と `result` をそのまま適用する。配置済み資産の不一致、preflight の起動不能、完了した hosted／secret／remote 観測の証拠不足は、それぞれ対応する共通 condition へ写像し、GitHub 固有の status 規則を追加しない。観測事実、根拠、証拠 identity は provider 証拠として保持する。

## 監査完了条件

preflight 後の GitHub Actions 固有の必須確認を上表の一つの共通監査フェーズへ写像し、結果、根拠、証拠 identity を保持する。そのうえで `ci-audit-contract.reference.yml` の `completion` だけから監査完了を導出する。監査完了は適合の `success` を意味しない。

## 適合 success 条件

適合は `ci-audit-contract.reference.yml` の `conformanceSuccess` だけから導出する。`.ci/README.md` の必須確認や `repository-root-readme` の委譲結果を含む GitHub Actions 固有の結果は、対応する共通監査フェーズへ集約済みでなければならず、provider 固有の適合条件を別に追加しない。
