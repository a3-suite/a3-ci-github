# CI ワークフロー設計ガイド

## 目的
- 新規 CI または既存 CI の構成見直しで、参照すべき正本と判断順序を固定する。
- workflow runtime の依存、runner、trigger、script 外部化、成果物の扱いを同じ順序で設計する。

## ユースケース、プリセット、language profile の選択

まず `references/ci-workflow-use-cases.reference.yml` で通常経路と例外経路を確認し、次に `references/ci-preset-contracts.reference.yml` の入出力契約を適用する。その workflow が使用する script は `references/ci-script-use-cases.reference.yml` と `references/ci-script-contracts.reference.yml` で対応と契約を確定する。

1. workflow のユースケースと外部副作用を選ぶ。
2. ユースケースに対応する `quality-gate`、`release-request`、`release-publication`、`package-publication` を選ぶ。
3. プリセット契約の必須入力、出力、停止条件を固定する。
4. script ユースケースと処理契約を確認し、script 契約の必須入力、出力、停止条件を固定する。
5. 変更検証では `change`、`integration`、`scheduled` の execution mode を選ぶ。
6. language profile を選び、`references/ci-adapter-bundles.reference.yml` で標準 bundle の有無を確認する。
7. 標準 bundle がない profile は project-owned adapter の候補を調べ、profile が提供する検証、build、package、version、artifact の契約を確認する。
8. `references/configure-ci-preset.guide.md`に従い、選択した標準構成をworkflowへ接続する。

CIプリセットの内部段階（`references/ci-preset-contracts.reference.yml` と `references/ci-workflow-use-cases.reference.yml` が定義する）を独立した workflow として選択せず、CIプリセットの一連の経路として扱う。新規用途は `ci-workflow-use-cases.reference.yml` の selectionRules で既存の CIプリセット、adapter、owner-defined workflow を分類する。未設定の CIプリセット、language profile、adapter は既定値で補完しない。

## フロー
1. 運用契約の authority を確認する。
   - branch category、merge direction、version policy、publish trigger は git-branch-strategy スキルの正本 DSL に従う。
   - ブランチ操作と承認要件は git スキル側の正本に従う。
   - 本スキル側で branch category、merge direction、version policy、publish trigger を再定義しない。
2. language profile と実行 adapter を解決する。
   - adapterを決める前に`references/distribute-ci-assets.guide.md`の「対応条件」に従い、公開済み安定版と導入済みrevisionを比較する。最新の標準preset・Action・bundleで製品要件を満たせるかを先に確認し、満たせる場合は標準構成を優先する。最新資材を確認できない場合は未確認とし、既存の固有実装を標準として追認しない。
   - 既存の固有workflow・script・adapterがある場合は`references/configure-ci-preset.guide.md`の「標準構成からのセットアップ」に従い、標準との差分と必要性を確認し、利用者と採用方針を決める。固有adapterは標準で満たせない製品要件が確認された場合だけ選択する。採否が未確定の間は既存実装を変更しない。
   - profile の format、lint、test、build、package、version、artifact の契約を確認する。
   - project SSOT または対象 project の owner 契約で installer asset が採用済みの場合は、adapter を決める前に installer スキルへ委譲し、asset、manifest、builder、組立後検証と証跡の契約を解決する。未解決なら installer asset の adapter と公開経路を確定しない。
   - 標準構成で満たせない製品要件のためにproject-local adapterが必要な場合だけ、その入力・出力・失敗条件を固定する。標準Action・bundleで成立する処理には固有adapterを追加しない。
   - script ユースケースと処理契約は `references/ci-script-use-cases.reference.yml` と `references/ci-script-contracts.reference.yml` に従い、具体的な実行前提は `references/ci-script-catalog.reference.md` で確認する。
3. CI workflow runtime の境界を確認する。
   - `references/ci-runtime-boundary.reference.md` に従い、CI runtime に a3 系 CLI を混入させない。
4. runner trust policy を決める。
   - 選択した provider の trust policy profile に従い、runner と check 境界、および該当する control を決める。
   - provider profile の check 選択に従い、配置する merge gate check、安定した required check 名、対象外 job の skip 条件を先に決める。
   - runner/host の versioned label または immutable image の指定は、選択した provider の version policy に従う。
5. trigger と paths を決める。
   - 不要実行の抑止と品質不変条件は `references/ci-execution-efficiency-policy.reference.md` に従う。
   - PR 時の品質ゲートと、マージ後の統合後検証を分離する。
   - provider の統合イベントは長期運用・保護対象 branch の変更に限定する。
   - merge queue 相当のイベントは merge queue を運用している場合だけ追加する。
   - 手動実行イベントは手動実行が必要な場合だけ追加する。
   - provider の path filter は workflow 自体の起動有無を制御する。
   - 差分検出スクリプトは workflow 実行後に重い工程をスキップする。
   - required check の起動条件、対象外処理、merge queue 対応は選択した provider の trust policy profile に従う。
6. provider 実装へ写像する。
   - `references/configure-ci-preset.guide.md`に従い、選択したCIプリセットとlanguage profileをcallerへ接続する。入出力と停止条件は`references/ci-preset-contracts.reference.yml`、Actionと資材の対応は`references/ci-github-preset-assets.reference.yml`を参照する。
   - provider 固有の構文や API を `ci` の概念契約へ逆流させない。
   - provider の runtime、toolchain、runner、Action、container の版指定は選択した provider の version policy profile を参照する。
7. workflow の実装境界を決める。
   - workflow はオーケストレーションに限定する。
   - workflow file 名、workflow `name:`、job id / job `name:` は選択した provider の authoring policy profile に従う。
   - 長い処理、条件分岐、再利用処理は `.ci/scripts/` または Action に外部化する。
   - 外部化判断は選択した provider の authoring policy profile に従う。
   - 選択した provider の CIプリセット asset から、必要な workflow 骨格を選ぶ。
   - workflow asset の branch、runner、required check、docs-only pattern、パッケージマネージャの実行方法、Action SHA、runtime version は、provider と project の正本に合わせて確定する。
   - workflow の静的検証は選択した provider の authoring policy profile に従う。
8. スクリプトと成果物の扱いを決める。
   - 配布スクリプトの一覧は `references/ci-script-catalog.reference.md` を参照する。
   - 実行環境とツールのバージョンを、選択した provider の version policy に従って workflow に明示する。
   - 日時・timezone 系テストは test スキルの原則に従い、runner の暗黙 timezone に依存しないことを確認する。
   - 依存ロックの有無を前提に、インストール手順を固定する。
   - 実行するスクリプト名は定義と一致させ、存在確認のチェックを入れる。
   - ログやレポートは追跡対象と混在させない。
   - 失敗時に必要なログだけをアーティファクト化し、保持期限を短くする。
   - `continue-on-error` を使う場合は最終集計ステップで必ず失敗させる。
9. artifactの公開が必要か判断する。
   - artifactの公開が不要な場合は公開経路の確認を省略し、手順10へ進む。
   - 公開要否、公開経路、publish範囲は対象プロジェクトの owner 契約で解決する。CIでは再判断しない。
   - 解決済み経路がpackageの場合は`references/implement-package-publish-workflow.guide.md`、Release assetsの場合は選択した provider 固有スキルの Release assets workflow guide に進む。
   - 不要な経路のpublish権限やtokenをworkflowに入れない。
10. 最後にレビューする。
   - `references/review-ci-workflow.guide.md` の順序で確認する。
   - 合否判定や証跡付き監査も`references/review-ci-workflow.guide.md`でCI固有の証跡を確認し、保証レベルと報告形式はreviewスキルに従う。

## プラットフォーム別品質検証

platform 固有の runtime、artifact、installer、OS 依存処理の検証が必要な場合だけ適用する。provider の構文、runner、matrix、required check 名は provider 固有スキルへ委譲する。

1. 必要性を決める。platform 独立性が確認できる検証は単一 platform に集約し、platform 固有の挙動を検証する suite だけを platform 別の対象にする。
2. 対象 platform を選ぶ。project が宣言した platform 集合の id を参照し、platform 定義や runner mapping を重複定義しない。選択と適用条件は project data とし、workflow 構造へ埋め込まない。
3. 検証対象と適用条件を決める。platform ごとに、実行対象、適用条件、対象外の理由コードを実行前に確定する。実行対象が空の platform を作らない。
4. 結果と証跡を固定する。platform id、execution-context、adapter、解決済み設定 digest を結合し、status は preset 契約の共通語彙を使う。
5. 集約と required check を固定する。provider は固定名の集約結果を用意し、期待 record の欠落、空選択、未実施、判定不能、runner 異常、workflow 未起動を成功に読み替えない。required check の起動条件は変更対象の変更検証と同じ経路に含める。
6. provider が標準実装を提供しない場合は owner-defined workflow とし、同じ契約、期待 record、停止条件を適用して差分を記録する。

## 注意
- CI を速く見せるためだけにジョブを分割しない。合計実行分数の削減を優先する。
- runner 選定理由は、選択した provider の trust policy の判断軸で残す。
- Action、runner/host、runtime、toolchain、container、外部ツールの版指定は、選択した provider の version policy の不変条件で確認する。
- workflow asset はそのまま正本にせず、プロジェクトの runner、権限、trigger、script に合わせて設定する。
- workflow YAML の静的検証は、runner trust policy や workflow 設計判断の代替にしない。

## チェックリスト
- [ ] 無料枠消費（合計実行分数・実行回数）を runner trust policy と矛盾しない範囲で評価した
- [ ] ジョブ分割、並列化、マトリクスは合計実行分数の削減に基づいている
- [ ] runner trust policy の適用条件に従って runner と check 境界、および該当する control を選定した
- [ ] 配置した merge gate check が runner trust policy の PR check 選択と merge queue 条件に整合している
- [ ] 日時・timezone 系テストが runner の暗黙 timezone に依存していない
- [ ] platform 別検証の必要性と、単一 platform に集約できる検証を区別した
- [ ] platform 選択は宣言済み platform 集合の id 参照であり、runner 定義を重複していない
- [ ] 実行前に platform ごとの期待 record と対象外理由コードを確定した
- [ ] 集約結果は固定名で、欠落・空選択・未実施・runner 異常・workflow 未起動を成功にしない
- [ ] platform 非対応コマンドの省略を adapter / owner 契約へ委譲した
- [ ] workflow file 名、workflow name、job name が workflow naming policy に整合している
- [ ] workflow はオーケストレーションに限定し、実装ロジックを外部化した
- [ ] 実ファイル化した workflow YAML を workflow authoring policy に従って検証した
- [ ] ログ、レポート、アーティファクトを追跡対象と混在させていない
