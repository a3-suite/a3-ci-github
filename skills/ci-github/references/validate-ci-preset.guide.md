# CI プリセット導入 preflight ガイド

## 目的

コピー済みの GitHub Actions workflow と project-local asset を直接検査する。
導入・更新・監査時だけ使う skill script であり、コピー先の runtime asset には含めない。

## 入力

- 監査モード
- `{ci-github-source-root}`: `distribute-ci-assets.guide.md`に従い、選択presetの`workflows/`、`runtime/`、`lint-rules/`、registryを取得・検証したproject-local distribution root
- 任意の `{skill-collection-root}`: 外部 language skill の資材を参照する adapter bundle を使う場合に指定するスキル集合 root。標準bundleと外部資材を参照しない構成では省略する。
- 導入先 project root
- `{project-root}/.a3-skills/ci-github/` のスキル専用ローカル状態 root
- read-only 監査で使う、スキル専用ローカル状態 root 内に準備済みの validator runtime
- registry の canonical destination にある `.github/workflows/`
- registry の `workflowAssets[].source` にある canonical workflow
- registry の `actionization.targets`、固定 Action ref、権限付き job の allowlist、標準実装 binding
- workflow から参照される `.ci/` asset
- `.ci/ci-assets.lock.json` の配布元 full commit SHA、canonical／配置済み SHA-256、生成日時
- quality workflow が指定する adapter descriptor
- 任意の `--preset` filter

プリセット選択を重複記録する構成ファイルや、workflow から導出できる一覧は入力にしない。
配布同一性 lock の生成日時は観測時刻としてだけ扱い、配布版や新旧判定には使わない。

## 実行

validator の依存定義は `{ci-github-source-root}/runtime/preset/package.json` と `package-lock.json` を正本とする。project-local distributionには`node_modules/`を作成しない。preflight は Node.js 標準機能だけで起動する `{ci-github-source-root}/runtime/preset/run-validate-ci-preset.mjs` を公開入口とし、canonical runtimeと準備済みruntimeの一致、依存ツリー、隔離境界を確認してから TypeScript validator を起動する。distribution receiptとsource revisionの検証は、この入口を呼ぶ前に選択配布CLIが所有する。

### read-only 監査

管理対象資産と外部の永続状態を変更しない。依存のインストール、runtime の作成、lock の生成は行わず、`{project-root}/.a3-skills/ci-github/runtime/` に準備済みの runtime から validator を実行する。

```bash
node "{ci-github-source-root}/runtime/preset/run-validate-ci-preset.mjs" \
  --audit-mode read-only \
  --repo-root "{project-root}"
```

bootstrap の `cannot-start`、TypeScript validator が報告した配置済み資産の不一致、validator 起動後の `cannot-complete` は、それぞれ観測事実と stderr の診断を保持し、`ci-audit-contract.reference.yml` の `statusClassification` で provider preflight の status を導出する。監査中に runtime、lock、依存を生成して補完しない。

### remediation

管理対象の変更許可がある場合だけ、実行時の依存をスキル専用ローカル状態へ展開する。remediation でも一時 runtime と npm cache は管理対象資産へ配置しない。

#### runtime準備

初回導入では、この準備をplan前に行う。この段階ではcallerの配置やlock生成を前提とするpreflightを起動しない。

```bash
ci_github_local_runtime="{project-root}/.a3-skills/ci-github/runtime"
mkdir -p "$ci_github_local_runtime"
cp "{ci-github-source-root}/runtime/preset/package.json" \
  "{ci-github-source-root}/runtime/preset/package-lock.json" \
  "$ci_github_local_runtime/"
npm_config_cache="{project-root}/.a3-skills/ci-github/npm-cache" \
  npm ci --prefix "$ci_github_local_runtime" --no-audit --no-fund
```

#### 適用後のlock生成とpreflight

配布ガイドのplan／applyと必要なproject設定を終えてから検証する。lockが未作成または配布元を更新した場合は、準備済みruntimeで先に生成する。

```bash
CI_GITHUB_PREFLIGHT_RUNTIME_ROOT="$ci_github_local_runtime" \
  "$ci_github_local_runtime/node_modules/.bin/tsx" \
  "{ci-github-source-root}/runtime/preset/generate-ci-asset-lock.ts" \
  --repo-root "{project-root}" \
  --source-revision "{distribution-full-commit-sha}"
```

`--source-revision`は配布元の40桁commit SHAとする。generatorは導入済み全presetの現在のcanonical assetと配置済みassetが一致しない場合に停止し、単一lockへ記録する。`generatedAt`はUTCの分単位で記録する。

lock生成が必要な場合はその成功を確認してから、preflightを実行する。

```bash
node "{ci-github-source-root}/runtime/preset/run-validate-ci-preset.mjs" \
  --audit-mode remediation \
  --repo-root "{project-root}"
```

外部skillの資材を参照する構成では、preflightとlock生成の各コマンドに `--skill-collection-root "{skill-collection-root}"` を追加する。未指定で必要な外部資材を解決できない場合は失敗する。preflightは明示したrootが有効なdirectoryかを従来どおり検査する。

どちらのモードでも、対象を限定する場合は `--preset quality-gate` のように繰り返し指定する。

## 検査

- registry の canonical destination から導入済みプリセットを検出する。
- 検出が0件、指定したプリセットが不在、またはregistryが定義する必須workflowが欠けている場合は失敗する。packageではconsumerにrequestとcallerの2本を配置し、providerのpreparationとpublication calleeは検証用参照として扱う。
- `release-request` は tag preparation だけを trigger variant として扱う。標準 flow では tag request の完了を publish に直接接続せず、notes確認後の手動 publication を検出する。
- canonical placeholderを設定可能値として扱い、それ以外のYAML構造をcanonical workflowと照合する。placeholderだけで構成するlistは一つ以上の非空値へ置換できる。triggerの差はregistryに登録されたworkflowまたはtrigger extensionだけを許可する。
- qualityの`merge_group`は空のevent設定、`schedule`は一つ以上の非空`cron`だけを持つlistとして検証する。
- trigger、versioned runner、未解決 placeholder、外部 Action の40桁 SHA、直接・間接 asset を確認する。
- a3 Action は registry の target、workflow mapping、固定 ref と双方向に照合し、未登録、宣言漏れ、余剰接続を失敗にする。
- 主quality callerはregistryの `qualityReusableWorkflow` と照合し、固定ref・明示input・型・静的versioned runner・read permissions・caller summaryを検証する。provider側calleeの固定sourceからAction接続と固有設定へのbindingを検証し、calleeをconsumerの配置assetやlockへ追加しない。正式固定版の生成・配置とHosted required-check受入は別に判定する。
- optional platform callerもregistryの `qualityPlatformsReusableWorkflow` と照合し、calleeの入力・品質設定・Action依存まで検証する。calleeは検証用local-referenceとして配布閉包へ含め、consumerのcopy対象へは含めない。calleeのexactRefはmanifestの固定参照から解決し、依存Actionのavailability gateはregistryで確認する。
- 適用可能な Action 化 target が登録された共通処理を、project-owned entrypoint または copyable asset として重複配置していないことを確認する。project-owned 実装は、選択済み binding が充足しない登録済み `requiredExtensions` にだけ許可し、未登録の代替分岐として補完しない。Action 化 target がなく適用可能な reusable asset もない provider helper だけを copyable asset として許可する。
- Releaseの廃止入口は registry の `actionization.retiredProjectEntrypoints.release-publication` を正本とする。登録pathは用途にかかわらず予約済みとして、ファイル保持またはworkflow内の参照を失敗にする。preflightはconsumerのファイルを削除しない。
- 共通処理の候補比較、非採用理由、owner、証拠 identity は review フェーズの証拠として記録する。preflight は Action の登録・固定 ref・workflow mapping、asset の到達性・配置同一性を検証し、コードの意味的同一性を推測しない。
- write 権限を持つ job で a3 Action を使う場合は、対象 Action の `privilegedJobs` に `workflow-id/job-id` が完全一致で登録されていることを確認する。`trust: read-only` または workflow 単位の登録だけで許可を補完しない。
- 標準実装を選択した場合は、必要な extension と Action binding、language profile、project設定、依存閉包を照合する。未登録の実装識別子は、同名のローカル entrypoint が存在しても不一致とする。
- registryから導出したworkflowとcopyable assetについて、lockのcanonical／配置済みSHA-256を現在の内容と照合する。copyable assetはcanonicalと配置済み内容の完全一致も要求する。配置経路の標準descriptorとoptional workflowも同じ照合対象に含める。固定Action参照の標準bundleは配置assetに含めない。
- qualityの選択・配置・固定参照は `ci-adapter-bundles.reference.yml` の `profilePolicy.standardDelivery` と `copyContract` を正本とする。各導入済みworkflowの静的選択、profile、provider、owner設定、Action入力binding、生成元identityを検証する。trusted CI assetsのbase/head解決は `references/runner-trust-policy.reference.md#trusted-ci-assets-bootstrap` を参照し、配布同一性lockとcanonical構造を照合する。
- 標準IDはprofileに対応した登録済みAction bundleに限定する。パスによる標準bundleの既存経路はregistryのtargetDescriptorと配置digestを検証する。標準bundleがないprofileのproject-owned descriptorの意味はCI意味監査の `project-owned-ci-adapter` subjectで確認する。
- project-owned extension は、canonical workflow から entrypoint への直接接続、参照する直接・間接 asset の存在、project root 内での解決を確認する。project-owned asset 内部の構造と処理契約の意味は preflight の保証対象外とし、CI 意味監査の `project-owned-ci-adapter` subject で project の契約テスト証拠を確認する。実行環境での成立は必要な hosted 証拠で確認する。
- release publication は consumer の request と `workflow_run` caller の2 workflow、および登録済み固定 SHA の provider `workflow_call` publication を必須とし、request artifact と notes handoff の生成、caller の default branch provenance、run ID の受渡し、publication の再検証を確認する。
- release／package は callee の `workflow_call` から必須 input／secret を導出し、caller の接続と権限上限を確認する。
- request workflow は必須 input、操作対象sourceのcheckout禁止、公開 write 権限禁止を確認する。release publication request と caller は source や trusted snapshot を checkout せず、event metadata と immutable handoff だけを検証・転送する。project-local trusted control の checkout は、その control を実行する publication job に限定する。

Release publication の処理順と trust boundary の詳細は、`implement-release-asset-publication-workflow.guide.md` を参照する。

出力は `phase: "provider-preflight"`、`inspectedPresets`、`excludedPresets`、`inspectedWorkflows`、
`excludedWorkflows`、lockのsource revisionと検査件数を含む`evidence`、findings、
`semanticReviewRequired`、`semanticCandidates`を含む JSON とする。
この JSON の `status` は監査前の `provider-preflight` stepだけの機械検証結果であり、監査全体の status ではない。
`semanticCandidates` には、registry 外 workflow、到達不能な `.ci` asset、`.github/`／`.ci/` の未分類資産、Action とローカル実装の併存候補を含める。registry の `provider.staticValidation[].configPaths` に宣言された provider 静的検証の project-owned 設定 path は、owner と配置が正本化されているため未分類候補に含めない（内容は検証しない）。
`node_modules/` は依存 tree の root を一つの資産として候補化し、配下の個別ファイルを重複列挙しない。
これらは機械的な不適合判定ではなく、各候補について owner、処理契約、入出力、停止条件を照合する意味監査の入力である。
候補ごとの `retain`、`remove`、`replace` の判断と根拠が記録されるまで、意味監査を完了扱いにしない。
この JSON は監査前の事前機械検証の証拠であり、機械監査、意味監査、監査全体の結果ではない。監査者または上位のレビュー実行経路は、
`target-resolution` の監査モード・対象 identity、各フェーズの status と provenance、条件付きフェーズを対象外とした理由、
および `ci-audit-contract.reference.yml` の集約結果を別途保持する。validator の `status` だけで監査全体の適合を判定しない。

## 判定

個別 status と全体結果は `ci-audit-contract.reference.yml` の `statusClassification` と `result` へ写像し、監査完了条件は同契約の `completion` に委譲する。

- bootstrap の `cannot-start` は、必須 preflight を開始または継続できない観測として記録する。
- validator 起動後に観測した workflow、設定、asset、契約接続の不一致は、対象契約違反として記録する。
- validator または hosted／remote 観測が完了した後に証拠が不足・不一致となった場合は、証拠適用性の結果として記録する。
- 必須フェーズの未実施と全体結果の確定は、同契約の `result` / `completion` を参照して記録する。

provider preflight 後の継続可否は、同契約の `preAudit.continuation` だけから導出する。

preflight の成功は hosted 実行、runner trust、Repository 設定、Secrets、公開先、
remote readback の成功を証明しない。これらは別の実行証拠で確認する。
また、lockは実行に使ったローカル配布元との一致を証明するものであり、remote上の最新revisionであることは証明しない。remote最新版との比較は配布元revisionを別途取得して照合する。

a3-lintは外部Action固定、runner、immutable image、untrusted式、権限付きcancel、inline script、
CI runtime依存など単一workflowの一般規則を検査する。canonical構造比較はpreflightだけに置き、
同じ規則をLuaへ複製しない。

導入・更新・監査時は、ci-githubスキルのrule assetを直接選択して実行する。一時状態は `{project-root}/.a3-skills/ci-github/` へ分離し、cache は無効化する。

```bash
a3-lint lint "{project-root}/.github/workflows" \
  --no-config \
  --no-cache \
  --runtime-dir "{project-root}/.a3-skills/ci-github/a3-lint/runtime" \
  --project-root "{project-root}" \
  --lang yaml \
  --framework any \
  --add-rule-set-root "{ci-github-source-root}/lint-rules/a3-lint" \
  --add-rule-set-lib "{ci-github-source-root}/lint-rules/a3-lint/shared" \
  --rules-exclude 'shared/**' \
  --rules-include 'ci_github_workflow_*.lua' \
  --rules-exclude 'ci_github_runtime_no_a3_cli.lua' \
  --rules-exclude 'ci_github_ci_readme_contract.lua' \
  --format json \
  --fail-on error

a3-lint lint "{project-root}/.ci/README.md" \
  --no-config \
  --no-cache \
  --runtime-dir "{project-root}/.a3-skills/ci-github/a3-lint/runtime" \
  --project-root "{project-root}" \
  --lang markdown \
  --framework any \
  --add-rule-set-root "{ci-github-source-root}/lint-rules/a3-lint" \
  --add-rule-set-lib "{ci-github-source-root}/lint-rules/a3-lint/shared" \
  --rules-exclude 'shared/**' \
  --rules-include 'ci_github_ci_readme_contract.lua' \
  --rules-exclude 'ci_github_workflow_*.lua' \
  --rules-exclude 'ci_github_runtime_no_a3_cli.lua' \
  --rule-level ci-github-ci-readme-contract=error \
  --format json \
  --fail-on error
```

rule assetは導入元スキルから監査時に読み、コピー先workflowや`.ci/`から参照しない。warningは一般規則の診断として確認し、canonical構造からの逸脱を停止する責務はpreflightに置く。YAML規則はproviderの正式能力`fact:yaml_structure:v1`を必須とする。対応公開版は未確定であり、0.7.0は非対応。公開版切替までは対応能力を実測済みの開発バイナリでローカル検証する。共有helperは検証済み配布rootからlibとして参照し、rule収集から除外する。JS/TS用CLI規則とMarkdown規則をYAML実行へ混在させない。

`.github/`と`.ci/`を無条件にCI assetとみなすinventoryは、非CIファイルを構造的にfalse positiveとして候補化する根本原因である。provider静的検証設定の認識はその最小の緩和であり、inventory scopeの限定または認識集合の再編は別契約で扱う。

Package公開もconsumerにはrequestとcallerだけを配置し、publication calleeは `packagePublicationReusableWorkflow` の登録済み固定参照・公開状態・宣言入力・明示secret・権限と内部Actionを検査する。provider calleeはconsumerの実ファイルとして再読込しない。
