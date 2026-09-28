# CI ワークフローレビューガイド

## 目的
- 既存 CI の構成、信頼境界、無料枠消費、実装分離、publish 安全性を同じ順序で確認する。
- 問題を見つけた場合に、局所修正ではなく責務境界の崩れとして整理する。

## 監査の責務境界

| 単位 | 責務 |
| --- | --- |
| `ci-audit-contract.reference.yml` | 監査モード、フェーズ、status、集約、監査完了、適合の正本 |
| `ci-audit-subjects.reference.yml` | 意味監査 subject の発見、適用、owner 委譲、CI 側の接続確認、報告項目の正本 |
| `verify-applied-ci-assets.guide.md` | 対象解決と共通監査フェーズの実行 |
| provider 固有の検証ガイド | preflight 後の provider 固有検査と証拠を、一つの共通監査フェーズへ写像 |
| provider preflight | 監査開始前の機械検証。監査全体の代替にはしない |
| 本ガイドと review スキル | テーマ別確認、finding、修正案、最終報告 |

実行導線は、本ガイドから共通検証、provider 固有検証、共通契約による集約、review 報告の順とする。各ガイドは共通契約と並立する status、監査完了条件、適合条件を定義しない。

## フロー
1. 適用先 CI 資産の共通検証を実行する。
   - `references/verify-applied-ci-assets.guide.md` の対象解決、検証順序、監査完了条件、適合判定を省略せず適用する。
   - 選択した provider 固有の検証ガイドへ委譲し、共通検証の各段階を provider の実行経路と証拠へ写像する。
   - 共通検証で確定した個別結果と証拠の provenance は上書きせず、後続のテーマ別確認で得た観測は該当する監査フェーズとsubjectのstatusへ集約する。findingの重大度は監査statusと分け、reviewスキルの合否と最終判断へ統合する。
2. authority の重複を確認する。
   - ブランチ運用、承認要件、版運用を CI 側で再定義していないか確認する。
   - branch category、merge direction、version policy、publish trigger は git-branch-strategy スキルの正本 DSL に従っているか確認する。
   - 選択した CIプリセット、language profile、provider 実装、project-local adapter の責務が追跡できるか確認する。
   - SDD や DSL の存在を CI workflow の前提にしない。別の設計正本との適合を監査する場合は、その owner と対象範囲を明示して別途確認する。
3. CI workflow runtime の依存を確認する。
   - `references/ci-runtime-boundary.reference.md` の禁止事項に反していないか確認する。
   - `a3-lint` / `a3-suite` / その他 `a3-*` コマンドを workflow step や `.ci/scripts/` から呼んでいないか確認する。
4. runner trust policy を確認する。
   - 選択した provider の trust policy profile に従って runner と check 境界、および該当する control が選ばれているか確認する。
   - runner/host の版指定と self-hosted image の identity を選択した provider の version policy profile に照らして確認する。
5. trigger と paths を確認する。
   - 重複実行や高コスト工程の抑止が `references/ci-execution-efficiency-policy.reference.md` の品質不変条件を満たすか確認する。
   - 短命ブランチで不要な統合イベント実行が起きていないか確認する。
   - docs-only や対象範囲のスキップが、workflow 起動条件と実行後判定のどちらで扱われているか確認する。
   - scope 判定前に依存準備が必要な場合は、dependency lifecycle を抑止し、通常の依存インストールは scope 判定後に置く。
6. 無料枠消費を確認する。
   - ジョブ分割、並列化、マトリクスが合計実行分数の削減に基づいているか確認する。
   - キャッシュはヒット率と削減効果が見込める場合だけ採用されているか確認する。
   - publish workflow がある場合だけ、非キャンセルと直列化を混同せず、同じrepositoryまたはtargetへのpublishが実行効率policyに従い、provider queue上限内の実行中・待機中runを置換せず順番に実行されるか確認する。
7. workflow 実装の肥大化を確認する。
   - workflow file 名、workflow `name:`、job id / job `name:` が選択した provider の authoring policy profile に従っているか確認する。
   - workflow がオーケストレーションに限定されているか確認する。
   - 長い処理や条件分岐が `.ci/scripts/` または provider の再利用単位に外部化されているか確認する。
   - 各共通処理を script のファイル名ではなく `ci.script-use-cases` の処理単位へ分解し、選択した provider 固有スキルが所有する再利用単位の選択順位と移行候補を上位候補から照合する。provider の再利用単位、reusable asset、script、project-local adapter のいずれを選ぶかだけでなく、契約適合性、実行境界、固定参照、入出力、workflow mapping を候補ごとに判定する。
   - project-owned 実装は「許可されている」だけでは採用根拠にならない。契約適合する上位候補がないこと、および選択済み binding が充足しない登録済み extension であることを確認し、候補、非採用理由、owner、証拠 identity を監査結果へ記録する。適合候補がある処理や未登録の代替分岐を独自実装した場合は、不要な独自実装という対象契約違反として `statusClassification` へ渡す。
   - provider workflow の全外部再利用単位を、選択した provider registry の固定参照設定と双方向に照合し、未登録単位、preset 宣言漏れ、余剰宣言を残さない。具体的な構文と SHA の検査方法は provider 固有スキルへ委譲する。
   - 外部化先は選択した provider の authoring policy profile に沿っているか確認する。
   - provider の再利用単位、runtime、toolchain、container、外部ツールに mutable な version selector や未解決 placeholder が残っていないか version policy profile に照らして確認する。
   - workflow の静的検証は選択した provider の authoring policy profile に従って確認する。
8. スクリプトと成果物を確認する。
   - script の実行前提は `references/ci-script-catalog.reference.md` の実行モードに従っているか確認する。
   - 配布スクリプトの用途は `references/ci-script-catalog.reference.md` と一致しているか確認する。
   - 日時・timezone 系テストが UTC runner と local timezone の差で変わらないか確認し、詳細なテスト原則は test スキルへ戻す。
   - ログ、レポート、アーティファクトが追跡対象と混在していないか確認する。
   - 各ジョブが `単位`・`実施`・`結果` の3列によるジョブサマリを必ず出力し、失敗・判定不能・未実施でも理由を追跡できるか確認する。失敗時も出力される終了処理があり、skip/cancelされたジョブは workflow runtime の実施状態として理由付きで記録する。条件または owner 契約により実行しないジョブは `対象外` として理由付きで記録し、実行すべきジョブの skip/cancel（`未実施`）と区別する。監査フェーズの status は、runtime の結果と証拠を `ci-audit-contract.reference.yml` の `statusClassification` へ渡して導出し、本ガイドでは分類条件を補完しない。
   - テストサマリも同じ3列形式で出力し、`結果` がジョブstatusの転記ではなく、実施した処理のoutcomeとevidenceから導出されているか確認する。
9. artifact公開がある場合だけ確認する。
   - 公開要否、公開経路、publish範囲、registry、version、channel、credential route が対象プロジェクトの owner 契約で解決され、CIで再選択されていないか確認する。
   - 共通検証で確定した `installer-distribution` の結果を再利用し、この手順から installer スキルへ再委譲しない。適用対象の場合は同 subject の `publicationPathCheck` を適用する。
   - package publication 経路の実装順は `references/implement-package-publish-workflow.guide.md` に照らして追跡する。
   - 実行可能資材の Release assets 経路の実装順は選択した provider 固有スキルの Release assets workflow guide に照らして追跡する。
   - Release inventory、resource identity、成功状態は`references/release-asset-publication-contract.reference.yml`の機械可読契約と一致するか確認する。
   - Release assets経路では、操作対象sourceを実行するbuild / validate jobに公開先への書込権限がなく、公開作成jobがrelease authority contextと操作対象source由来のhandoffを別入力として扱うか確認する。具体的な権限キーは選択したprovider profileで確認する。
   - Release作成の直前にtagのcommitと検証済みsource SHAを再結合しているか確認する。
   - タグ注釈とRelease本文を別々の入力として追跡し、許否・一致条件と禁止されるCLI経路は`git.release-flow`および`references/release-asset-publication-contract.reference.yml`を参照して確認する。承認済み本文がauthorityからhandoffされ、公開作成jobの明示入力・CLI引数・保存後本文で同一内容として確認できることを証跡化する。provider固有のRelease APIと権限キーは選択したprovider profileへ委譲する。
   - Release公開adapterのCLI境界が、引数個数と各引数の境界、query / projection、全ページ取得、終了状態、標準出力・標準エラー、出力cardinalityを一体で検証しているか、`references/ci-script-catalog.reference.md`と照合する。
   - package publication の解決済み公開入力、authority evidence、安全不変条件を `references/implement-package-publish-workflow.guide.md` に照らして確認する。
   - Release assets publication の解決済み公開入力、authority evidence、安全不変条件を選択した provider 固有スキルの Release assets workflow guide に照らして確認する。
   - request、trusted CI control、publish source の境界を選択した provider の trust policy profile に照らして確認する。
   - package registry への書込権限を持つjobが操作対象sourceをcheckoutせず、source dependencyやsource由来scriptを実行せず、無書込権限jobから渡された検証済みhandoffだけを登録するか確認する。具体的な権限キーは選択したprovider profileで確認する。
   - version plan、channel alias、target identity がowner契約で解決され、CIが許可済みplanの具体化を越えてmanifestやartifact種別から生成規則を導出していないか確認する。
   - project-local adapter の build、validate、publish、observe 境界が `references/ci-script-catalog.reference.md` と一致するか確認する。
   - availability観測不能を不存在として扱わず、公開先ownerの非上書き契約に従ってfail closedするか確認する。
   - credential の分類、保存、注入、ログ秘匿を secret-management スキルと対象プロジェクトの契約に照らして確認する。
   - package publication の partial publish を扱う場合は`references/package-publish-recovery-state.reference.yml`のstateとfail-closed委譲境界を確認する。
   - Release assets publication の partial publish を扱う場合は、選択した provider 固有スキルの recovery guide と公開先 owner の契約にある state と fail-closed 委譲境界を確認する。
10. 修正案を整理する。
   - テーマ別確認で対象契約違反、監査不能、証拠不足を観測した場合は、それぞれ共通契約の `statusClassification` へ戻し、意味監査または機械監査のstatusと監査全体を再集約する。findingの存在だけから監査statusを変更せず、共通分類と集約の結果に従う。
   - reviewスキルが、CI監査で得た finding、重大度、保証レベル、合否、推奨修正案、理想の根本解決案、具体的な修正計画、最終判断を保持する。
   - 監査報告の先頭では、事前検証、機械監査、意味監査、監査全体、適合を `ci-summary-format.reference.md` の順序で別行に示す。事前検証の `success` を機械監査、意味監査、監査全体、適合の `success` に読み替えない。
   - 問題点、未確認範囲、推奨修正案、理想案、具体的な修正計画はreview スキルのレポート要件を正本とし、CI固有のフェーズ、証拠provenance、意味候補の判断結果を追加する。
   - `installer-distribution` の修正候補は、同 subject の `remediationPriority` を適用して順位付けする。それ以外の候補は runtime dependency、runner trust、authority 重複、trigger、無料枠、外部化、成果物管理を比較し、package publication の事故リスクがある場合は publish を止める条件を確認する。
   - 候補が複数ある、または SSOT破壊・責務境界逸脱・互換性や安全性への重大な影響など高リスクで除外する候補がある場合だけ、reviewスキルから change-proposal スキルへ候補整理を委譲する。入力には owner、SSOT、対象範囲、非対象、完了条件、CI固有の証跡を固定して渡す。
   - change-proposal の R/X は候補の選択結果として review 報告へ統合する。R/X で CI監査の証跡、finding、理想案、具体的な修正計画、最終判断を置き換えない。単一候補で高リスク除外がない場合は review 内で整理する。

## 注意
- 「動いている」だけでは合格にしない。再実行、権限、信頼境界、部分 publish の事故を確認する。
- レビュー結果では、本スキルで直すべき問題、git-branch-strategy スキルの正本 DSL に戻すべき問題、git スキル側の authority に戻すべき問題を分ける。
- 証跡付き監査では、対象workflow、適用したowner契約、trigger、permissions、runner、実行するsource、外部副作用の実証可能な証跡だけを記録する。保証レベル、重大度、合否、報告形式はreviewスキルに従う。
- workflow YAML の静的検証は、設計判断や runner trust policy の代替にしない。
