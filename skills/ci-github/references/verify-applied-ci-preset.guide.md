# 適用済み GitHub CI の監査ガイド

## 目的

リリース前の確認として、採用可能な最新の公開済み安定版（`references/deploy-ci-assets.guide.md`の「対応条件」）の標準構成と、適用先のGitHub Actions workflow・`.ci/`資産の整合を監査する。監査はスクリプトの実行と毎回必須の確認で完結させ、問題を検出した場合や詳細の確認を依頼された場合だけ専用ガイドへ進む。目的と実公開との境界は`references/ci-audit-contract.reference.yml`の`auditContract.purpose`を正本とする。

## 導線

| 状況 | 読むもの |
| --- | --- |
| すべての監査 | 本ガイド |
| 機械監査が不一致・候補・差分を検出した | `references/triage-ci-audit-findings.guide.md` の該当節 |
| 経路の机上実行・失敗診断、証跡監査、installer監査が必要 | `references/inspect-ci-audit-details.guide.md` の該当節 |

## 正本

| 正本 | 用途 |
| --- | --- |
| `references/ci-audit-contract.reference.yml` | 監査段階、監査モード、フェーズ、status、集約、監査完了、適合 |
| `references/ci-audit-subjects.reference.yml` | 意味監査subjectの適用判定、owner委譲、判断規則、報告形式 |
| `references/validate-ci-preset.guide.md` | preflightとa3-lintの実行方法と検査範囲 |
| `references/deploy-ci-assets.guide.md` | 比較基準Releaseの取得とplan |

本ガイドと専用ガイドは上記の手順を監査の順序へ並べ、status、判断規則、報告項目を再定義しない。CI runtimeにSDD CLIやDSLを組み込まず、配布元スキルのリソースを適用先の実行時依存にしない。

## 入力

- 監査モード（`read-only`／`remediation`）、監査段階（既定は構成監査のみ）、repository / revisionを含む監査対象identity
- `.github/` と `.ci/` の全資産。撤去漏れの検出対象である旧 `.ci/runtime/` を含む
- 導入済み配布元revisionのdistributionと、`{project-root}/.a3-skills/ci-github/` のスキル専用ローカル状態 root
- project root の `README.md`、CIの判断・手順を定義・制約する追跡対象文書
- project の契約正本（存在する場合）、language adapter、既存テストの実行方法

`auditContract.stages`で段階を選び、監査モード・対象identityとともに記録する。通常は構成監査だけとし、証跡監査・両段階・リリース前の実行確認を指定された場合だけ、構成監査の後に`references/inspect-ci-audit-details.guide.md`の「証跡監査」へ進む。

## 機械検証の選択

セットアップ・更新・監査では、固定providerが公開しているpreflight・lint・planを再利用し、検査処理とルールをスキルや利用projectへ複製しない。採用providerと比較基準の版を区別して記録する。機械検査が対応する項目だけを検査済みとし、未実装・解析不能の項目は根拠とともに意味監査へ渡す。架空の検査コマンドや成功結果を補わず、機械検証の成功を構成監査全体や実行証跡の成功へ読み替えない。

READMEの標準コマンドと宣言・manifestは、OS別の実行ファイル、URL・asset名、参照先、未確定値、標準配置との差を照合する。配置差・非標準コマンドの検出は例外の正当性を決めない。READMEコマンドの実行や公開URLの取得成功を、構成の静的検証の前提にしない。

## 1. 機械監査

次の順に実行し、各出力を証拠として保持する。read-only監査で書き込むのはスキル専用ローカル状態だけとし、applyやlock生成は行わない。

1. **preflight**（`provider-preflight`）: 導入済み配布元revisionのdistributionから`references/validate-ci-preset.guide.md`の監査モード別手順で実行する。workflow構造、必要asset、quality adapter descriptor、Action SHAとpin companion、設定値、配布同一性lockの不一致は`findings`、registry外workflow・到達不能asset・未分類資産・Actionとローカル実装の併存は`semanticCandidates`として出力される。後続の開始可否は`preAudit.continuation`から導出する。
2. **静的検証**（`static-validation`）: 同ガイドのa3-lint（workflowと`.ci/README.md`）と`actionlint`を実行する。actionlintのproject固有設定は`.github/actionlint.yaml`（registryの`provider.staticValidation`がownerを宣言するproject-owned content）とする。
3. **最新標準との差分**: `references/deploy-ci-assets.guide.md`の「対応条件」で比較基準Releaseを確定し、同ガイドの「取得」で導入済みと同じpreset・assetを取得する。同じ選択で`plan`を`--set`なしで実行する。製品設定は、配置済みcallerのdigestが既存lockと一致し、導入済みrevisionのdistributionを読み取れる場合だけ引き継がれる。比較基準と導入済みrevisionが同じ場合もplanを省略せず、全対象が`reuse`になることを確認する。

不一致、`semanticCandidates`、planの`reuse`以外の結果、または構造差による停止があれば、`references/triage-ci-audit-findings.guide.md`で該当する検出だけを判断する。機械監査のstatusは`reporting.statuses.machine-audit`から導出し、preflightの`status`を監査全体のstatusへ読み替えない。

## 2. 毎回必須の意味監査

スクリプトの結果がすべて正常でも誤りが残り得る、次の項目を毎回確認する。適用判定、委譲、判断規則、報告項目はsubject catalogに従い、該当対象がない条件付きsubjectは理由を記録して除外する。

| 確認 | subject | GitHub Actions での確認先 |
| --- | --- | --- |
| 最新標準との整合 | `latest-standard-alignment` | 機械監査と検出結果対応の結果を集約する |
| project所有の部分 | `project-owned-ci-adapter` | adapter・extension・独自workflowの入口、適用契約、workflow接続、必須契約テストの配置 |
| root README | `repository-root-readme` | workflow、registry、policy、manifest、検証証拠を`delegation.ciInputs`として揃え、root-docsへ一度だけ委譲する |
| CI文書 | `repository-ci-documentation` | `discovery`で候補を確定し、記述をworkflow、固定SHA Action、owner契約、手動操作と照合する |
| `.ci/README.md` | — | 構造はa3-lintの`ci_github_ci_readme_contract`が検査する。採用preset / flow、差分の有無と理由、owner、正本への導線、検証証跡、更新・撤去条件が機械監査の結果と一致するかを確認する。decision、停止条件、共有契約が正本と異なる場合は、READMEの修正ではなく正本との不一致として扱う |
| Release対象とversion | `release-target-coverage` | `release-request`・`release-publication` callerと公開宣言の接続、`versionConsistency`のversion受け渡し。公開スキルは`references/publish-project-skills.guide.md`の「同梱の選択」を確認し、選択未確認を未同梱へ読み替えない。同梱する場合は同ガイドの「監査」を選択段階に応じて適用する |

project所有の部分がある場合は、局所分岐、再発防止、fixture／runtime互換性の補助検査（`supplemental-evidence`）の導線が必要かを判断し、必要な導線の欠落は`implementation-gap`とする。不要な場合とproject所有の部分がない場合は対象外理由を記録する。実行結果の照合は証跡監査で行う。

`ci-failure-diagnostics`、`ci-workflow-sequence`、`installer-distribution`とユースケースシミュレーションは、subject catalogと監査契約の適用条件に該当する場合だけ`references/inspect-ci-audit-details.guide.md`で実施する。planが`reuse`の標準経路は、提供元の契約テストを証拠とする。

## 3. 判定と報告

各結果のstatusを`statusClassification`で分類し、`statusAggregation`と`result`で集約する。監査完了は`completion`、適合は`conformanceSuccess`だけから導出し、監査完了を適合の`success`と同一視しない。

報告は`latest-standard-alignment`の`reportFormat`・`reportingOrder`に従い、比較基準、標準整合のstatus、差分と理由、移行案・未確認事項を先頭に示す。構成監査と証跡監査のstatusを分け、構成だけの成功を動作確認済みやリリース準備完了へ読み替えない。監査レポートの最後に同subjectの`finalReport`で「標準適合度・差分・正当性レビュー」を必ず付け、差分なし・未確認の場合も省略しない。installerのownerレビュー結果は保持して一つのレポートにまとめる。

finding は review スキルへ渡し、正本との不一致は `contract-gap`、実装経路または必要な検証経路の欠落・迂回・未接続は `implementation-gap`、正本や必要な実行証拠を確定できない場合は `undecidable-needs-confirmation` として区別する。

## 4. 最終結果の独立レビュー

監査・監査後修正の最終報告前に、検証とセルフレビューを終えた対象をpost-artifact-reviewへ「独立レビュー必須」として渡す。比較基準、対象状態、変更集合または監査範囲、選択段階、機械監査の出力、workflow・`.ci/`・READMEの現物と根拠を固定する。installerが適用対象ならci-release-installerスキルのインストーラ監査にある独立レビューの入力を含め、主工程から一度だけ実施する。

独立レビューを監査の代替にしない。レビューが未完了なら最終結果の完了報告・デプロイへ進まず、その事実を報告する。
