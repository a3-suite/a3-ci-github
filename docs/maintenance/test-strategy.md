# テスト戦略

## 目的

この文書は、`a3-ci-github` 固有のコンポーネントとテスト実行面の対応を示します。契約対象、検証観点、テスト参照の正本は `sdd/`、契約対象別の実行定義は `tests/contract-subject-execution.json` です。

## レベル境界

- 統合テストは、repository 内の実コンポーネントを接続し、外部サービスを fixture または test double に置き換えて契約を観測します。
- E2E テストは、公開 CLI、`action.yml`、または workflow trigger から利用者が観測する結果までを通します。
- YAML 構造テストやローカル Git fixture の成功を、GitHub Hosted runner 上の成功証拠として扱いません。
- 同じ保証を各 Action の E2E で重複させず、Action の局所契約は統合テスト、GitHub 固有の結合は代表 workflow の Hosted E2E で保証します。

## コンポーネント別の適用

| コンポーネント | 統合テスト | E2E |
| --- | --- | --- |
| Action | source、dist、entrypoint、公開 I/O、Composite と共有 runtime の接続 | quality、Release、package の代表 Hosted flow から実行 |
| canonical workflow | trigger、permissions、job、`needs`、trust、summary の宣言構造 | GitHub Hosted runner 上の代表 flow |
| preset runtime | registry、実 filesystem、lock digest、read-only、source root 分離 | 公開 CLI を別 process で起動する consumer flow |
| repository runtime | local bare Git、subprocess、成果物、失敗時の非破壊性 | stateful な Hosted delivery flow がある場合だけ追加 |
| installer runtime | 同一プロセスで検証できる内部連携 | 実installer・配布Action／CLIのプロセス起動を伴う標準installerテストとPython provider回帰はE2Eとして実行し、単体＋統合の計測には含めない。Linux共通回帰、Windows・macOS ARM64 native回帰はrepository CI。Release handoffの組立・整合性・破損拒否も検証。Windows／macOSからLinuxへのartifact搬送は整合性Actionで確認。製品の公開・readbackは別受入 |
| a3-lint rule | 実 a3-lint runtime に対する正常、違反、誤検知 fixture | repository lint の受入実行を smoke とし、rule ごとの E2E は作らない |
| SDD・契約実行定義 | owner validator、route、test map、path、subject 集合 | 公開利用フローではないため原則追加しない |
| Skill・文書 | reference、catalog、command、リンクの整合 | エージェント応答を不安定な E2E として固定しない |

Actionの入口テストは同じ観点を`source`と`dist`のsuiteで実行します。保守用の`tests/support/action-entrypoint.ts`が既存のAction開発依存からソース実行用loaderを解決します。ソース計測は`src/index.ts`と共有runtimeの分岐を対象とし、`dist`の成功をソースのhitへ読み替えません。配布物の動作確認とソースの未カバー分析を別々に維持します。

## 自動化済み E2E

`tests/public-cli-lifecycle.test.mjs` は、外部サービスを使わず、次の公開 process 境界を検証します。

1. 適用済み preset に対する asset lock 生成
2. 固定 runtime bootstrap 経由の read-only preset 検証
3. consumer tree が検証で変更されないこと
4. adapter bundle の新規配置、同一内容の再利用、競合時の非上書き

preset assurance と adapter materialization は異なる責務です。同じテストファイルで実行しても、独立した `flow_id` と契約対象へ写像します。

## Hosted E2E

固定参照先のローカル動作検証は `npm run lint:provider` で実行します。参照先Git objectの`dist`を使うため、作業ツリーのsource/dist検証とは別の証拠です。対象はquality adapterの標準ID拒否とpublication controlのowner decision必須条件、および各正常経路です。入力fixtureはAction entrypoint回帰と共有し、`tests/workflow-contracts.test.mjs`の旧参照・準備/接続判定・更新処理の回帰へ接続しています。対象SHAのHosted E2Eを代替する証拠にはしません。

Hosted E2E は、外部 repository への書き込みや公開を暗黙に行いません。

提供元はcallerの生成、固定参照、caller/callee契約を検証してから配布を公開します。Release manifestは配布同一性と固定参照を記録し、Hosted実呼出しの受入証拠は含めません。Hosted invocationは公開前提ではなく、導入先の設定・認証・required checkと下表の異常系・製品固有条件の受入は、導入後に生成済みcallerで行い、別の受入記録へ残します。run成功だけから網羅性を推測しません。責務境界の正本は`contract.ci-selective-distribution.publication`です。

| Flow | 実行時期 | 必須観測 |
| --- | --- | --- |
| Quality | Git 初期化後の通常 CI | push、same-repository PR、fork PR、docs-only、失敗summary、optional platform |
| Release | Release 公開前の明示受入 | annotated tag、request handoff、source identity、artifact handoff、alias readback |
| Package | 公開前の明示受入 | publication request、preparation handoff、承認済み test target |

Quality 以外は専用 fixture repository または承認済み test target を使用します。Production Release、production registry、公開 alias を通常の PR テストから更新しません。

Hosted検証では、本番のAPI取得条件（ページサイズを含む）、token種別、workflow権限に合わせます。異常系のために条件を変える場合は、その差分と検証範囲を記録します。実行前に、変更が影響するローカル検査を済ませ、配布物と固定参照の確認は [Action構築方針の検証手順](action-construction.md#検証と公開前状態) に従います。

## 実行

固定 runtime の依存を復元した後、ローカル E2E を実行します。

```sh
npm --prefix runtime/preset ci --no-audit --no-fund
CI_GITHUB_PREFLIGHT_RUNTIME_ROOT=runtime/preset \
  npm test -- tests/public-cli-lifecycle.test.mjs
```

契約対象別定義を検証します。

```sh
npm --prefix tests/coverage-tools ci --ignore-scripts --no-audit --no-fund
node tests/coverage-tools/contract-subject-coverage.mjs --check
npm test -- tests/contract-subject-execution.test.mjs runtime/repository/tests/contract-coverage-aggregation.test.mjs
```

SDD 正本は CI runtime へ `a3-*` を持ち込まず、ローカル保守・リリース前受入として workspace ルートから検証します。手順と生成状態の扱いは [DEVELOPMENT.md](../../DEVELOPMENT.md) を参照してください。

```sh
a3-sdd sdd check --workspace-root . --format json
```

a3-lint rule の実行回帰は、a3-lint 自体を workflow runtime 依存にせず、導入済みの固定版を明示して実行します。

```sh
A3_LINT_BIN="$(command -v a3-lint)" node tests/a3-lint-rule-regression.mjs
```

この回帰は各 rule について正常、代表違反、対象外または誤検知防止の3ケースを実 a3-lint runtime で検査します。

## 実行環境の選定

`.github/workflows/quality-gate.yml` の runner と toolchain は、[OS・版の選定と廃止判断](../../skills/ci-github/references/workflow-version-policy.reference.md#os-version-selection)に従って選びます。利用者が用意する platform は検証の見本で、それ以外は保守用の道具です。

| 対象 | 区分 | 選定 | 理由 |
| --- | --- | --- | --- |
| ubuntu-24.04（契約検査） | 道具 | 代表OS | OSに依存しない検査を最速・最安で実行する |
| ubuntu-24.04、macos-15、windows-2025（installer） | platform | installer の3対象 platform に1対1 | ubuntu-22.04 は廃止開始、macos-14 は 2026-11-02 に support 終了のため除外。windows-2022 は条件を満たすが、検証する PowerShell 5.1 は両版にあり差が効かず、次に廃止される版なので 2025 とする |
| Windows PowerShell 5.1、PowerShell 7 | platform | 宣言の下限と現行系 | 5.1 以上を宣言している |
| Python 3.11 | platform | 宣言の下限 | 3.10 は 2026-10 に EOL。3.11 の support は 2027-10 まで |
| Node 24 | platform | 最古の互換版 | Action は `node24` で動き、engines の下限も 24 |
| Node の patch、uv、jq、GitHub CLI、cargo-audit、cargo-deny、Action の SHA | 道具 | dependency-selection の版選定（公開待機期間を含む） | patch まで固定し、更新は意図して行う |

各 release 時と、提供元が廃止・EOL を告知した時に見直します。

### CI資材の採用記録

道具に区分した版の選定記録です。適用した公開待機期間は dependency-selection の標準の7日です。公開日時は各 GitHub Release、採用日時はその値が `.github/workflows/`、`actions/`、registry に初めて現れた commit です。確認日時は 2026-10-17（jq、GitHub CLI、setup-node、upload-artifact、download-artifact、setup-uv、uv は 2026-10-20）です。版を更新したときは、この表の該当行を書き換えます。

| 対象 | 版 | 公開日時（UTC） | 採用 commit・日時（JST） | 待機期間 |
| --- | --- | --- | --- | --- |
| actions/checkout | v7.0.1（`3d3c42e5`） | 2026-07-20 15:10 | 703133c 2026-09-28 | 満たす |
| actions/setup-node | v7.1.0（`949feb24`） | 2026-10-08 02:52 | このcommit 2026-10-20 | 満たす |
| actions/setup-python | v7.0.0（`5fda3b95`） | 2026-07-20 03:15 | e66d02a 2026-10-01 | 満たす |
| astral-sh/setup-uv | v10.3.0（`1c37ad07`） | 2026-10-09 20:41 | このcommit 2026-10-20 | 満たす |
| actions/upload-artifact | v7.0.2（`cf430e03`） | 2026-10-07 10:08 | このcommit 2026-10-20 | 満たす |
| actions/download-artifact | v8.0.2（`9000827c`） | 2026-10-07 10:09 | このcommit 2026-10-20 | 満たす |
| Node | 24.21.0 | 2026-09-08 21:51 | 4b694d0 2026-10-03 | 満たす |
| uv | 0.13.0 | 2026-10-09 19:49 | このcommit 2026-10-20 | 満たす |
| jq | 1.8.2 | 2026-06-20 14:11 | このcommit 2026-10-20 | 満たす |
| GitHub CLI | 2.102.0 | 2026-09-30 02:40 | このcommit 2026-10-20 | 満たす |
| cargo-audit | 0.22.2 | 2026-06-05 12:38 | ca6d0d4 2026-10-14 | 満たす |
| cargo-deny | 0.20.2 | 2026-07-09 17:58 | このcommit 2026-10-21 | 満たす |

## 追加判断

新しいE2Eは、統合テストでは観測できない公開経路がある場合だけ追加します。追加前に、owner contract、`flow_id`、外部副作用、実行頻度、fixtureの後処理を確定します。

リポジトリ保守テストのrunnerはルートのVitest設定です。契約対象別実行定義のテスト参照とレベル境界は維持します。カバレッジ除外は `vitest.config.mjs` と契約対象別実行定義で管理します。カバレッジ取得は保守専用の標準Istanbul計測をVitestへ接続し、子プロセス・workerも同じカウンタで集計します。標準V8 providerのautoAttachSubprocessは未実行関数の誤計数を再現したため採用しません。

`npm test` はE2Eを含む通常のテスト集合を実行します。`npm run test:coverage` は同じ集合から契約対象別実行定義のE2Eを分離し、unit/integrationと契約対象外のリポジトリ保守テストをソース計測へ含めます。同じファイルをE2Eと計測対象レベルへ重複登録した場合は、ファイル単位で分離できないため計測を停止します。

テストファイルを追加・削除した場合は、`tests/contract-subject-execution.test.mjs` で、保守テストの包含と実行定義に基づくE2Eの除外をローカルで確認します。件数を固定せず、収集集合からE2Eを除いた集合と計測対象集合の一致を検証します。

上記のIstanbul計測はJavaScript／TypeScriptソースだけを測ります。installer の Python ソースは `npm run test:coverage:installer` で子プロセスを含めて別計測します。Python の statement／branch と JS／TS の C0／C1 は合算しません。対象・実行前提・証跡は [installer 保守](installer-maintenance.md) を参照してください。
