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

Hosted E2E は、外部 repository への書き込みや公開を暗黙に行いません。

| Flow | 実行時期 | 必須観測 |
| --- | --- | --- |
| Quality | Git 初期化後の通常 CI | push、same-repository PR、fork PR、docs-only、失敗summary、optional platform |
| Release | Release 公開前の明示受入 | annotated tag、request handoff、source identity、artifact handoff、alias readback |
| Package | 公開前の明示受入 | publication request、preparation handoff、承認済み test target |

Quality 以外は専用 fixture repository または承認済み test target を使用します。Production Release、production registry、公開 alias を通常の PR テストから更新しません。

## 実行

固定 runtime の依存を復元した後、ローカル E2E を実行します。

```sh
npm --prefix runtime/preset ci --no-audit --no-fund
CI_GITHUB_PREFLIGHT_RUNTIME_ROOT=runtime/preset \
  npm test -- tests/public-cli-lifecycle.test.mjs
```

契約対象別定義を検証します。

```sh
node tests/coverage-tools/contract-subject-coverage.mjs --check
npm test -- tests/contract-subject-execution.test.mjs
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

## 追加判断

新しいE2Eは、統合テストでは観測できない公開経路がある場合だけ追加します。追加前に、owner contract、`flow_id`、外部副作用、実行頻度、fixtureの後処理を確定します。

リポジトリ保守テストのrunnerはルートのVitest設定です。契約対象別実行定義のテスト参照とレベル境界は維持します。カバレッジ除外は `vitest.config.mjs` と契約対象別実行定義で管理します。カバレッジ取得は保守専用の標準Istanbul計測をVitestへ接続し、子プロセス・workerも同じカウンタで集計します。標準V8 providerのautoAttachSubprocessは未実行関数の誤計数を再現したため採用しません。
