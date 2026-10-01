# Development

## 読む順序

1. `README.md`
2. `sdd/dsl/requirements/requirement-manifest.sdd.yml`
3. `sdd/dsl/designs/scopes/repository/logical-structure.sdd.yml`
4. `sdd/dsl/designs/global/physical-structure.sdd.yml`
5. `docs/maintenance/action-construction.md`
6. `docs/maintenance/test-strategy.md`
7. 対象の公開契約と実装

## SSOT

- repository Release version: `VERSION`
- 要求・観測可能な契約・設計境界: `sdd/`
- Action の公開 I/O: `actions/<action-name>/action.yml`
- canonical workflow source: `workflows/`
- 選択配布単位と依存閉包: `skills/ci-github/references/ci-distribution-assets.reference.yml`
- 選択配布manifest生成・取得・適用・復旧: `runtime/distribution/`
- 配置・検証処理: `runtime/`
- Agent Skill の起動条件と操作導線: `skills/ci-github/`
- repository保守用のproject-local Agent Skill: `.agents/skills/`
- このリポジトリ自身のCI: `.github/workflows/`

スキル文書へ workflow、Action、runtime の実装を複製しません。`workflows/` と `.github/workflows/` を相互の代替として扱いません。

`skills/ci-github/references/` は consumer へ配布する portable public contract です。project 内部の契約・検証の基準は `sdd/` とし、同一契約を変更する場合は SDD の subject / test-map と reference を同一変更単位で更新します。

## 依存グラフの扱い

`sdd/dsl/designs/scopes/repository/logical-structure.sdd.yml` の `dependencies` は、component 間で許可する実装依存の辺を表し、directed graph として非循環を維持します。canonical workflow や skill reference などの配布資産を検証・比較のために読み取る参照は、実装依存と区別し、循環を生む経路は依存辺として宣言しません。資産参照を依存として扱う必要が生じた場合は、先に component 分解を見直します。

## 選択配布のローカル検証

```sh
node --test runtime/distribution/tests/selective-distribution.test.mjs
```

Release assetの組立は`runtime/distribution/generate-distribution-release.ts`を使い、HEADと一致するfull commit SHAのGit objectだけを入力として、新規output directoryへmanifest、fetch CLI、checksumsを生成します。working treeの変更は配布byteへ混入しません。`.github/workflows/release.yml`はexact tagを検証して3 assetだけを公開し、remote byte readback成功後にmajor・minor aliasを更新します。

標準品質bundleの配置受入は、owner skill collectionをread-onlyで明示して実行します。未指定時はこの外部資材を必要とするケースだけskipし、通常のmaterializer契約検証は継続します。この受入は配置を確認し、projectの品質commandやHosted実行は行いません。

```sh
A3_CI_GITHUB_QUALITY_SKILL_ROOT=<owner-skill-collection-root> node --import ./runtime/preset/node_modules/tsx/dist/loader.mjs --test runtime/adapter/tests/standard-quality-footprint.test.mjs
```

## コミットゲート

コミット前のリポジトリ固有ゲートは `.agents/skills/commit-gate/` を正本とし、公開 Agent Skill `ci-github` の配備整合を確認します。配備先 root は環境変数で明示し、未設定時は配備整合ゲートを非適用とします。削除、prune、管理外 skill の削除は自動反映しません。

```sh
export A3_CI_GITHUB_SKILL_DEPLOY_ROOT=<external-skills-root>
python3 .agents/skills/commit-gate/scripts/check_staged_skill_deploy.py
```

## Action catalog

```sh
node runtime/repository/update-action-index.mjs --write
node runtime/repository/update-action-index.mjs --check
```

## 基本検証

```sh
node --test tests/action-index-gate.test.mjs
node --test tests/action-dist-gate.test.mjs
node --test runtime/github-toolchain/tests/verify-github-toolchain.test.mjs
node --test runtime/rust-release/tests/rust-release-scripts.test.mjs
node runtime/contract-subject-coverage.mjs --check
```

各 JavaScript / TypeScript Action の依存復元、test、lint、dist 同一性は対象 Action の `package.json` と `runtime/repository/check-action-dist.mjs` に従います。統合、ローカルE2E、Hosted E2Eの境界と追加コマンドは[テスト戦略](docs/maintenance/test-strategy.md)を参照してください。

## SDD検証（ローカル保守・リリース前受入）

CI runtime へ `a3-*` を持ち込まない方針のため、SDD 正本の検証はローカルまたは承認済み保守環境で workspace ルートから実行します。

```sh
a3-sdd sdd check --workspace-root . --format json
```

`root_layout_scan` と `owner_outcomes` を確認し、failure、未分類、対象0件を成功扱いにしません。`sdd/dsl/**/.a3-sdd` は生成状態であり、正本ツリーへ残しません。生成状態の配置は sdd-core の `definition-file-locations` に従います。

## 移行記録

移行元の revision と切替時点の受入結果は [移行記録](docs/maintenance/migration-baseline.md)、旧公開資産の保全条件は [README.md](README.md) を参照してください。
