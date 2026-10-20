# a3-ci-github

GitHub Actions の CI を、標準の preset（品質検証、Release、Package 公開）として導入・更新・監査するための CI 資材を提供します。

## 概要

利用 project は、必要な preset だけを Release から取得し、製品設定を埋め込んだ workflow を差分確認してから配置します。共通処理は固定 SHA で参照する Action が担うため、利用 project は共通実装をコピーしません。

| 提供物 | 用途 |
| --- | --- |
| 選択配布 CLI（Release asset） | preset・asset の取得、検証、配置計画、適用、復旧 |
| GitHub Actions（`actions/<action-name>/`） | workflow から 40 桁 commit SHA で参照する共通処理 |
| Agent Skill（`skills/ci-github/`、`skills/ci-release-installer/`） | AI エージェントによる CI の設計・導入・監査、インストーラの設計・監査の導線 |

各 Release は、配布 manifest、単独で実行できる fetch CLI（`fetch-a3-ci-github.mjs`）、`SHA256SUMS` を公開します。

## 導入

前提:

- 導入先は GitHub Actions を使う Git repository
- Node.js 24 または 26 以降
- GitHub CLI（`gh`）と `sha256sum`（取得と checksum 検証に使用）
- 採用する exact Release（例: `v0.6.0`）。選定条件は[配布ガイドの対応条件](skills/ci-github/references/deploy-ci-assets.guide.md#対応条件)を参照してください。

1. 採用する Release から fetch CLI、配布 manifest、`SHA256SUMS` を取得し、checksum を検証します。

   ```bash
   gh release download v0.6.0 --repo a3-suite/a3-ci-github \
     --pattern fetch-a3-ci-github.mjs --pattern a3-ci-github-distribution-manifest.json --pattern SHA256SUMS
   sha256sum --check SHA256SUMS
   ```

2. 導入先 repository の root で、検証した manifest を指定して preset を取得します。

   ```bash
   node fetch-a3-ci-github.mjs fetch \
     --manifest a3-ci-github-distribution-manifest.json \
     --preset quality-gate \
     --repo-root .
   ```

3. 出力された `sourceRevision` を使い、plan 用 runtime の準備、製品設定（`--set`）を渡した `plan`、差分の確認、同じ digest での `apply` を行います。手順と設定値は [CI プリセット設定ガイドの導入手順](skills/ci-github/references/configure-ci-preset.guide.md#導入手順)、適用後の lock 生成と検証は[配布ガイド](skills/ci-github/references/deploy-ci-assets.guide.md#適用後)に従います。

Agent Skill は、同じ manifest から asset `skill.ci-github` と `skill.ci-release-installer` を `--asset` で指定して取得できます。取得先は `.a3-skills/ci-github/distributions/<sourceRevision>/skills/` です。利用環境のスキルフォルダへの配置は利用者が行います。

## 使い方

workflow から Action を直接使う場合は、Release の manifest または [preset registry](skills/ci-github/assets/registry/ci-github-preset-assets.yml) に記録された commit SHA を指定します。

```yaml
uses: a3-suite/a3-ci-github/actions/<action-name>@<40-char-commit-sha>
```

導入済み CI の更新は、新しい Release で取得から適用までを同じ手順で行います。管理外の差分は上書きせず、`conflict` として停止します。

## 製品と対応スキルの同時Release

製品の公開スキルを、OS 共通の `<repository-name>-skills.zip` と checksum として製品と同じ Release へ含められます。設定と README の導入案内は[同時Releaseガイド](skills/ci-github/references/publish-project-skills.guide.md)を参照してください。

## 旧 a3-actions の利用者へ

旧 `a3-suite/a3-actions` の公開資産は既存 consumer 向けに維持します。削除または archive は別途承認するまで行いません。

## Action一覧

<!-- action-catalog:start -->

| Action | 用途 | 概要 |
| --- | --- | --- |
| [`ci-annotated-tag-resolver`](actions/ci-annotated-tag-resolver/README.md) | Annotated tag を GitHub API で解決し、tag object と source commit の SHA を出力します。tag が lightweight tag の場合は失敗します。 | Resolve an annotated Git tag to its tag object and source commit. |
| [`ci-change-scope`](actions/ci-change-scope/README.md) | `ci-change-scope` は base/head の差分を読み、documentation-only pattern に従って CI と documentation checks の実行要否を返します。差分が取得できない場合は両方を実行する値と `unresolved` status を返します。workflow の trigger、job 境界、required check は所有しません。 | Classify changed files and report CI or documentation scope. |
| [`ci-config-snapshot`](actions/ci-config-snapshot/README.md) | `ci-config-snapshot` は runtime、workflow、preset の設定を runtime 優先で解決し、`ci.config-snapshot.v1` の JSON と SHA-256 digest を出力します。workflow の job 境界、権限、runner、project adapter は所有しません。 | Resolve CI configuration precedence and write a deterministic snapshot. |
| [`ci-gh-provisioner`](actions/ci-gh-provisioner/README.md) | 指定した exact version の GitHub CLI (`gh`) を公式 Release から検証付きで供給します。 | Install an exact GitHub CLI release asset after checking its release checksum. |
| [`ci-github-toolchain-verifier`](actions/ci-github-toolchain-verifier/README.md) | GitHub CI で利用する `gh`、`jq`、`sha256sum` の存在と完全一致バージョンを検証するときに使います。 | Verify exact gh, jq, and sha256sum versions for GitHub CI |
| [`ci-handoff-integrity`](actions/ci-handoff-integrity/README.md) | `ci-handoff-integrity` は handoff descriptor、manifest、成果物の digest と source/version/target identity を read-only で検証します。descriptor と manifest の path は handoff root 配下の相対ファイルだけを受け付け、symlink escape を拒否します。 | Validate a release handoff descriptor, manifest, and artifact digests. |
| [`ci-jq-provisioner`](actions/ci-jq-provisioner/README.md) | 指定した exact version の jq を公式 Release から検証付きで供給します。 | Install an exact jq release asset after checking its release checksum. |
| [`ci-package-publication-request`](actions/ci-package-publication-request/README.md) | `ci-package-publication-request` は package publication request handoff を生成または検証します。workflow の repository、event、branch の信頼判定、artifact 転送、job 権限、publish は所有しません。 | Create or verify an immutable package publication request handoff. |
| [`ci-platform-matrix`](actions/ci-platform-matrix/README.md) | `ci-platform-matrix`は、信頼済みcheckout内のplatform manifestを検証し、GitHub Actionsの strategyへ渡せる`{"include":[...]}`形式のJSONを返します。workflowのjob、runner選択、 permissions、matrix適用は所有しません。 | Validate a CI platform manifest and output a deterministic GitHub matrix. |
| [`ci-publish-version`](actions/ci-publish-version/README.md) | `ci-publish-version` は、caller が渡した owner-approved version plan を検証して `publish-version` へ具体化する read-only Action です。version strategy、template、component、公開可否、source / artifact identity は選択しません。 | Materialize an owner-approved CI version plan into a publish version. |
| [`ci-quality-toolchain`](actions/ci-quality-toolchain/README.md) | 品質検証用の固定Node／Python／Rust toolchainを準備するときに使います。 | Prepare the selected fixed quality toolchain. |
| [`ci-quality-adapter`](actions/ci-quality-adapter/README.md) | `ci-quality-adapter` は trusted descriptor に定義された read-only quality commands を fixed source checkout で実行し、構造化結果を出力します。workflow の checkout、権限、credential、trusted descriptor の選択は所有しません。 | Execute a validated read-only quality adapter against a fixed source checkout. |
| [`ci-quality-summary`](actions/ci-quality-summary/README.md) | `ci-quality-summary` は quality result の JSON を GitHub Actions の step summary へ追記し、集約 status と証跡 digest を返します。workflow の job、権限、runner、language adapter、publish 処理は所有しません。 | Render CI quality results to a GitHub step summary. |
| [`ci-release-publication-control`](actions/ci-release-publication-control/README.md) | `ci-release-publication-control` は release publication request の生成、workflow handoff との結合、公開直前の approval を検証します。provenance の検証は `ci-release-authority` が内部で行います。artifact の取得、GitHub API、job 権限、credential、publish は workflow が所有します。 | Create and verify release publication request handoffs and approval. |
| [`ci-release-request-handoff`](actions/ci-release-request-handoff/README.md) | annotated tag から解決済みの source identity を、version 解決を authority に委譲する `ci.release-request.v1` handoff へ書き出します。Action は承認や公開可否を判断しません。 | Write an immutable annotated-tag release request handoff. |
| [`ci-rust-release-build`](actions/ci-rust-release-build/README.md) | 固定 source の Rust CLI を、authority と platform manifest に拘束された toolchain／target で buildし、 Release archive、checksum、`asset-manifest.json` を新しい出力ディレクトリへ生成して検証します。 | Build, package, and verify a Rust CLI release asset |
| [`ci-rust-source-gate`](actions/ci-rust-source-gate/README.md) | Rust CLI の Release authority に記録された language profile と source SHA を、現在の checkout に照合します。 | Verify Rust release authority and checked-out source identity |
| [`ci-release-assembly`](actions/ci-release-assembly/README.md) | Release build manifest と owner 検証済み補助 handoff を照合し、provider-write-free に公開 handoff を組み立てます。 | Assemble verified Release assets without executing source or writing to a provider. |
| [`ci-release-publication-verifier`](actions/ci-release-publication-verifier/README.md) | GitHub Release の不在を観測し、owner write が返した receipt / readback を独立した read-only 観測と照合します。 | Observe Release absence and verify publication receipts against independent read-only remote observations. |
| [`ci-release-supplemental-asset`](actions/ci-release-supplemental-asset/README.md) | 固定 source checkout で、authority の config snapshot が選択した owner adapter を呼び出します。共通入力検証を持つ TypeScript / `node24` Action です。consumer に Node 準備・依存復元を要求しません。 | Invoke an authority-bound owner supplemental asset adapter using the v2 phase interface. |
| [`ci-release-authority`](actions/ci-release-authority/README.md) | 既存のowner公開要求・承認・固定source・snapshotを検証し、標準Releaseのauthorityを生成します。 | Verify owner-selected Release inputs and provenance and produce a read-only authority handoff for standard Rust Releases. |
| [`ci-release-publisher`](actions/ci-release-publisher/README.md) | 標準GitHub Releaseのcreate・asset upload・finalizeを提供する。 | Create, upload and finalize a new GitHub Release from an owner-approved handoff; independent verifier determines publication success. |

<!-- action-catalog:end -->

## 開発

保守手順と正本の所在は [DEVELOPMENT.md](DEVELOPMENT.md)、統合・E2E・Hosted受入の役割分担は[テスト戦略](docs/maintenance/test-strategy.md)を参照してください。移行元と切替時点の受入結果は [移行記録](docs/maintenance/migration-baseline.md) を参照してください。
