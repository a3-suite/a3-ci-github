# CI プリセット導入ガイド

## 目的

選択した CI プリセットをコピーし、project で変更する値と実装だけを接続する。
プリセットの意味、コピー元、コピー先は `ci-github-preset-assets.reference.yml`、共通処理契約は
`ci-script-contracts.reference.yml` を正本とする。

## 設定場所

コピー先に配布元スキルの配置ディレクトリは存在しない。導入後の設定は次の場所だけに置く。

| 種類 | 設定場所 | 内容 |
| --- | --- | --- |
| workflow 構成 | `.github/workflows/` | trigger、runner、固定 Action SHA、既定値 |
| 非秘匿の環境・運用値 | GitHub Variables（下記の必要性判定で必須または条件付きとなる場合だけ） | environment選択、運用ポリシー |
| toolchain・tool version | projectのversion設定またはworkflow初期パラメータ | 言語runtime、uv、cargo-audit、gh、jq、sha256sum |
| 秘匿値 | GitHub Secrets | registry token など |
| 実行ごとの入力 | `workflow_dispatch.inputs` | 例外的な request または手動 publication request の非秘匿入力 |
| quality adapter | `.ci/adapters/*.yml` | language command、toolchain、必要 project file |
| project policy | `.ci/platform-manifest.yml`、`.ci/package-policy.yml` など | platform、artifact、公開先 |
| project 実装 | `.ci/scripts/`、`.ci/trusted/` | registry の `requiredExtensions` |
| 配布同一性 | `.ci/ci-assets.lock.json` | 配布元 full commit SHA、canonical／配置済み SHA-256、分単位の生成日時 |

### project asset の推奨構成

`.ci/` のファイル数は揃えず、実行経路と責務を揃える。

- `.ci/adapters/` は `quality-gate` または `release-publication` の quality job が実行する quality adapter descriptor を置く。
- Release／Package の authority、build、assemble、publish は、適用可能な provider registry の固定 SHA Action binding を第一候補とする。project-owned の `.ci/scripts/`／`.ci/trusted/` entrypoint は、選択済み binding が充足しない登録済み `requiredExtensions` に対応する場合だけ接続し、未選択の代替分岐として保持しない。
- workflow から到達しない stage 別 descriptor、汎用 runner、選択結果だけを記録する manifest は追加しない。`.ci/ci-assets.lock.json` は設定や選択結果ではなく、配布同一性の検証入力だけを保持する。
- platform ごとの packaging や検証を分割する必要がある場合は、project 実装として分割を維持し、`.ci/README.md` に理由と owner を記録する。

同じ値を別の manifest に複製しない。環境・運用ポリシーは必要な場合だけ GitHub Variables を使い、
実行ごとに確定する値は workflow input を使う。toolchain と tool version は project のversion設定、
またはコピー時に置換する workflow 初期パラメータへ固定する。job の環境変数は値の受け渡しであり、
版の正本にはしない。
privileged reusable workflow は `runner-trust-policy.reference.md#privileged-workflow-の-trusted-ci-control` の
workflow identity 契約に従い、caller と called workflow の同一 SHA を job 内で検証する。別の control SHA を
`vars`、`secrets`、workflow input に置かない。
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
`CI_JQ_VERSION` は公式 Release に取得物と checksum がある exact 版を指定する。canonical workflow が
固定 SHA の provider Action で jq を供給してから verifier で検証するため、project 固有の install 処理は不要である。
`CI_GH_VERSION` も公式 Release に取得物と checksum がある exact 版を指定する。canonical workflow が jq の直後に
固定 SHA の provider Action で gh を供給してから verifier で検証するため、project 固有の install 処理は不要である。
`CI_SHA256SUM_VERSION` は release-request-tag と release-publication の verifier が参照する。versioned runner label が
提供する coreutils の版に一致させ、runner image の更新で版が変わった場合は project の CI owner が値を更新して
verifier 実行で再検証する。package-publication は `gh-jq` のため対象外である。

### `.ci/README.md` の責務

`.ci/README.md` は、すべての適用済み project に必須で置く。設定の正本にはせず、
project 固有差分がある場合は差分が必要な理由と正本への導線を記録する。差分がない場合も、
採用した preset / flow と「project 固有差分なし」を明記する。影響する preset または flow と、
workflow の実値、adapter descriptor、project policy、`requiredExtension` のうち該当する正本を示す。
owner、検証手順、撤去条件も記録する。

記載項目は、固定項目、オプション項目、自由記述に分類する。標準からずれない project は固定項目だけで完了とし、
標準の説明を補足文として繰り返さない。空の項目や未記入のテンプレートを完了扱いにしない。

- 固定項目（必須）: 目的と対象、採用 preset / flow、project 固有差分の有無、owner、正本・検証導線、検証証跡、更新・撤去条件。
- オプション項目（該当時のみ）: 例外経路、配置資産の責務、追加の検証証跡。該当しない項目の見出しは置かない。
- 自由記述（標準からの差異がある場合のみ）: 差異の背景、追加条件、handoff 先など。正本の decision、停止条件、共有契約、実値、command、workflow 構造を再定義しない。

root `README.md` に platform、artifact、Release flow などの利用者向け事実を記載する場合は、project policy / manifest と照合する。
root README は利用者向けの入口であり、CI契約の正本にはしない。値が正本と異なる場合はREADMEの補足で済ませず、正本との不一致として扱う。

```markdown
# CI configuration

## 固定項目（必須）

### 目的と対象

### 採用 preset / flow

### project 固有差分
- 差分種別: なし / placeholder / trigger extension / policy data / requiredExtension / adapter
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

- 差異の背景、追加条件、handoff 先など:
```

`例外経路` は `ci-workflow-use-cases.reference.yml` の `exceptions` にある exception ID を記録する。
例外の decision、停止条件、共有契約は正本を参照し、README へ複製しない。trigger extension、
`requiredExtensions`、owner adapter など既存の拡張も、同じ差分記録から正本へ追跡できるようにする。

実値、command、workflow 構造、停止条件、共有契約を `.ci/README.md` へ複製しない。
また、差分の記録は canonical workflow の変更を許可しない。placeholder または登録済み trigger extension
で表せない変更は、canonical asset または registry の契約として扱う。
監査では `.ci/README.md` と参照先の正本を照合する。正本が契約に適合している場合は、
`.ci/README.md` の理由と導線を正本へ追随させる。正本に契約違反がある場合だけ、owner の責務で正本を修正する。

## privileged workflow identity

privileged reusable workflow は、各対象 job の最初の step で caller と called workflow が default branch の同一 SHA
から実行されていることを確認する。検証済み SHA で trusted control を checkout し、直後に checkout HEAD を照合する。
このため導入者が trusted control SHA を事前計算する二段階 bootstrap は不要である。

導入時は caller、called workflow、必要な control asset を単一の検証対象として配置する。main へ反映する前に
git-branch-strategy の `mainIntegrationSafety` に従い、newly reachable commit 全件と最終 tree が releaseable であることを
確認する。GitHub が検証時と異なる commit または tree を生成する merge 方法は使用せず、main が進んだ場合は再検証する。

canonical publication は default branch の同一 SHA を検証するため、feature branch では canonical publication 全体の hosted 証拠にならない。
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
`distribute-ci-assets.guide.md`のfetch／plan／applyを先に完了する。コピー先の`{project-root}`は両方と別であり、
導入後の workflow や adapter から配布元を参照しない。

## プリセット別の値

| プリセット | コピーする workflow | project が設定する値 | project が実装するもの |
| --- | --- | --- | --- |
| `quality-gate` | `quality-gate.yml`（platform 別検証は任意の `quality-gate-platforms.yml`） | language profile、toolchain、runner、Action SHA、adapter descriptor 名、platform 選択を使う場合は `.ci/platform-manifest.yml` と `.ci/quality-platforms.yml` | 標準 bundle がない場合の quality adapter |
| `release-request` | tag request | tag pattern、runner、Action SHA | なし |
| `release-publication` | request、caller、reusable publicationの3 workflow全て | request handoff、notes handoff、tool versions、`.ci/platform-manifest.yml`、release implementation、quality adapter、言語・製品設定 | 選択した登録済み実装が充足しない authority、assemble、publish extension |
| `package-publication` | 4 workflow 全て | runner、Action SHA、tool versions、registry secret、package policy | build と publish extension |

標準導入では、一つの repository に同じプリセットの canonical workflow を一組だけ置く。
Release は `tag-preparation + manual-publication` を一つの標準 flow とし、tag request の完了から publish job へ自動連鎖させない。
複数 platform、artifact、package target は workflow の複製ではなく matrix、policy、handoff の集合で表す。

## 導入手順

1. `ci-github` スキルで用途に対応するプリセットを選ぶ。
2. `distribute-ci-assets.guide.md`に従い、exact Release manifestから選択presetの必須閉包をfetchし、planと明示承認を経てcanonical workflowを配置する。
3. registry から選択した preset の copyable asset、固定 SHA Action binding、その依存閉包、残る `requiredExtensions` を解決し、copyable assetを配置する。固定本数や platform 数から必要ファイルを推測しない。
4. quality は adapter descriptor、Release と package は選択した Action binding と残る `requiredExtensions` を workflow から直接接続する。依存閉包に属する copyable asset は改変しない。
5. 配置されたregistryの`workflowAssets`を読み返し、planで承認したdestinationと一致することを確認する。
6. workflow の placeholder だけを project の値へ置換し、外部 Action は `workflow-version-policy.reference.md` の「Action と版情報の扱い」に従って registry（`ci-github-preset-assets.reference.yml` の `providerActions`）の承認 pin を設定する。あわせて registry の `providerActions.pinCompanion` が宣言する `.ci/provider-action-pins.yml` を生成して配置する。job、step、permissions、trust 境界、summary 経路は直接変更しない。
7. workflow 初期パラメータ、必要な Variables、Secrets、workflow input の値を上表の場所に設定する。quality-gate は base の `.ci/ci-assets.lock.json` を採用済み marker とし、workflow 側の flag 設定はない。
8. 上記テンプレートに基づき `.ci/README.md` を作成または更新し、採用 preset / flow、差分または差分なし、owner、正本への導線、検証導線、更新・撤去条件を記録する。
9. 配布元 revision の full commit SHA を確認し、`{ci-github-source-root}/runtime/preset/generate-ci-asset-lock.ts` で `.ci/ci-assets.lock.json` を生成する。生成日時はUTCの分単位に正規化され、版識別には使わない。
10. CI向けa3-lintルールとactionlintで単一workflowの一般規則を検証する。actionlint 設定は `.github/actionlint.yaml`（project-owned、内容非固定）を registry の `provider.staticValidation` に従って扱う。
11. `references/validate-ci-preset.guide.md` に従い、canonical workflowとの構造照合と配布同一性を含むpreflightを実行する。
12. project-owned adapter と project の契約テストを作業 tree で先に成立させる。配布元の feature branch を push して immutable な full commit SHA を得た後、導入先の feature branch でその SHA を固定し、lock を再生成して preflight と契約テストを確認する。hosted 証拠は前述の default branch 制約に従い、既存の非公開・非書込み検証経路または隔離 staging repository で取得できる範囲だけを記録する。

既存ファイルを暗黙に上書きしない。差分を提示して owner が採用範囲を決めた後に配置し、
配置後はコピー先を設定の正本として読み返し、preflight時だけregistryのsourceと照合する。

## `quality-gate` の最短導入例

次は、標準 adapter bundle がある Rust、Python、TypeScript に共通する手順である。
既存の配置先ファイルがある場合は先に差分を確認し、`cp` で上書きしない。

1. `ci-script-assets.reference.yml`の`adapterBundles`から、`languageProfiles`が対象言語と一致する
   entryを選ぶ。entryの`id`を`{bundle-id}`、`targetDescriptor`をworkflowに設定するdescriptor名として使う。

2. `distribute-ci-assets.guide.md`に従って`quality-gate` presetをfetchし、planの
   `create`／`reuse`／`update`と競合なしを確認してから、plan digestを明示してapplyする。
   導入用 TypeScript helper のruntimeは管理対象CI資産に含めず、取得済みdistributionの
   `runtime/preset/`固定依存定義から`references/validate-ci-preset.guide.md`のremediation手順で
   `{project-root}/.a3-skills/ci-github/runtime/`へ準備する。

3. remediation 手順で準備・検証した `ci_github_local_runtime` を使い、選択した bundle をmaterializeする。

   ```bash
   ci_github_local_runtime="{project-root}/.a3-skills/ci-github/runtime"
   CI_FIXED_RUNTIME_ROOT="$ci_github_local_runtime" \
     "$ci_github_local_runtime/node_modules/.bin/tsx" \
     "{ci-github-source-root}/runtime/adapter/materialize-adapter-bundle.ts" \
     --source-root "{skill-collection-root}" \
     --inventory "skills/ci-github/references/ci-script-assets.reference.yml" \
     --bundle "{bundle-id}" \
     --target-root "{project-root}"
   ```

   成功時は `ci.adapter-materializer.v1` のJSONが出力される。既存ファイルと内容が異なる場合は
   `adapter-materializer-destination-conflict` で停止するため、差分を確認してから採否を決める。

4. descriptor の `projectSettings.requiredFiles` と `requiredScripts` を確認し、project側に不足する
   ファイルまたはコマンドだけを追加する。標準bundleのコマンド自体はproject側で再定義しない。

5. 配置したworkflowを検索し、未解決値と設定先を確定する。

   ```bash
   rg -n '<[a-z0-9-]+>|vars\.|secrets\.|workflow_dispatch:' \
     "{project-root}/.github/workflows"
   ```

   `<...>`はworkflow内で置換する。tool version の placeholder は固定値で置換し、`vars.`へ変換しない。
   `vars.`はGitHub Variables、`secrets.`はGitHub Secrets、
   `workflow_dispatch.inputs`は実行ごとの入力として設定する。選択した言語で使用しない
   `uv`または`cargo-audit`のversion placeholderは空文字へ置換する。

6. `CI_LANGUAGE_PROFILE`、`CI_TOOLCHAIN_VERSION`と選択した言語で必要なtool versionを
   projectのversion設定またはworkflow初期パラメータへ固定する。
   workflowに残るrunner、保護branch、descriptor名、外部Actionのplaceholderも確定する。
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
3. `workflows/quality/quality-gate-platforms.yml` を `.github/workflows/quality-gate-platforms.yml` へコピーし、placeholder を置換する。platform workflow のみの配置は停止する。companion のみの先行配置は後続導入のために許容する。
4. lock を再生成し、preflight を通す。
5. required check には固定名の `quality-gate-platforms / summary` を登録する。集約は期待 platform の欠落、未実施、runner 異常を成功に読み替えない。platform 検証を採用する project は、base `quality-gate` の required check とは別に、この固定名 check を追加する。
6. `.ci/README.md` の差分記録に、platform 別検証の採用と platform 選択の正本を残す。

## Release・packageプリセットの導入差分

`release-request` は tag variant をコピーし、新しい annotated tag の push から不変 request handoff だけを作成する。共通処理は固定SHAのActionに含まれるため、project wrapperを追加しない。tag event handoff が欠落または失敗した場合は公開を停止し、別経路で補完しない。
旧 manual variant を配置済みの project は `.github/workflows/release-request.yml` を撤去してから配布同一性 lock を再生成する。

`release-publication` の処理順、入力境界、notes handoff の生成元、caller の検証責務は `references/implement-release-asset-publication-workflow.guide.md` に従う。本ガイドでは、同プリセットの3 workflowを一組で配置し、前節の設定場所および「release workflow の project 設定」へ値を割り当てる。

補助Release assetを選択しないprojectは、callerの`<supplemental-release-asset-enabled>`を
booleanの`false`、`<supplemental-release-asset-owner-contract>`をYAML文字列`__unset__`へ置換する。この場合は
補助adapterを配置せず、assembleは共通のauthorityとconfig snapshotだけを受け取り、補助handoffを
受け取らない。固定SHAの`ci-config-snapshot`は空値を拒否するため、無効値を空文字へ戻さない。
選択するprojectだけが、補助adapter、
補助handoffを受け取れるassemble実装、owner契約の証跡recordとdigestを先に同じ受入単位で用意し、
owner契約IDを静的に設定してから値を`true`へ切り替える。installer assetでは契約ID
`installer.asset-assembly-evidence-contract`を設定し、同契約が要求する証跡recordを生成する。
補助adapterは `ci-github` スキルの `ci-script-contracts.reference.yml` にある
`release-supplemental-asset-build-scripts.adapterInterface` を実装する。従来の3引数呼出しは互換ではないため、
adapter、project側の契約テスト、canonical workflowを一つの受入単位で更新し、workflowを有効化する前に契約テストを成功させる。
選択値とowner契約IDはworkflowの静的初期パラメータとし、Repository Variable、Secret、
ファイル存在から解決しない。補助adapterとassemble実装は、workflowから渡される
`authority/config-snapshot.json`のowner契約IDを使用し、別の設定元から再解決しない。

`release-publication` と `package-publication` はworkflowのコピーだけでは完成しない。registryの
選択した固定 SHA Action binding、残る`requiredExtensions`、有効な`conditionalExtensions`を
project固有の契約へ接続し、次を満たしてからpreflightへ進む。

- workflowが参照する正確な配置先にextensionが存在する。
- Action bindingを選択した処理はActionの公開契約、project-ownedのbuildやpublishはproject側が所有する。
- write権限を持つjobは検証済みhandoffだけを入力に使う。
- Variables、Secrets、workflow inputsを同じ値の重複正本にしない。

### release workflow の project 設定

`release-publication` の build 検証は、binary の `--version` 出力を provider の version 検証契約で release version と照合する。次の project 設定を workflow 初期パラメータへ固定する。

- `CI_CARGO_MANIFEST_PATH` / `CI_CARGO_LOCK_PATH`: 検証対象 crate の manifest と lock の path。
- `CI_RELEASE_BINARY_NAME`: 検証対象の cargo bin 名。
- `CI_RELEASE_ASSET_PREFIX`: archive と asset 名の接頭辞。

consumer が渡すのは値だけであり、`--version` の出力形式や受理規則は設定しない。受理規則は provider の version 検証契約に従い、出力に release version（または `v`・`V` を1文字付けた版）が独立トークンとして現れることを検証する。導入時に project 側で出力形式を確定する必要はない。

## preflight

配置後は、`references/validate-ci-preset.guide.md`に従い、導入先を対象にpreflightを実行する。

## 旧 manifest からの移行

`.ci/ci-preset.yml` は現行契約では使用しない。自動移行はせず、次の対応で正本へ移す。
`.ci/ci-assets.lock.json` は設定移行先ではなく配布同一性の検証入力であり、旧フィールドを転記しない。

| 旧フィールド | 現行の正本 |
| --- | --- |
| `id`、`preset` | registry の canonical destination に配置した workflow |
| `languageProfile` | workflow 初期パラメータ |
| `toolchain` | project の version 設定または workflow 初期パラメータ |
| `adapter`、`adapterBundleDescriptor` | quality workflow の `CI_ADAPTER_DESCRIPTOR` と descriptor |
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
- hosted、権限、secret、remote readback の未確認事項は成功扱いされていない。
