# CI 監査の検出結果対応ガイド

## 目的

`references/verify-applied-ci-preset.guide.md`の機械監査が不一致・候補・差分を検出した場合に、その検出だけを意味監査で判断する。検出がない項目には適用しない。status、判断規則、報告項目は`references/ci-audit-contract.reference.yml`と`references/ci-audit-subjects.reference.yml`を正本とし、本ガイドでは再定義しない。

## 検出ごとの対応

| 検出 | 対応する節 |
| --- | --- |
| preflightの`findings`、a3-lint・actionlintの失敗 | 機械検証の不一致 |
| preflightの`semanticCandidates` | 意味候補 |
| planの`create`・`update`・`conflict`・`stale`、構造差による停止 | 標準との差分 |
| 差分または候補に関係するproject固有の契約・文書・AGENTS指示・ローカルスキル | プロジェクト固有規則との競合確認 |
| `reuse`以外の結果となったworkflowの経路 | 差分がある経路の確認 |

## 機械検証の不一致

診断が示す対象と期待状態・実状態を記録し、観測した対象契約違反として`statusClassification`へ渡す。読み取り専用監査では変更しない。修正を含む依頼では明示された変更許可の範囲だけを修正し、同じ機械監査で再検証する。Release／Packageのstage別descriptorがworkflowから到達していない場合は追加せず、撤去対象として記録する。preflightの起動不能や依存不足は、対象の不一致ではなく必須操作を開始できない観測として扱う。

## 意味候補

各候補について、owner、処理契約、入出力、停止条件、副作用を照合し、`retain`・`remove`・`replace`と根拠を記録する。

- CI以外の用途を持つ `.github/` 資産は、ownerと用途を確認して対象外理由を記録する。到達不能という理由だけで不要と判定しない。
- Actionとローカル実装の併存は、`references/review-ci-workflow.guide.md`の候補比較を適用する。`providerActions.selectionOrder`または`actionization.targets`に契約適合する候補がある、あるいは選択済みbindingが充足しない登録済みextensionではない場合は、配置成立の事実と分けて対象契約違反とする。
- 旧 `.ci/runtime/` は通常の配置資産として受容せず、参照元とownerを確認して移行未完了として報告する。

候補statusは`reporting.semanticCandidateStatus`から導出し、未判断の候補が残る間は意味監査を完了扱いにしない。

## 標準との差分

planの各結果を`latest-standard-alignment.machineComparison`に従って`differenceClassification`へ分類する。

| plan の結果 | 判断すること |
| --- | --- |
| `create` | 比較基準で追加された資産か、現配置の欠落か。必要性と移行対象 |
| `update` | 固定参照・版だけの差か、契約上の実質差か。後者は移行案を示す |
| `conflict` | 設定展開済みの比較結果がないため、preflightの構造照合・lock照合で許可された製品設定値と構造差を分け、構造差の必要性と許容条件 |
| `stale` | 参照元とowner。撤去・置換の対象か |
| 構造差による停止 | 診断が示す対象の差分の必要性と許容条件 |

正当性は標準で満たせない必須要件、例外の許容条件、owner、採用方針へ照合し、既存実装の存在や移行の手間だけを根拠にしない。plan対象外の`comparisonScope`（CI文書、owner結果、project固有規則）は、差分に関係する範囲を比較する。installerが適用対象ならそのowner結果を受領してから分類を確定する。

## プロジェクト固有規則との競合確認

本工程はセットアップ・更新・監査で共用する。宣言・手順の変更前、または監査で標準差分を分類するときに実施する。

1. 導入判断と正本解決入口から、対象の契約DSL、README・CI文書、有効なAGENTS指示、関連ローカルスキルを棚卸しする。使われていない記述を有効な規則と扱わず、無関係な文書・スキルへ探索を広げない。
2. 比較基準の標準と各規則を照合し、不要な前提条件、共通実装の複製、旧配置の義務化、手順の重複など、標準導入を妨げる競合を確認する。双方のパス・行番号、期待状態と実状態、owner、必要性の根拠を同じ差分表へ残し、同じ差分を重複集計しない。
3. 古い標準の重複定義は正本参照へ寄せる案を、不要なローカル規則には撤去・更新案を示す。必要な製品要件や厳しい安全方針は無断で緩和しない。例外の採否や正本の優先関係が確定しない場合は、ownerと必要な判断を示して未確認とする。
4. 読み取り専用監査では解決案までとし、修正依頼では許可された範囲だけを変更する。project外の共通スキル、公開契約、安全境界・認証方針の変更は承認条件に従い、標準やAgent指示をproject文書へ転記しない。

## 差分がある経路の確認

planの結果が`reuse`以外のworkflowと、そのworkflowから到達するproject所有の部分について、`references/inspect-ci-audit-details.guide.md`の「ユースケースシミュレーション」と「失敗診断」を適用する。`reuse`のworkflowへ範囲を広げない。
