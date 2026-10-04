# Action 構築方針

## 目的と正本

この文書は `a3-ci-github` 固有の方式選択と検証導線を定めます。一般的な Action の構築・安全性・公開規則は `github-actions` スキルを参照し、ここへ転記しません。

- 要求・保証・構造境界: `sdd/`
- 公開 I/O・runtime・entrypoint: 各 `actions/<id>/action.yml`
- workflow 接続・公開 ref・利用可能性: `skills/ci-github/references/ci-github-preset-assets.reference.yml`
- テスト実行単位: `tests/contract-subject-execution.json`

## 方式選択

| 処理 | 標準方式 | 理由 |
| --- | --- | --- |
| 言語非依存の共通検証・制御・入出力変換 | TypeScript、`runs.using: node24`、bundle 済み `dist/index.js` | consumer に Node 準備・依存復元・共通 runtime の配置を要求しない |
| 言語・OS固有の既存 script / toolchain の結線 | Composite | build 基盤や既存 script の実行境界を維持する |

Node で実装した共通処理を、bundle 作成を省くためだけに Composite から runner の `node` で起動しません。同じ責務の既存 Action と、実行方式・runtime 所有者・配布物・失敗出力・検証経路を比較してから方式を決定します。

標準方式と異なる場合は、Action README に必要性、consumer の追加前提、同等の検証方法を記載します。方式の異なる既存 Action が存在することだけを採用理由にしません。

## 配置と接続

共有処理は既存の `runtime/` 責務へ配置し、TypeScript Action の bundle に含めます。各 Action に同じ source を複製しません。Action 固有の input mapping、credential の受け取り、output mapping、終了状態の設定は `src/index.ts` に置きます。共有処理は入力・client・必要な decoder を引数で受け取り、結果を返します。

共有処理から Action の内部 source へ逆依存しません。Action も別 Action の内部 source へ実装依存せず、共有処理は `runtime/` から利用します。platform の意味検証は既存の `runtime/platform/` を利用し、YAML decoder は既存の `yaml` 依存を持つ Action から渡します。共有 package を追加して解決しません。

各 bundled Action は既存 package と同じ構成を用います。

- `package.json`、`package-lock.json`、`tsconfig.json`
- `src/index.ts`、bundle 済み `dist/index.js`
- `tests/*.test.ts`、`README.md`、`action.yml`
- `build` は既存の ncc 経路、`lint` は `tsc --noEmit`

新しい依存を足す前に、既存の runtime・標準ライブラリ・固定された toolchain で目的を満たせるか確認します。package manager の変更を Action 追加へ混在させません。

workflow は job・permissions・credential 注入・stage 順序を所有します。Action は project policy や credential route を選択しません。provider-write-free Action の中に publish write を混在させません。

## runtime の利用形態

`runtime/` の配置だけで実行前提を一律に決めません。

| 利用形態 | このリポジトリでの扱い |
| --- | --- |
| Action に組み込む共有処理 | 新規・今回整備する本体は TypeScript を標準とし、Action の strict 型検査へ含めます。薄い wrapper と `.d.mts` だけで本体の検証を代替しません。consumer の Node 準備・依存復元は不要です。 |
| consumer が直接実行する CLI / script | 対応 Node、依存復元、起動方法、配布閉包は対象の公開契約・package に従います。Action の `node24` 所有と混同しません。 |
| repository の保守・検証ツール | 開発環境と既存 gate に従い、`.mjs` を許容します。consumer 用の制約を一律に適用しません。 |

既存 `.mjs` の全面移行は要求しません。release-publication の JSON 形式は `runtime/release-publication/evidence.schema.json` を正本とし、実装型の witness と required field の回帰を `runtime/release-publication/tests/schema.test.ts` で確認します。

既存 `ci-github-runtime-no-a3-cli` の対象は consumer の workflow と `.ci/` 内の対応 script です。repository の保守用 CLI 実行まで禁止する規則ではありません。対象範囲・検出パターンは rule asset が所有します。

## Action lint

`ci-github-action-runtime-contract` は `actions/<id>/action.yml` / `action.yaml` の block mapping を対象に、許可 runtime と Node entrypoint を検査します。Composite の run 先頭にある `node` / `exec node` は方式レビューの警告です。間接呼び出しや一般的な shell 構文の網羅解析、処理責務からの方式推測は行いません。flow mapping の runs は未検査として警告し、検査済みと扱いません。

検査は `a3-lint.yaml` から選択し、正常・違反・誤検知防止は `tests/a3-lint-rule-regression.mjs` で実 a3-lint に対して確認します。package / 配布物 / テストの存在や dist 同一性は lint に重複実装せず、既存 repository gate が所有します。

内部依存は `runtime/repository/check-runtime-boundaries.mjs` を source verification gate から実行します。既存の固定版 TypeScript compiler で Action entrypoint から到達する local source の静的 import、reexport、literal dynamic import、直接の literal require を解決し、別 Action の内部 source への実装依存、runtime から Action への逆依存、runtime 内の実装循環を拒否します。type-only import、テスト・保守 CLI の独立 entrypoint、任意の動的 module 名の網羅解析は対象外です。正常・違反・誤検知防止は `tests/runtime-boundaries.test.mjs` で検証します。

## 検証と公開前状態

1. SDD の subject、observation、guarantee、verification、test map と契約対象別実行定義を接続。
2. 型検査、処理の正常系・停止条件、公開 entrypoint の出力と失敗伝播を検証。
3. `runtime/repository/verify-action-packages.mjs` で標準 package 構成と source 検証を確認。
4. `runtime/repository/check-action-dist.mjs` で配布物再生成・一致を確認。
5. workflow を変更した場合は canonical mapping・registry・preflight・配布閉包も確認。

Hosted runner / 実 provider の検証は [テスト戦略](test-strategy.md) の受入境界に従います。ローカル成功を Hosted 成功へ読み替えません。

実装が存在するだけでは公開済み Action と扱いません。未公開の Action は registry で pending とし、公開済み exact ref が確定するまで導入を fail-closed にします。既存の公開 SHA に新 Action が存在するように装いません。公開操作は実装・ローカル検証と別の承認で行います。
