# CIセットアップガイド

## 目的

選択したCIプリセットのcallerを製品設定付きで生成・配置し、project固有の実装だけを接続する。
プリセットの意味、コピー元、コピー先は `ci-github-preset-assets.reference.yml`、共通処理契約は
`ci-script-contracts.reference.yml` を正本とする。

## 導入前提

使用するprovider Releaseは、[選択配布ガイドの対応条件](distribute-ci-assets.guide.md#対応条件)を満たすことを先に確認する。Releaseの選定・比較、必要機能の確認、取得・生成・適用の手順は同ガイドへ委譲する。

## 標準構成からのセットアップ

用途と言語profileに対応する標準preset・Action・標準bundleを最初の導入案とする。製品固有の設定値やregistryが要求する`requiredExtensions`は、共通処理の固有再実装と区別する。

既存の固有workflow・script・adapterがある場合は、変更前に標準構成との差分を整理し、利用者と次を確認する。

- 固有実装が満たしている必須要件は何か。その要件は現在も必要か。
- 標準の設定値・登録済み拡張・owner adapterで同じ要件を満たせるか。満たせない場合は、どの契約・機能・前提が不足するか。
- A: 標準構成へ移行する（要件を満たせる場合の推奨）、B: 必要性を確認した最小限の固有実装を残す、のどちらを採用するか。

既存実装があることだけで維持を決めない。採用方針が確定するまではその実装を変更せず、独立して進められる標準構成の調査・差分plan作成を進める。採用する固有差分の理由とownerは、後述の`.ci/README.md`から正本へ追跡できるようにする。固有実装がない場合は、この対話を追加せず通常の導入手順へ進む。

## 設定場所

コピー先に配布元スキルの配置ディレクトリは存在しない。導入後の設定は次の場所だけに置く。

| 種類 | 設定場所 | 内容 |
| --- | --- | --- |
| workflow 構成 | `.github/workflows/` | trigger、runner、固定 Action／Reusable Workflow SHA、固有入力 |
| 非秘匿の環境・運用値 | GitHub Variables（下記の必要性判定で必須または条件付きとなる場合だけ） | environment選択、運用ポリシー |
| toolchain・tool version | projectのversion設定またはworkflow初期パラメータ | 言語runtime、uv、cargo-audit、gh、jq、sha256sum |
| 秘匿値 | GitHub Secrets | registry token など |
| 実行ごとの入力 | `workflow_dispatch.inputs` | 例外的な request または手動 publication request の非秘匿入力 |
| quality adapter | workflowの標準bundle ID、または独自 `.ci/adapters/*.yml` | 選択とproject固有設定。標準commandは固定Actionが供給 |
| project policy | `.ci/platform-manifest.yml`、`.ci/package-policy.yml` など | platform、artifact、公開先 |
| project 実装 | `.ci/scripts/`、`.ci/trusted/` | registry の `requiredExtensions` |
| 配布同一性 | `.ci/ci-assets.lock.json` | 配布元 full commit SHA、canonical／配置済み SHA-256、分単位の生成日時 |

### project asset の推奨構成

`.ci/` のファイル数は揃えず、実行経路と責務を揃える。

- `.ci/adapters/` は独自descriptorだけを置く。標準Action bundleは配置しない。
- Release／Package の authority、build、assemble、publish は、適用可能な provider registry の固定 SHA Action binding を第一候補とする。project-owned の `.ci/scripts/`／`.ci/trusted/` entrypoint は、選択済み binding が充足しない登録済み `requiredExtensions` に対応する場合だけ接続し、未選択の代替分岐として保持しない。
- workflow から到達しない stage 別 descriptor、汎用 runner、選択結果だけを記録する manifest は追加しない。`.ci/ci-assets.lock.json` は設定や選択結果ではなく、配布同一性の検証入力だけを保持する。
- platform ごとの packaging や検証を分割する必要がある場合は、project 実装として分割を維持し、`.ci/README.md` に理由と owner を記録する。

同じ値を別の manifest に複製しない。環境・運用ポリシーは必要な場合だけ GitHub Variables を使い、
実行ごとに確定する値は workflow input を使う。toolchain と tool version は project のversion設定、
またはplanの`--set`で渡すworkflow初期パラメータへ固定する。job の環境変数は値の受け渡しであり、
版の正本にはしない。
privileged reusable workflow は `runner-trust-policy.reference.md#privileged-workflow-の-trusted-ci-control` の
workflow identity 契約に従う。
具体的なキー、既定値、接続先は、コピーした workflow の初期パラメータ、`vars`、`secrets`、`inputs` を正本とする。

### Variables の必要性を実行経路ごとに判定する

GitHub Variables は、配置した workflow へ一括設定しない。選択した trigger variant と到達する分岐を
確認し、次の区分で必要性を判定する。

| 区分 | 設定する条件 | 例 |
| --- | --- | --- |
| 必須 | 選択した workflow の実行経路で無条件に参照され、workflow input、固定値、Secret で代替できない | 現行 canonical workflow では該当なし |
| 条件付き | 特定の trigger、notes mode、または分岐でだけ参照される | 現行標準 flow では該当なし（notes handoff は publication request が生成） |
| 不要 | 固定値、workflow input、Secret、project asset から供給される、または選択した経路で参照されない | toolchain／tool version、`CI_LANGUAGE_PROFILE`、Release 単位の承認値、未選択 variant 専用の Variable |

`CI_RELEASE_APPROVAL_ID` と `CI_RELEASE_APPROVAL_BODY_SHA256` は Repository Variable にしない。
git スキルの release flow で release identity と本文をタグ作成前に承認する。tag request 成功後、認証済みの
dispatcher が publication authorization の一意な approval ID、承認済み本文の digest、将来の期限を
Release 単位の workflow input として発行し、同じ本文とともに渡す。publication request は入力の整合と
GitHub workflow run provenance を検証可能な handoff へ固定する。approval ID は相関識別子であり、
それ自体を人間承認の証明にしない。後段は
検証済み handoff の approval identity と本文 digest を引き継ぎ、現在の Repository Variable を再参照しない。
CI が検証するのは承認済み入力の同一性と搬送経路であり、人間による事前承認の有無を機械的に代替証明しない。

判定は次の順で行う。

1. 配置した workflow の trigger variant と `if`／`needs` の到達経路を列挙する。
2. 各経路で `vars.` の参照箇所と、空値を許容する条件を確認する。
3. 必須経路でのみ参照される Variable を設定し、条件付きの Variable は該当機能を採用する場合だけ設定する。
4. 不要な Variable を作成せず、未設定を理由に未使用経路を失敗扱いしない。

`CI_TOOLCHAIN_VERSION`、`CI_GH_VERSION`、`CI_JQ_VERSION`、`CI_SHA256SUM_VERSION` などの版情報は
workflow 初期パラメータまたは project の version 設定で固定し、Variable へ移さない。README に記録する場合も、
値の複製ではなく、採用した経路・必要性の理由・owner・正本への導線だけを残す。
jqを使用する経路では `CI_JQ_VERSION` に公式 Release の取得物と checksum がある exact 版を指定する。canonical workflow が
固定 SHA の provider Action で jq を供給してから verifier で検証するため、project 固有の install 処理は不要である。
`CI_GH_VERSION` も公式 Release に取得物と checksum がある exact 版を指定する。canonical workflow が jq の直後に
固定 SHA の provider Action で gh を供給してから verifier で検証するため、project 固有の install 処理は不要である。
`CI_SHA256SUM_VERSION` は release-publication の verifier が参照する。versioned runner label が
提供する coreutils の版に一致させ、runner image の更新で版が変わった場合は project の CI owner が値を更新して
verifier 実行で再検証する。package-publication は `gh-jq` のため対象外である。

### `.ci/README.md` の責務

`.ci/README.md` は、すべての適用済み project に必須で置く。設定の正本にはせず、
project 固有差分がある場合は、標準の preset / flow をそのまま採用できない理由と正本への導線を記録する。
理由は、標準のどの契約・機能・前提が project の要件を満たせないのかが読み取れる粒度で書く。差分がない場合も、
採用した preset / flow と「project 固有差分なし」を明記する。影響する preset または flow と、
workflow の実値、adapter descriptor、project policy、`requiredExtension` のうち該当する正本を示す。
owner、検証手順、撤去条件も記録する。

記載項目は、固定項目、オプション項目、自由記述に分類する。標準からずれない project は固定項目だけで完了とし、
標準の説明を補足文として繰り返さない。空の項目や未記入のテンプレートを完了扱いにしない。

- 固定項目（必須）: 目的と対象、採用 preset / flow、project 固有差分の有無、標準で成立しない理由（差分がない場合は「なし」）、owner、正本・検証導線、検証証跡、更新・撤去条件。
- オプション項目（該当時のみ）: 例外経路、配置資産の責務、追加の検証証跡。該当しない項目の見出しは置かない。
- 自由記述（標準からの差異がある場合のみ）: 追加条件、handoff 先など。正本の decision、停止条件、共有契約、実値、command、workflow 構造を再定義しない。

root `README.md` に platform、artifact、Release flow などの利用者向け事実を記載する場合は、project policy / manifest と照合する。
root README は利用者向けの入口であり、CI契約の正本にはしない。値が正本と異なる場合はREADMEの補足で済ませず、正本との不一致として扱う。

```markdown
# CI configuration

## 固定項目（必須）

### 目的と対象

### 採用 preset / flow

### project 固有差分
- 差分種別: なし / placeholder / trigger extension / policy data / requiredExtension / adapter
- 標準で成立しない理由:
- owner:
- 正本・検証導線:
- 検証証跡:
- 更新・撤去条件:

## オプション項目（該当時のみ）

### 例外経路
- 正本の exception ID:
- 適用する preset / flow:
- project 側の追加条件または差分:
- owner / handoff 先:
- 検証・証跡へのリンク:

trusted CI assets の初期解決は provider profile の canonical state であり、本節の例外経路には記録しない。

### 配置資産の責務

## 自由記述（標準からの差異がある場合のみ）

- 追加条件、handoff 先など:
```

差分種別が「なし」以外のときは、「標準で成立しない理由」へ標準では満たせない要件と標準側の制約を書く。
差分がない場合は「なし」と記入し、標準の説明を繰り返さない。

`例外経路` は `ci-workflow-use-cases.reference.yml` の `exceptions` にある exception ID を記録する。
例外の decision、停止条件、共有契約は正本を参照し、README へ複製しない。trigger extension、
`requiredExtensions`、owner adapter など既存の拡張も、同じ差分記録から正本へ追跡できるようにする。

実値、command、workflow 構造、停止条件、共有契約を `.ci/README.md` へ複製しない。
また、差分の記録は canonical workflow の変更を許可しない。placeholder または登録済み trigger extension
で表せない変更は、canonical asset または registry の契約として扱う。
監査では `.ci/README.md` と参照先の正本を照合する。正本が契約に適合している場合は、
`.ci/README.md` の理由と導線を正本へ追随させる。正本に契約違反がある場合だけ、owner の責務で正本を修正する。

## privileged workflow identity

privileged reusable workflow は entry job の最初の step で default branch の workflow_run caller を検証する。
trusted control は consumer の `github.repository` と `github.workflow_sha` で checkout し、直後に HEAD を照合する。
provider callee の固定参照 SHA と consumer の SHA が一致することは要求しない。
このため導入者が trusted control SHA を事前計算する二段階 bootstrap は不要である。

導入時は caller、固定参照する provider workflow、必要な consumer control asset を単一の検証対象として確認する。main へ反映する前に
git-branch-strategy の `mainIntegrationSafety` に従い、newly reachable commit 全件と最終 tree が releaseable であることを
確認する。GitHub が検証時と異なる commit または tree を生成する merge 方法は使用せず、main が進んだ場合は再検証する。

canonical publication は consumer の default branch caller を検証するため、feature branch では canonical publication 全体の hosted 証拠にならない。
main 反映前の hosted 証拠を必須にする場合は、同じ tree と SHA を default branch に置く隔離 staging repository で確認する。
それ以外は feature branch の静的検証・契約テストと、default branch でのみ取得できる runtime 証拠を区別し、未取得の証拠を成功扱いしない。
この制約を避けるために publication の workflow identity 検証を弱めない。

この方式は workflow identity context を提供する GitHub.com 用である。GHES では同等の契約を確認できない限り導入しない。
PR check の trusted CI assets bootstrap は別の入力境界であり、従来どおり runner trust policy に従う。

## 導入時に使うパス

以下の例では、パスを次の意味で使う。

| 表記 | 意味 |
| --- | --- |
| `{ci-github-source-root}` | `distribute-ci-assets.guide.md`により取得・検証した、選択presetの`workflows/`、`runtime/`、`lint-rules/`、registryを含むproject-local distribution root |
| `{skill-collection-root}` | adapter bundle の `source.skill` を解決できる外部スキル集合 root |
| `{ci-github-skill-root}` | `project-skill-deploy`で別途配備した、導線と参照文書だけを持つ`ci-github` Agent Skill root |
| `{project-root}` | CI を導入する project の root |

`{skill-collection-root}` は、選択した言語スキルを identity で解決する場合だけ使用する。
repository-owned の workflow、runtime、lint rule は検証済み`{ci-github-source-root}`から解決し、
`{ci-github-skill-root}` 配下へ複製しない。取得とworkflow copyは
`distribute-ci-assets.guide.md`のfetch後に本節のruntimeを準備し、設定を渡してplan／applyを行う。コピー先の`{project-root}`は両方と別であり、
導入後の workflow や adapter から配布元を参照しない。

## プリセット別の値

| プリセット | 配置する workflow | project が設定する値 | project が実装するもの |
| --- | --- | --- | --- |
| `quality-gate` | `quality-gate.yml`（platform 別検証は任意の `quality-gate-platforms.yml`） | language profile、toolchain、runner、標準bundle IDまたは独自descriptor名、platform 選択を使う場合は `.ci/platform-manifest.yml` と `.ci/quality-platforms.yml` | 標準 bundle がない場合の quality adapter |
| `release-request` | tag request | tag pattern、runner | なし |
| `release-publication` | request、caller の2 workflow | request handoff、notes handoff、tool versions、`.ci/platform-manifest.yml`、release implementation、quality adapter、言語・製品設定 | 標準Release処理の個別実装は不要。補助assetで owner-adapter を選ぶ場合だけ補助extension |
| `package-publication` | request、caller の2 workflow | runner、tool versions、registry secret、package policy | build と publish extension |

標準導入では、一つの repository に同じプリセットの canonical workflow を一組だけ置く。
Release は `tag-preparation + manual-publication` を一つの標準 flow とし、tag request の完了から publish job へ自動連鎖させない。
複数 platform、artifact、package target は workflow の複製ではなく matrix、policy、handoff の集合で表す。

## 導入手順

1. `ci-github` スキルで用途に対応する標準プリセットを選ぶ。既存の固有実装がある場合は「標準構成からのセットアップ」に従い、必要性と採用方針を利用者と確認する。installerの採否をproject SSOTで確認する。未確定の場合はrepository-auditへ導入判断を委譲し、採否を利用者と確認する。配布する場合は、installerスキルの「インストーラをセットアップしたい、またはCIセットアップから委譲された」からセットアップガイドの実施へ委譲し、実装選択・契約ID・製品宣言pathをplan前に確定する。
2. `distribute-ci-assets.guide.md`に従い、exact Release manifestから選択presetの必須閉包をfetchする。本ガイドの導入時runtimeを準備し、製品設定を`--set`で渡してplanを生成する。差分の明示承認後に設定済みcanonical callerを配置する。
3. apply結果をregistryの選択preset、copyable asset、固定 SHA Action bindingと依存閉包へ照合し、残る `requiredExtensions` を確認する。callerとpin companionの配置は手順2の承認済みapplyだけで行い、固定本数や platform 数から必要ファイルを推測しない。
4. 生成済みcallerの標準bundle IDまたは独自descriptor、Releaseとpackageの選択したAction bindingを確認し、残る `requiredExtensions` をproject側に用意する。依存閉包に属する copyable asset は改変しない。installerは手順1で確定した構成の接続を確認し、その後の組立・検証・製品READMEへのインストール手順追記をinstallerスキルへ委譲する。セットアップガイドの完了条件に対する実施結果と未確認事項を受け取り、委譲の記載だけで完了扱いにしない。
5. 配置されたregistryの`workflowAssets`を読み返し、planで承認したdestinationと一致することを確認する。
6. 生成済みcallerの設定と固定参照を読み返す。calleeのSHAはmanifestの固定参照から、外部Action pinはregistryから自動設定される。consumerが外部provider Actionを直接使う場合だけ、provider CLIのplanがregistryの完全な射影であるpin companionを生成し、consumerの承認後にapplyが配置する。companionもcallerと同じ所有権確認・rollbackの対象とし、独自編集しない。job・step・permissions・trust境界・summary経路は直接変更しない。
7. workflow初期パラメータは手順2の`--set`で確定した生成結果を確認し、必要なVariables、Secrets、実行ごとのworkflow inputを上表の場所に設定する。quality-gate は base の `.ci/ci-assets.lock.json` を採用済み marker とし、workflow 側の flag 設定はない。
8. 上記テンプレートに基づき `.ci/README.md` を作成または更新し、採用 preset / flow、差分または差分なし、差分がある場合は標準で成立しない理由、owner、正本への導線、検証導線、更新・撤去条件を記録する。
9. 配布元 revision の full commit SHA を確認し、`{ci-github-source-root}/runtime/preset/generate-ci-asset-lock.ts` で `.ci/ci-assets.lock.json` を生成する。生成日時はUTCの分単位に正規化され、版識別には使わない。
10. CI向けa3-lintルールとactionlintで単一workflowの一般規則を検証する。actionlint 設定は `.github/actionlint.yaml`（project-owned、内容非固定）を registry の `provider.staticValidation` に従って扱う。
11. `references/validate-ci-preset.guide.md` に従い、canonical workflowとの構造照合と配布同一性を含むpreflightを実行する。
12. 選択した経路で必要な project-owned adapter と project の契約テストを作業 tree で先に成立させる。導入先では手順2で取得・検証した exact Release の full commit SHA を固定し、lock、preflight、契約テストを確認する。calleeの固定参照は検証済みmanifestから解決する。生成・配置の成功だけで導入先の環境受入を完了扱いにしない。hosted 証拠は前述の default branch 制約に従い、既存の非公開・非書込み検証経路または隔離 staging repository で取得できる範囲だけを記録する。

既存ファイルを暗黙に上書きしない。差分を提示して owner が採用範囲を決めた後に配置し、
配置後はコピー先を設定の正本として読み返し、preflight時だけregistryのsourceと照合する。

## `quality-gate` の最短導入例

次は、標準 adapter bundle がある Rust、Python、TypeScript に共通する手順である。
既存の配置先ファイルがある場合は先に差分を確認し、`cp` で上書きしない。

主qualityの `jobs.quality.with.jq-version` は、adapterやproject scriptsがjqを使う場合だけexact版を指定し、使わない場合は空文字にする。providerは空値ならjq取得・検証を省略する。必要性はproject ownerが判断し、標準bundle名から自動判定しない。

主workflowは薄いcallerを配置する。固有値はplanの`--set`で渡し、生成された`jobs.quality.with`を確認する。共通jobはproviderの `.github/workflows/ci-quality.yml` が実行する。calleeはconsumerのworkflow directoryへコピーしない。入力定義と受渡しはcalleeの `workflow_call.inputs` と `env`、固定参照と利用可能性はregistryの `qualityReusableWorkflow` を参照する。callerに残る `summary` は既存の集約check identityと失敗伝播のために必要であり、共通品質jobを再実装しない。実際のrequired check名の互換性はHostedで受け入れるまで未確認とする。

1. `ci-script-assets.reference.yml`の`adapterBundles`から、`languageProfiles`が対象言語と一致する
   entryを選ぶ。主callerでは `delivery: action` のentryのIDを `jobs.quality.with.standard-bundle-id` に対応する生成設定へ渡し、`adapter-descriptor` は空にする。独自descriptor経路では標準IDを空にする。標準bundleをdescriptorとして配置する経路は使用しない。optional／Release品質stepの選択は引き続き `CI_STANDARD_BUNDLE_ID`／`CI_ADAPTER_DESCRIPTOR`。選択契約は `ci-adapter-bundles.reference.yml` を参照する。
   plan前にlanguage profile、toolchain、runner、保護branch、必要なtoolのexact版を選ぶ。選択した言語で使わないuvまたはcargo-auditの版と、主qualityで使わないjqの版は、対応する生成設定へJSON文字列の空値を渡す。

2. `distribute-ci-assets.guide.md`に従って`quality-gate` presetをfetchする。
   planに必要なruntimeを、取得済みdistributionの`runtime/preset/`固定依存定義から
   `validate-ci-preset.guide.md`の「runtime準備」で
   `{project-root}/.a3-skills/ci-github/runtime/`へ準備する。runtimeはGit管理に含めない。
   その後、製品設定を`--set`で渡してplanを生成し、`create`／`reuse`／`update`と競合なしを
   確認してから、plan digestを明示してapplyする。

3. 標準bundleの配置は不要。project設定を検査して参照bindingを確認する場合だけ、`distribute-ci-assets.guide.md`の追加取得手順で同一revisionのmaterializerを取得し、準備済みローカルruntimeで実行する。標準経路は外部スキル集合を読まず、`--source-root` を省略する。独自bundleの配置では指定が必要。

   ```bash
   ci_github_local_runtime="{project-root}/.a3-skills/ci-github/runtime"
   CI_FIXED_RUNTIME_ROOT="$ci_github_local_runtime" \
     "$ci_github_local_runtime/node_modules/.bin/tsx" \
     "{ci-github-source-root}/runtime/adapter/materialize-adapter-bundle.ts" \
     --inventory "skills/ci-github/references/ci-script-assets.reference.yml" \
     --bundle "{bundle-id}" \
     --target-root "{project-root}"
   ```

   成功時は `ci.adapter-materializer.v1` のJSONが出力される。標準経路は `files: []` と固定生成元identityを含むbindingを返し、consumerへファイルを追加しない。独自配置経路の衝突は従来どおり停止する。

4. 固定標準bundleまたは独自descriptorの `projectSettings` を確認し、project側に不足する
   ファイルまたはコマンドだけを追加する。標準bundleのコマンド自体はproject側で再定義しない。

5. 配置したworkflowを検索し、未解決値と設定先を確定する。

   ```bash
   rg -n '<[a-z0-9-]+>|vars\.|secrets\.|workflow_dispatch:' \
     "{project-root}/.github/workflows"
   ```

   `<...>`が生成済みcallerに残っている場合は停止する。planの入力設定を見直し、配布ガイドの更新・復旧手順に従って再生成する。callerを手動置換して補完しない。
   `vars.`はGitHub Variables、`secrets.`はGitHub Secrets、
   `workflow_dispatch.inputs`は実行ごとの入力として設定する。tool versionを`vars.`へ移さない。

6. 生成済みcallerのlanguage profile、toolchain、必要なtool version、runner、保護branch、標準bundle IDまたは独自descriptor名をplanの承認値と照合する。
   calleeと外部Actionの固定参照は生成時に自動解決される。標準bundle APIは正式Releaseのexact tagとfull SHAが確認されるまで導入しない。
   trusted CI assets の採用済み marker は base の `.ci/ci-assets.lock.json` であり、workflow に flag はない。

   merge queueを使う場合は`on.merge_group`を空のevent設定として追加する。定期実行を使う場合は
   `on.schedule`へ一つ以上の非空`cron`を設定する。これ以外のtrigger差分は追加しない。

7. `references/validate-ci-preset.guide.md`に従い、配布元のfull commit SHAでlockを生成してからpreflightを実行する。materializerの成功だけではworkflowの設定完了を意味しない。

### 初回導入と platform 後続導入

trusted PR check は標準で base SHA の trusted CI assets を使用する。base に `.ci/ci-assets.lock.json` が無く、対象資産も無い場合に限り、初回導入として same-repo head の資産と trusted project root を使用する。

1. 初回導入 PR では flag 設定を必要としない。base に marker と資産が無いため、workflow は head で品質検証を実行する。
2. 初回導入 PR を merge すると base に workflow と lock が入り、以降の PR は base 固定で判定する。
3. platform 別検証の既存 project への後続導入は、base に `.ci/platform-manifest.yml` と `.ci/quality-platforms.yml` を先に配置して lock を再生成し、その後 platform workflow を導入する。preflight は companion のみの配置を許容し、platform workflow の配置時には companion を要求する。
4. lock が無い状態で対象資産だけが存在する base は不整合として停止する。lock を生成してから workflow を更新する。

初期解決は use-case の例外経路ではなく canonical state であるため、`.ci/README.md` の例外経路へ記録しない。

## `quality-gate` に platform 別検証を追加する場合

platform 固有の runtime、artifact、installer の検証が必要な project だけが、次の順で optional asset を導入する。

1. `.ci/platform-manifest.yml` に platform を宣言する（`id`、`runner`、`target`。runner は registry の allowlist 内の versioned label）。
2. `.ci/quality-platforms.yml` に検証する platform の `id` だけを列挙する。manifest に無い id、重複 id は preflight で停止する。
3. 配布ガイドのoptional platform品質の取得手順に従い、callerとcallee検証用資材をfetchし、planにも同じasset選択を渡す。`jobs.platforms.with`に対応する製品設定を`--set`で渡し、承認済みapplyで薄いcallerを配置する。入力定義はproviderの `.github/workflows/ci-quality-platforms.yml`、固定参照・公開状態はregistryの `qualityPlatformsReusableWorkflow` を参照する。calleeはconsumerへコピーしない。platform workflowのみの配置は停止する。companionのみの先行配置は後続導入のために許容する。
4. lock を再生成し、preflight を通す。
5. callerの `platform-summary` は `quality-gate-platforms / summary` の固定名で、calleeの失敗・中断・未実施・結果欠落を成功に読み替えない。provider側は期待platformの欠落、docs-only時の対象外記録、matrix結果を集約する。Hostedでrequired check名と失敗伝播を受け入れるまで利用可能扱いにせず、受入後にbase `quality-gate` のrequired checkと別に登録する。
6. `.ci/README.md` の差分記録に、platform 別検証の採用と platform 選択の正本を残す。

## Release・packageプリセットの導入差分

`release-request` は tag variantをfetch→plan→applyで生成・配置し、新しい annotated tag の push から不変 request handoff だけを作成する。共通処理は固定SHAのActionに含まれるため、project wrapperを追加しない。tag解決とhandoff生成はAction内のNode runtimeで実行するため、この経路ではgh・jq・sha256sumの版設定や準備を要求しない。tag event handoff が欠落または失敗した場合は公開を停止し、別経路で補完しない。
旧 manual variant を配置済みの project は `.github/workflows/release-request.yml` を撤去してから配布同一性 lock を再生成する。

`release-publication` の処理順、入力境界、notes handoff の生成元、caller の検証責務は `references/implement-release-asset-publication-workflow.guide.md` に従う。本ガイドでは、同プリセットの request と caller を配置し、前節の設定場所および「release workflow の project 設定」へ値を割り当てる。

補助Release assetを選択しないprojectは、planの`--set`で`<supplemental-release-asset-enabled>`に対応する生成設定へ
JSON booleanの`false`、`<supplemental-release-asset-owner-contract>`へJSON文字列`"__unset__"`を渡す。
`<supplemental-release-asset-implementation>`へは`"owner-adapter"`、
`<supplemental-release-asset-config-path>`へは`"__unset__"`を渡す。この場合は
補助adapterを配置せず、assembleは共通のauthorityとconfig snapshotだけを受け取り、補助handoffを
受け取らない。固定SHAの`ci-config-snapshot`は空値を拒否するため、無効値を空文字へ戻さない。
補助Release assetとしてinstallerを配布するprojectは、installerスキルへセットアップを委譲し、標準runtimeの適用範囲と固有実装の必要性を確認して、製品宣言・manifest・組立・製品READMEへのインストール手順追記を進める。確定した実装選択・契約ID・製品宣言pathをplanの`--set`で渡し、生成済みcallerの補助asset入力と照合する。workflow接続・権限・認証・公開とpreflightはCI側が担当する。

非標準のowner adapterは既定の `owner-adapter` とconfig path `__unset__` を使い、
`release-supplemental-asset-build-scripts.adapterInterface` を実装する。選択値と契約IDは
Repository Variable、Secret、ファイル存在から解決しない。両経路ともauthorityに結び付いた
snapshotの選択だけを使い、既存outputや入力の変更を拒否する。

`release-publication` と `package-publication` はworkflowのコピーだけでは完成しない。registryの
選択した固定 SHA Action binding、残る`requiredExtensions`、有効な`conditionalExtensions`を
project固有の契約へ接続し、次を満たしてからpreflightへ進む。

- workflowが参照する正確な配置先にextensionが存在する。
- Action bindingを選択した処理はActionの公開契約、project-ownedのbuildやpublishはproject側が所有する。
- write権限を持つjobは検証済みhandoffだけを入力に使う。
- Variables、Secrets、workflow inputsを同じ値の重複正本にしない。

### release workflow の project 設定

`release-publication` の build 検証は、binary の `--version` 出力を provider の version 検証契約で release version と照合する。次のproject設定をplanの`--set`で渡し、生成済みcallerの初期パラメータと照合する。

- `CI_CARGO_MANIFEST_PATH` / `CI_CARGO_LOCK_PATH`: 検証対象 crate の manifest と lock の path。
- `CI_RELEASE_BINARY_NAME`: 検証対象の cargo bin 名。
- `CI_RELEASE_ASSET_PREFIX`: archive と asset 名の接頭辞。

consumer が渡すのは値だけであり、`--version` の出力形式や受理規則は設定しない。受理規則は provider の version 検証契約に従い、出力に release version（または `v`・`V` を1文字付けた版）が独立トークンとして現れることを検証する。導入時に project 側で出力形式を確定する必要はない。

## preflight

配置後は、`references/validate-ci-preset.guide.md`に従い、導入先を対象にpreflightを実行する。

## 旧 manifest からの移行

`.ci/ci-preset.yml` は現行契約では使用しない。自動移行はせず、次の対応で正本へ移す。
`.ci/ci-assets.lock.json` は設定移行先ではなく配布同一性の検証入力であり、旧フィールドを転記しない。
workflow初期パラメータへ移す値は、現行templateの設定名と型を確認してplanの`--set`で渡し、生成結果を照合する。

| 旧フィールド | 現行の正本 |
| --- | --- |
| `id`、`preset` | registry の canonical destination に配置した workflow |
| `languageProfile` | workflow 初期パラメータ |
| `toolchain` | project の version 設定または workflow 初期パラメータ |
| `adapter`、`adapterBundleDescriptor` | quality workflowの標準bundle選択、または独自descriptor |
| `providerConfig.workflowFile` | registry の canonical destination |
| `requiredCallerInputs`、`requiredCallerSecrets` | reusable workflow の `workflow_call` と caller の `with`／`secrets` |
| `requiredRequestInputs` | request workflow の `workflow_dispatch.inputs` |
| `requiredAssets`、source declaration | workflow から到達する asset と配置実体 |

同じプリセットの旧 entry が複数ある場合は機械的に統合せず、残す canonical workflow と
trigger variant を owner が決めてから移行する。

## 導入完了条件

- canonical workflow と到達する asset が配置されている。
- workflow、descriptor、policy、Variables、Secrets の正本が一意である。
- preflight と provider の静的検証が成功している。
- installerの採否が確定している。採用した場合は、installerセットアップガイドの完了条件と実施結果を確認している。未実施・未確認・ブロッカーが残る場合はCIセットアップ全体を完了扱いにしない。非採用の場合は理由を報告する。
- hosted、権限、secret、remote readback の未確認事項は成功扱いされていない。

package 準備の提供側 workflow、固定参照と公開状態は preset registry の
`packagePreparationReusableWorkflow` に従う。提供側 workflow は導入先へコピーせず、
owner の build／publication adapter は維持する。`pending-release` の間は適用しない。

### 共通 Release・Package 公開 workflow の参照

Release・Package 公開 callee は consumer へコピーせず、caller の `jobs.publish.uses` から provider を固定参照する。固定参照と公開状態は preset registry の `releasePublicationReusableWorkflow`／`packagePublicationReusableWorkflow`、設定入力は provider の `workflow_call.inputs` を正本とする。設定はplanの`--set`で静的なowner値を渡し、生成されたcallerの`jobs.publish.with`と照合する。Releaseのrequest run IDとPackageの検証済みhandoff identity以外の設定を実行時リクエストから取得しない。`pending-release` の間は導入しない。

旧構成からは既存 callee の設定を caller 入力へ移し、plan の差分確認と承認を経て caller を切り替える。旧 callee の削除は所有と参照がないことを確認して別途承認する。提供元 SHA と consumer の `github.workflow_sha` は別の値であり、control checkout は後者と `github.repository` を使用する。

Packageのregistry secretはcallerの `jobs.publish.secrets` から明示注入し、consumerのowner publisherを呼ぶ。準備calleeの固定参照は `packagePreparationReusableWorkflow` の既存契約を維持する。
