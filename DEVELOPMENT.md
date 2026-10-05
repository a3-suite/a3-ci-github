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
- canonical workflow sourceとAction binding: [preset registry](skills/ci-github/references/ci-github-preset-assets.reference.yml)
- 選択配布単位と依存閉包: `skills/ci-github/references/ci-distribution-assets.reference.yml`
- 選択配布manifest生成・取得・適用・復旧: `runtime/distribution/`
- 配置・検証処理: `runtime/`
- Agent Skill の起動条件と操作導線: `skills/`
- repository保守用のproject-local Agent Skill: `.agents/skills/`
- provider再利用calleeと、このリポジトリ自身のCI: `.github/workflows/`

スキル文書へ workflow、Action、runtime の実装を複製しません。適用先へ配置するcaller・request workflowのsourceは`workflows/`に置き、個々のcanonical sourceとbindingは上記registryを参照します。

`skills/ci-github/references/` と `skills/installer/references/` は consumer へ配布する portable public contract です。project 内部の契約・検証の基準は `sdd/` とし、同一契約を変更する場合は SDD の subject / test-map と reference を同一変更単位で更新します。

installer の実装・配布生成・テストは `runtime/installer/` で保守します。公開スキルの配備は実装の配布を代替しません。配置、言語の例外理由、検証と配布生成の手順は [installer 保守](docs/maintenance/installer-maintenance.md) を参照してください。

## 依存グラフの扱い

`sdd/dsl/designs/scopes/repository/logical-structure.sdd.yml` の `dependencies` は、component 間で許可する実装依存の辺を表し、directed graph として非循環を維持します。canonical workflow や skill reference などの配布資産を検証・比較のために読み取る参照は、実装依存と区別し、循環を生む経路は依存辺として宣言しません。資産参照を依存として扱う必要が生じた場合は、先に component 分解を見直します。

## 選択配布のローカル検証

```sh
npm test -- runtime/distribution/tests/selective-distribution.test.mjs
```

Release assetの組立は`runtime/distribution/generate-distribution-release.ts`を使い、HEADと一致するfull commit SHAのGit objectだけを入力として、新規output directoryへmanifest、fetch CLI、checksumsを生成します。working treeの変更は配布byteへ混入しません。`.github/workflows/release.yml`はexact tagを検証して3 assetだけを公開し、remote byte readback成功後にmajor・minor aliasを更新します。

標準品質bundleは言語ownerの固定Git objectから生成します。生成前にsource checkoutのoriginがowner repositoryへ対応することを確認します。生成物のmetadataが生成元repository、full revision、source path、digestを保持します。通常のbuildとconsumerは外部skill checkoutを必要としません。commandを生成物側で手書き更新しません。

```sh
node runtime/adapter/generate-standard-quality-bundles.mjs --source-root <owner-repository-root> --source-revision <full-owner-commit-sha>
node runtime/adapter/generate-standard-quality-bundles.mjs --source-root <owner-repository-root> --source-revision <full-owner-commit-sha> --check
npm test -- runtime/adapter/tests/standard-quality-footprint.test.mjs runtime/preset/tests/standard-quality-bundles.test.mjs
```

コピー0の受入は、consumerの固有設定・依存・lockを保存し、標準bindingだけを返すことを検証します。`A3_CI_GITHUB_QUALITY_SKILL_ROOT` を明示した場合はそのowner資材が不変であることも確認します。Hosted実行と正式版提供は別の受入です。

主品質workflowの実行本体は `.github/workflows/ci-quality.yml`、導入先のcallerは `workflows/quality/quality-gate.yml` が所有します。callerの明示inputをcalleeの環境変数へ接続し、preflightの固定source依存としてのみcalleeを配布します。consumerのworkflow directoryや管理asset lockへcalleeをコピーしません。callerの短いsummary jobは既存check identityを維持し、calleeの非成功を成功へ読み替えないために残します。正式refとHosted check-name互換性はローカル検証の成功だけで確定しません。

```sh
actionlint .github/workflows/ci-quality.yml
npm test -- tests/workflow-contracts.test.mjs
npm test -- runtime/preset/tests/reusable-quality-workflow.test.mjs
```

## コミットゲート

コミット前のリポジトリ固有ゲートは `.agents/skills/commit-gate/` を正本とし、`skills/` 配下の公開 Agent Skill の配備整合を確認します。配備先 root は環境変数で明示し、未設定時は配備整合ゲートを非適用とします。削除、prune、管理外 skill の削除は自動反映しません。

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
npm test -- tests/action-index-gate.test.mjs
npm test -- tests/action-dist-gate.test.mjs
npm test -- runtime/github-toolchain/tests/verify-github-toolchain.test.mjs
npm test -- runtime/rust-release/tests/rust-release-scripts.test.mjs
node tests/coverage-tools/contract-subject-coverage.mjs --check
npm ci --ignore-scripts --no-audit --no-fund
npm test -- tests/contract-subject-execution.test.mjs runtime/repository/tests/contract-coverage-aggregation.test.mjs
```

カバレッジの取得・集計・品質判定は元ソースのみを対象とします。`dist/` などの生成済み配布物のカバレッジは取得せず、ソースの計測値へ合算・読み替えもしません。配布物は動作と生成結果の同一性を検証します。

`tests/coverage-tools/` は契約対象別の実行・集計と元ソースの計測を担当し、テストrunnerは固定版Vitestへ委譲します。標準Istanbulで変換前に作った同じカウンタをVitestとNode子プロセス・workerに渡します。Vitestのファイル隔離が終わる前に結果を保存し、未ロード分も同じ分母の0件として集計します。異なるカウンタ一覧や変換失敗は測定エラーです。保守依存はconsumer配布runtime・presetへ追加せず、LCOVの関数数をC0へ読み替えません。

各 JavaScript / TypeScript Action の依存復元、test、lint、dist 同一性は対象 Action の `package.json` と `runtime/repository/check-action-dist.mjs` に従います。統合、ローカルE2E、Hosted E2Eの境界と追加コマンドは[テスト戦略](docs/maintenance/test-strategy.md)を参照してください。

## SDD検証（ローカル保守・リリース前受入）

CI runtime へ `a3-*` を持ち込まない方針のため、SDD 正本の検証はローカルまたは承認済み保守環境で workspace ルートから実行します。

```sh
a3-sdd sdd check --workspace-root . --format json
```

`root_layout_scan` と `owner_outcomes` を確認し、failure、未分類、対象0件を成功扱いにしません。`sdd/dsl/**/.a3-sdd` は生成状態であり、正本ツリーへ残しません。生成状態の配置は sdd-core の `definition-file-locations` に従います。

## 移行記録

移行元の revision と切替時点の受入結果は [移行記録](docs/maintenance/migration-baseline.md)、旧公開資産の保全条件は [README.md](README.md) を参照してください。

Vitestの依存は `npm ci --ignore-scripts --no-audit --no-fund`、計測依存は `npm --prefix tests/coverage-tools ci --ignore-scripts --no-audit --no-fund` で復元し、全体は `npm test`、ソース計測は `npm run test:coverage` で実行します。通常のテスト配置と契約参照は維持し、実装を持つAction entrypointはファイル名だけで除外しません。
