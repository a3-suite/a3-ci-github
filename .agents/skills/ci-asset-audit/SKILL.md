---
name: ci-asset-audit
description: a3-ci-github のworkflow・Action・runtime・installer・公開Skill・保守検証資材を棚卸し、consumerとproviderの責務、配布・実行経路、固定参照先の契約適合、構造・ルールの妥当性、対称性、不要なコピー・個別実装・複雑度、共通化・配置変更・Release公開後の取り残しを監査するときに使う。
---

# ci-asset-audit / SKILL

<!-- skill-template: single-purpose -->

## 目的

a3-ci-githubの資材分担を現在の正本と実体から確認し、必要な差と責務・配置・実行のずれを区別する。共通化の量ではなく、consumerの保守負担とproviderの責務が目的に合うかを評価する。

## 原則

- 適用先プロジェクトに不要な資材をコピーさせず、Git管理・GitHub repositoryでの維持対象にしない。標準構成で必要なプロジェクト固有の設定・判断・実装と、それを接続する資材だけが残るかを確認する。
- CI実行中にダウンロードする資材は、プロジェクトがコピーしてGit管理する資材とは別に評価する。CIで取得すること自体をプロジェクト側のコピー負担と数えず、実行に必要な取得範囲・固定参照・検証・依存を確認する。導入・保守時だけのローカル取得も実行時取得と区別する。
- 適用先プロジェクトに不要な個別実装をさせない。共通処理はproviderのAction・reusable workflow等で提供できるかを確認し、プロジェクト固有の判断・設定・実装が必要な部分に限ってconsumerの責務として残す。

## 責務境界

資材の棚卸し、経路の照合、監査結果の報告を担う。監査から修正へ自動移行しない。監査手法は `architecture-audit`、証拠の扱いは `evidence-reading`、保証レベル・指摘採否・共通報告要件は `review` を参照し、ここでは再定義しない。

## 正本と確認先

`{project-root}`は監査対象のa3-ci-github repository rootを指す。下表のパスはこの明示した起点から解決する。契約内容・資材数・version・固定SHA・利用可能状態を本スキルへ転記せず、実行時に参照先から得る。

| 確認すること | 入口 |
|---|---|
| repositoryの保守配置・実装方式・検証面 | `{project-root}/DEVELOPMENT.md`、`{project-root}/docs/maintenance/action-construction.md`、`{project-root}/docs/maintenance/test-strategy.md` |
| preset、consumer配置、Action binding、標準実装 | preset registry: `{project-root}/skills/ci-github/references/ci-github-preset-assets.reference.yml` |
| 選択配布の依存閉包、copyとlocal-referenceの区分 | distribution registry: `{project-root}/skills/ci-github/references/ci-distribution-assets.reference.yml` |
| adapterとowner固有実装 | script assets: `{project-root}/skills/ci-github/references/ci-script-assets.reference.yml`、script contracts: `{project-root}/skills/ci-github/references/ci-script-contracts.reference.yml` |
| 配置・論理責務・投影 | physical structure: `{project-root}/sdd/dsl/designs/global/physical-structure.sdd.yml`、logical structure: `{project-root}/sdd/dsl/designs/scopes/repository/logical-structure.sdd.yml`、projection: `{project-root}/sdd/dsl/designs/scopes/repository/projection.sdd.yml` |
| lintと検証ルールの選択 | CI資材の規則は `{project-root}/a3-lint.repository.yaml`、外部Skillの言語・Vitest規則は `{project-root}/a3-lint.yaml`からrule root・適用条件・例外を解決する。対象別profileと実行経路は `{project-root}/docs/maintenance/action-construction.md`を参照し、preflightと契約テストの検査範囲も照合 |
| CLI入力条件 | CLI manifest: `{project-root}/sdd/dsl/specs/cli/cli-command-manifest.sdd.yml`から各commandを解決 |
| 契約と検証証拠 | contract package: `{project-root}/sdd/dsl/specs/contract-core/contract-package.sdd.yml`、契約対象の実行定義: `{project-root}/tests/contract-subject-execution.json` |
| 導入説明と公開・互換性の前提 | preflight guide: `{project-root}/skills/ci-github/references/validate-ci-preset.guide.md`、trust policy: `{project-root}/skills/ci-github/references/runner-trust-policy.reference.md`、version policy: `{project-root}/skills/ci-github/references/workflow-version-policy.reference.md` |
| installerの公開契約とrepository側の保守 | 利用・契約入口: `{project-root}/skills/installer/SKILL.md`から参照先を解決、配置・生成・検証・計測: `{project-root}/docs/maintenance/installer-maintenance.md` |
| Release公開後の利用可能化・Skill配備 | 公開入口: `{project-root}/docs/release/README.md`、実行経路: `{project-root}/.github/workflows/release.yml`、配備入口: `{project-root}/.agents/skills/skills-deploy/SKILL.md`。固定参照と利用可能条件は上記preset registry・version policyから解決 |

実体は上記から到達する `actions/`、`workflows/`、provider reusable workflow、`runtime/`、公開・ローカルSkill、lint、テスト、文書を照合する。registryからの到達だけで棚卸しを終えず、対象ディレクトリの実在資材との逆照合で未登録・互換用・保守用資材も区別する。

公開Skillの知識・契約・例とrepository機能の実装・構築・テストを区別する。installerはrepository機能として保守し、公開Skillの配備をAction／CLI実装の配布と同一視しない。Skill自身の保守資材の配置は `skill-maintenance` を参照するが、repository機能の資材を一律にSkillの `_build/` へ移す理由にしない。公開例をテスト入力として読む参照は実装依存と区別し、内部fixtureへの複製を前提にしない。

## 監査の進め方

1. 対象のrevisionと作業ツリー状態、対象面、保証範囲を固定する。未コミットの実体を確認する場合は、既存変更を含む現在状態の評価と変更差分の評価を分ける。
2. 資材をconsumer所有、provider実行、導入・保守時参照、repository検証・配布、互換性維持に分類する。一つが複数の役割を持つ場合は実行面ごとに分ける。
3. 各資材のowner、正本、配置先、取得方法、Git管理、実行時点、入力・出力、依存、利用可能状態を追跡する。source、生成物、配布物、検証用参照を区別する。
4. 下表で正本→実装→利用側→説明→検証を照合し、実体からも正本へ逆追跡する。コピー削減・追加共通化・対称性・構造・ルール・無駄と複雑度は、監査対象範囲で毎回必ず確認する。
5. ずれの候補について、成立条件と反証を確認する。契約と実装のどちらを変えるべきか決められないものは、削除・共通化の推奨ではなく未決事項として返す。

| 観点 | 確認する問い |
|---|---|
| 構造 | directory・module・Action・workflowの名前と責務が合うか。論理構造と物理配置・import・実行依存が一致するか。循環、逆向き依存、内部実装への直接接続、不要な層・分割がないか |
| ルール | 正本、適用範囲、選択条件、例外、検証ownerが明確か。registry・DSL・preflight・lint・テスト・文書の規則に重複や矛盾、未適用、旧前提がないか。現状の目的に必要な規則か |
| 所有と配置 | consumer固有の公開判断・設定とproviderの共通処理が分かれているか。参照用資材をconsumerが管理する実装に混ぜていないか |
| 取得とcopy | 選択したpresetの依存閉包に必要な資材だけを取得するか。取得とGitへコミットするcopyを混同していないか。任意資材が一律必須になっていないか |
| 実行入口 | CLI、wrapper、callee、Action、内部関数で必須入力・能力・失敗処理が一致するか。標準経路が使わない外部skillやtoolchainを入口が要求していないか |
| 共通化・配置変更後の移行 | 処理をproviderへ移した後も旧helper、コピー前提、配置本数、検証条件、テスト入力が残っていないか。source→build→Action／CLI配布物→registry→実行入口の閉包を追い、古いpathや未生成資材がないか。固定refの実装と作業ツリーの実装を同一視していないか |
| 対称性 | quality／Release／Packageの対応する役割、同等のCLI／Action、標準／拡張の経路で責務と処理の粒度が揃うか。入力・出力、検証、成功・失敗伝播、後処理、配置・依存、文書・テストの片側だけに欠落や旧前提がないか |
| 説明と互換性 | 標準経路、任意拡張、互換性用の用途が利用者向け入口でも分かるか。契約の維持と標準での不使用を区別できるか |
| 検証と公開 | 選択資材・入力省略・拒否条件が、その契約の観測点を通る証拠に接続しているか。補助回帰、テスト収集、静的検査、ローカル受入、公開ref、native OS・Hosted実行を区別できるか |

SDD正本の意味・責務判断が必要な場合は `sdd-framework` を入口にownerを解決する。構造の詳細は `structure-review`、順序・失敗伝播の詳細は `sequence-review` を必要な経路だけに適用する。

## 毎回確認する必須項目

- **コピー削減**: consumerで管理する各資材が固有の設定・判断・実装として必要かを確認する。providerのAction／reusable workflowへの固定参照や導入時だけの参照へ置き換えられる共通処理を探す。削減余地はGit管理するコピー、CI実行時にダウンロードする資材、導入・保守時だけの取得資材を分けて示す。
- **追加共通化**: 未共通化の処理も対象にし、同じ意味・責務の重複を確認する。候補ごとに対象経路、減らせるcopy・個別実装、維持するowner責務、共通化の保守・移行費用を示す。既に共通化済みの資材の確認だけで終えない。
- **対称性**: 比較する資材・経路の対応関係と比較単位を先に決める。同じ役割の処理は責務・粒度・入力出力・検証・失敗伝播・後処理・配置依存・証拠の対応を照合する。request→caller→calleeのように役割が異なる段階は、同じ処理を持つかではなく、責務の受渡しに欠落・重複がないかを確認する。

- **構造**: 正本の論理責務と物理配置・実依存を照合し、名前と責務、公開入口と内部処理、sourceと生成・配布物の対応を確認する。各層・分割・wrapperが独立した責務や境界を提供するかを確認し、ファイル数や層数だけで良否を決めない。
- **ルール**: 適用する規則の正本・owner・対象・選択条件・例外と実際の検査箇所を対応付ける。実装が従うかに加え、規則自体が現在の目的・実行経路・信頼境界に妥当かを確認する。未使用前提の必須化、同じ規則の再定義、矛盾する判定、古い例外、検査対象漏れ・誤適用・実装追認のテストを探す。型検査・lint・生成物同一性・回帰が通常の検証経路から対象へ届くかを確認し、監査時だけの個別実行で検査漏れを補った状態を区別する。言語・runtimeの例外は保守方針の理由と実行前提に照合する。lint成功や既存テスト成功だけを規則の妥当性の根拠にしない。

- **無駄と複雑度**: consumerとproviderの両側で、実際の利用経路に接続しない実装・設定・環境変数・依存、委譲先と重複する準備・検証・後処理、不要なwrapper・分岐・fallbackを確認する。参照箇所だけでなく委譲先と固定refの能力を照合し、必要な互換性経路や信頼境界を区別する。各候補は、削除または単純化しても維持すべき契約・失敗伝播・証拠と、減る保守・設定・取得・実行負担を示す。

- **公開後の利用可能化と配備**: 対象Releaseのtagとpeeled full SHA、公開資材、registryの固定参照・利用可能状態、公開Skillの説明と配備実体を照合する。公開済みなのに旧参照や`pending-release`が残る場合は、各経路のactivation条件と証拠に照らして、意図的な固定・受入待ちと更新漏れを区別する。履歴上のversionや参照を一律に最新版へ変更する判断はしない。Release公開・資材readback・必要なHosted受入・registryの利用可能化・Skill配備を別の達成状態として示し、Release workflowや公開手順から後続更新・検証への導線が欠けていないか確認する。provider自身のCI成功をconsumer接続や各calleeのHosted受入の証拠に代用せず、未達条件があれば自動的に`available`と判断しない。配備比較は明示されたrootと対象Skillの範囲で行い、更新差分・不足・staleを分ける。公開refや配備先が監査範囲外・未指定・未取得なら該当段階を未確認とし、ローカル正本の整合だけで配布・配備まで完了としない。

対称性の差は、契約・owner・権限・公開先・trigger・互換性に基づく必要な差と、説明できない欠落・粒度不一致・移行の取り残しに分ける。対称性を理由に固有責務や信頼境界を消さない。

七項目それぞれについて、確認範囲と根拠を添えた結論を毎回報告する。構造は正本と実体の対応、ルールは参照した正本と実際の適用・検証範囲を示す。削減・共通化の候補がない場合も理由を示す。対称性の問題がない場合は比較した対応関係と必要な差を示す。証拠不足や指定範囲外は未確認として示し、「候補なし」「問題なし」で代用しない。

固定参照を持つ対象経路では、caller→callee→Actionの実際の`uses`を起点に、参照SHA・tag対応・必要な契約・確認したmetadata/dist・検証結果を対応付ける。実行方法と準備段階の扱いは[Action構築方針](../../../docs/maintenance/action-construction.md#固定参照の更新順序)を参照する。sourceの修正済み、固定参照先への反映済み、対象SHAのHosted受入済みを別々に判定し、どれかが未確認なら経路全体を問題なしとしない。registryとworkflowが同じ旧SHAを指す場合も、相互一致だけでは現在契約への適合証拠にしない。pendingは受入待ちの状態であり、Action参照更新の取り残しを調べない理由にはしない。

検証資材の評価では、subject／test-mapの保証とテストが実際に観測する境界を照合する。provider内部の回帰をActionの公開出力保証へ直接算入せず、テストの収集成功を実行・契約達成の証拠にしない。計測は保守方針に従う元ソースの対象・分母・子プロセス経路を確認し、生成済み配布物の動作検証と分ける。言語別の計測値を合算して品質判定せず、未実行OSやskipは未確認として残す。計測設定・手順は本スキルへ複製しない。

## 判断と報告

- 不一致は「現在契約への不適合」「契約自体の見直し候補」「説明の取り残し」「根拠不足」に分ける。配置場所やregistry未登録だけを理由に境界違反と断定しない。
- 対称性は同じ形への統一を意味しない。共通化候補は同じ意味・責務が実際に重複する経路と、減るconsumer負担、増えるprovider保守・移行費用を比較する。薄い配線を移すだけの案や具体的な共通実装例がない汎用化は、便益を確認してから扱う。
- 必要な差、意図的な互換性残置、公開前の資材、外部rootを必要とする拡張経路を、削減候補と混同しない。
- 正本、owner、固定refの実体、利用状況が不足する項目は判定不能として確認先を示す。静的に未使用に見える前提でも、契約上の準備ゲートかを確かめる。

契約違反の有無と無駄・複雑度の評価は分けて報告する。既存検証の成功や修正必須のfindingがないことから「無駄なし」を導かない。複雑さの評価方法は `architecture-audit` に従い、本監査では削除・単純化候補、必要として残す処理とその理由、未確認範囲を示す。

共通のreview報告に、資材区分表（件数とGit管理するcopy／CI実行時取得／導入・保守時参照／provider実行の区分）、正本と実体の経路、ずれの根拠行と影響、必要な非対称性、未確認範囲を添える。個別の取り残しは同一原因でまとめ、網羅範囲と対象外を示す。指摘がなくても確認した資材と証拠を残す。

修正案を求められた場合は、採用する指摘だけを `change-proposal` へ渡す。監査と別の実施工程として扱い、資材移動、新共通部品、汎用APIを前提にしない。issueへの記録を求められた場合は `local-issue` を使う。

## 注意

- consumer repositoryの調査、Hosted実行、公開refの検証は、その範囲を依頼された場合の追加証拠。ローカルの成功から結果を補完しない。
- このローカルSkillはrepository保守用であり、consumerに配布するCI資材や公開Skillの実装ではない。
