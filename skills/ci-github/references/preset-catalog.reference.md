# GitHub Actions CI preset catalog

## 理解できること

- `ci` のプリセットを GitHub Actions asset へ対応付ける方法
- provider 固有の入力と実装境界
- 導入・検証ガイドへの進み方

## 正本と境界

プリセットの意味、入出力、停止条件は `references/ci-preset-contracts.reference.yml`、GitHub Actions の workflow、コピー先、必要 asset、Action mapping は `references/ci-github-preset-assets.reference.yml` を正本とする。

本カタログは選択の入口だけを示す。Git、branch、version、release notes、承認、処理契約、例外条件を再定義しない。

GitHub 固有の trust、workflow authoring、version 固定には provider profile（`references/runner-trust-policy.reference.md`、`references/workflow-authoring-policy.reference.md`、`references/workflow-version-policy.reference.md`）を適用する。

## provider 入力

| 入力 | 解決元 | 用途 |
| --- | --- | --- |
| `preset` | `ci` の契約 | workflow asset の選択 |
| `language-profile` | workflow初期パラメータ | quality adapter の選択 |
| `toolchain` | projectのversion設定またはworkflow初期パラメータ | runtimeとtoolchainの版固定 |
| `platform-manifest` | trusted controlまたはowner契約 | build targetと期待asset集合 |
| `request-handoff` | `release-request` workflow | Release要求の固定入力 |
| `trusted-control` | 固定SHAのcontrol snapshot | authority、assemble、publish |

具体的なVariables、Secrets、workflow inputs、既定値はコピーしたworkflowを正本とし、設定場所と解決順は`references/configure-ci-preset.guide.md`に従う。

## workflow asset の選択

workflowのsource、配置先、必要assetはregistryのpreset entryから選ぶ。

| プリセット | registry entry | workflowの用途 |
| --- | --- | --- |
| `quality-gate` | `registry.presets[quality-gate]` | 変更・統合の品質検証 |
| `release-request` | `registry.presets[release-request]` | tagから公開準備用request handoffを生成 |
| `release-publication` | `registry.presets[release-publication]` | notes確認後の手動requestをdefault branchのcallerで検証し、Release資材を公開 |
| `package-publication` | `registry.presets[package-publication]` | 検証済みpackageをregistryへ公開 |

registryの`source`はスキル公開元からコピーするときだけ使う。コピー後は`.github/`、`.ci/`、projectの設定だけで実行できる状態にする。provider固有の処理順と権限境界は配置したworkflowを正本とする。

`quality-gate`のplatform別検証は任意選択とする。必要なprojectだけがregistryの`optionalWorkflowAssets`（`quality-gate-platforms`）を、companionの`.ci/quality-platforms.yml`と一組で導入する。既存projectへの後続導入ではcompanionを先行配置してよい。選択データはplatform manifestの`id`だけを列挙し、runner mappingはmanifestに残す。未選択のprojectは従来の単一runner構成を維持する。採用時は固定名の集約 check を別 required として追加し、base `quality-gate` の判定へ暗黙に混ぜない。

Release は `tag-preparation + manual-publication` を標準選択とする。GitHub Actions 上の詳細な公開経路は `references/implement-release-asset-publication-workflow.guide.md` に委譲する。

canonical の `release-request` は tag adapter のみを提供する（manual mode は提供しない）。`package-publication` の version plan は `strategy:exact` を固定し、`ciGenerated` の具体化は canonical に含めない。いずれかを必要とする project は、provider registry へ登録された extension としての採用可否を owner 判断で確定してから導入する。

## adapter bundle の選択

`quality-gate`では、`ci.script-assets` inventoryの`adapterBundles`から`languageProfiles`が一致するbundle IDを選ぶ。配置は`ci`スキルのmaterialization契約と導入ガイドに従い、descriptorを実行契約の正本とする。

一致する標準bundleがない場合だけ、`ci`スキルのadapter契約を満たすproject-owned descriptorを用意する。Releaseとpackageの実装はadapter bundleへ含めず、registryの`requiredExtensions`へ接続する。

## Action の選択

a3 Actionはregistryの`actionization`、一般的なAction候補、選択順位、承認pin（版・SHA・runtime）は`providerActions`を正本とする。実行するActionは固定SHA、最小権限、trust、I/O、workflow mappingを確認する。Actionの公開APIと実装は`github-actions`スキルと提供元が所有する。

## 次の手順

- 導入と設定: `references/configure-ci-preset.guide.md`
- 配置済み構成のpreflight: `references/validate-ci-preset.guide.md`
- 契約テストからhosted／remote証拠までの確認: `references/verify-applied-ci-preset.guide.md`
- Release assets公開の実装: `references/implement-release-asset-publication-workflow.guide.md`
