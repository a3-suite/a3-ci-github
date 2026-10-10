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

## 固定参照の更新順序

このrepositoryでは、Action実装、providerの再利用workflow、consumerへ配置するcallerを別の固定参照として扱います。公開refと利用可能条件の正本はpreset registryです。

以下は外部の固定SHAを使う接続の更新順序です。repository自身のCIで使う`uses: ./actions/...`は同一checkoutの検証であり、Actionと検証用workflowを同じコミットで更新できます。

通常リリースとhotfixの公開単位、実装SHAの包含・同一性、公開前の接続保証は、[publication契約](../../sdd/dsl/specs/contract-core/subjects/ci-selective-distribution/clauses.sdd.yml)の`selective-distribution-publication-intent`を正本とします。公開を1回にまとめる準備順序は次のとおりです。

1. **実装コミットAを確定する。** 対象版のVERSION、Action、共有runtime、生成物と依存を揃え、source検証とdist同一性を確認してコミットします。この段階で別Releaseを公開しません。
2. **接続コミットBを作る。** Aの確定済みfull SHAへcanonical workflow、provider callee、installer revisionとregistryのAction bindingを揃えます。接続とその検証以外で実行資材を変えた場合は、実装コミットの確定からやり直します。
3. **最終候補を検証する。** Bと実際の参照先Aを使ってpublication契約を確認します。callee自身のSHAはmanifest生成で解決し、sourceへ将来の自己SHAを書き戻しません。third-party Actionの承認pinは従来どおり検証します。
4. **Bを1回だけ公開する。** 承認済みannotated exact tagとReleaseをBに作成し、配布資材のreadbackまで確認します。consumerはそのReleaseからcallerを生成して環境を受け入れます。

準備コミット数と公開回数は別です。ActionのSHAと最終tagのpeeled SHAの一致は要求せず、正本の包含・同一性を確認します。rebaseやsquashで参照先が変わる、または実行資材が変わる場合は接続・検証を確定し直します。

接続の更新には、対象版の`RELEASE_TAG`と確定済みAの`IMPLEMENTATION_SHA`を明示します。事前のtag・Releaseは不要です。

```sh
node runtime/repository/update-action-references.mjs --check --tag "$RELEASE_TAG" --implementation-sha "$IMPLEMENTATION_SHA"
node runtime/repository/update-action-references.mjs --write --tag "$RELEASE_TAG" --implementation-sha "$IMPLEMENTATION_SHA"
node runtime/repository/check-provider-references.mjs --candidate --contracts
```

`--check`は変更予定を出力し、差分があれば1、差分がなければ0、検査不能なら2で終了します。差分と接続検査の結果を確認してから`--write`を実行します。staged snapshotの最終候補は`--staged --candidate --contracts`で検査します。参照Actionのmetadataが宣言するNode entrypointとCompositeの固定scriptの存在を確認し、参照するActionディレクトリ全体と共有`runtime/`のGit treeでバイト列とmodeの一致を確認します。この範囲に変更があればAを確定し直します。

Bにannotated exact tagを作成した後、そのtagのcheckoutで公開検査を実行します。

```sh
node runtime/repository/check-provider-references.mjs --contracts --release-tag "$RELEASE_TAG"
```

Release workflowはこの公開検査が成功した後だけ資材を生成します。検査JSONとworkflowの結果要約に`implementationSourceRevision`と`implementationBindingStatus`を残します。引数なしの既存参照検査はregistryが宣言するtagを確認する保守用入口であり、今回の公開検査には使いません。

固定参照の実体・I/O・実dist動作を検証する既存ゲートは維持します。必要なGit objectの欠落や実行不能は判定不能とし、別checkoutの成功やSHA形式だけを接続先の動作保証に読み替えません。Hosted受入は別の証拠です。

公開後の配布物・Skill配備までの確認は[Release手順](../release/README.md#公開後の整合確認)、コミット時の判定は[リポジトリ固有ゲート](../../.agents/skills/commit-gate/references/run-repository-commit-gates.guide.md#固定参照更新順序ゲート)を参照してください。

### 再利用workflowの公開と導入後受入

公開前の生成・固定参照・接続契約の検証と、導入先のHosted環境受入の責務は[Release手順](../release/README.md#Release公開と利用側受入の順序)が参照する配布契約に従います。公開workflowは既存の生成回帰を実行します。導入先では通常のfetch・plan・applyでcallerを生成し、製品設定・認証・required checkを受け入れます。

Hosted実行・環境への書き込み・試験公開・Release公開は、ローカル修正とは別の承認工程です。実行した経路とSHA、run URL、条件と結果を記録し、ローカル検証や生成成功をHosted成功へ読み替えません。Hostedでの代表検証は[テスト戦略](test-strategy.md)に従います。

## runtime の利用形態

`runtime/` の配置だけで実行前提を一律に決めません。

| 利用形態 | このリポジトリでの扱い |
| --- | --- |
| Action に組み込む共有処理 | 新規・今回整備する本体は TypeScript を標準とし、Action の strict 型検査へ含めます。薄い wrapper と `.d.mts` だけで本体の検証を代替しません。consumer の Node 準備・依存復元は不要です。 |
| consumer が直接実行する CLI / script | 対応 Node、依存復元、起動方法、配布閉包は対象の公開契約・package に従います。Action の `node24` 所有と混同しません。 |
| repository の保守・検証ツール | 開発環境と既存 gate に従い、`.mjs` を許容します。consumer 用の制約を一律に適用しません。 |

既存 `.mjs` の全面移行は要求しません。release-publication の JSON 形式は `runtime/release-publication/evidence.schema.json` を正本とし、実装型の witness と required field の回帰を `runtime/release-publication/tests/schema.test.ts` で確認します。

installer の候補組立・実候補検証は既存 Python builder と一体で保守する例外です。Node の入力・出力境界は TypeScript 標準に従います。例外理由、追加実行前提と同等の検証は [installer 保守](installer-maintenance.md) を参照してください。

`ci-github-workflow-no-a3-cli` は consumer の workflow、既存 `ci-github-runtime-no-a3-cli` は `.ci/` 内の対応 JS/TS script を対象にします。repository の保守用 CLI 実行まで禁止する規則ではありません。対象範囲・検出パターンは rule asset が所有します。

## Action lint

`lint-rules/a3-lint/`は導入先へ配布する共通ルール、`lint-rules/repository/`は配布しないrepository構築規約です。repository専用の`ci-github-action-runtime-contract` は `actions/<id>/action.yml` / `action.yaml` の block／flow mapping を対象に、許可 runtime と Node entrypoint を検査します。Composite の run 先頭にある `node` / `exec node` は方式レビューの警告です。間接呼び出しや一般的な shell 構文の網羅解析、処理責務からの方式推測は行いません。YAML構造はproviderの`fact:yaml_structure:v1`を必須とし、shared helperで所属を参照します。欠落・非対応の観測を正常な空結果へ変換しません。

検査対象に応じて `a3-lint.repository.yaml` のrule setを明示して選択します。導入先のworkflowは`skill-ci-github`、provider calleeは`provider-workflows`、自己workflowは`repository-workflows`、Action metadataの構築規約は`repository-actions`です。provider/自己workflowへconsumerのname・inline script配置制約をそのまま適用しません。providerの`inputs.runner`はowner callerから受け取る契約であり、入力の静的・versioned制約は既存preflightが所有します。公開consumerのrunner規則は維持し、品質・公開callerの不正runner拒否回帰と、`tests/workflow-contracts.test.mjs` の全provider jobのrunner接続回帰をprovider profileの確認にも含めます。後者は既存の固定値・`inputs.runner`・所定の`matrix.runner`経路を確認し、GitHub入力への直接置換や危険なjobの追加を拒否します。これを任意callerや未受入calleeの安全性証明には使いません。

```sh
a3-lint lint .github/workflows/ci-quality.yml .github/workflows/ci-quality-platforms.yml .github/workflows/ci-package-preparation.yml .github/workflows/ci-release-publication.yml .github/workflows/ci-package-publication.yml --config a3-lint.repository.yaml --lang yaml --framework any --only-rule-set provider-workflows
a3-lint lint .github/workflows/quality-gate.yml .github/workflows/release.yml --config a3-lint.repository.yaml --lang yaml --framework any --only-rule-set repository-workflows
a3-lint lint actions --config a3-lint.repository.yaml --lang yaml --framework any --only-rule-set repository-actions
```

検査は `a3-lint.repository.yaml` から選択し、正常・違反・誤検知防止は `tests/a3-lint-rule-regression.mjs` で実 a3-lint に対して確認します。package / 配布物 / テストの存在や dist 同一性は lint に重複実装せず、既存 repository gate が所有します。

`a3-lint.repository.yaml` は外部 Skill・`A3_SKILLS_ROOT` を必要としません。言語・Vitest の外部 Skill 検査は `a3-lint.yaml` に分離します。`npm run lint:repository` は3つの構築用profile、Lua規則回帰、provider runner接続を含むworkflow契約回帰を順に実行します。ローカル検証は `A3_LINT_BIN=/absolute/path/to/a3-lint npm run lint:repository` で利用可能なCLIを明示して実行します。未指定ならPATH上の `a3-lint` を使います。版番号を固定せず、各profileの能力必須宣言と実CLI回帰で必要な能力・検証結果を確認します。自己CIはregistryの対象版がVERSIONと一致する接続候補では事前tag不要の候補検査、それ以外の実装準備では既存参照検査を行い、Release資材生成前は最終tagの公開検査とworkflow契約回帰を実行し、外部CLIの未公開能力に依存させません。公開版a3-lintによるLua規則のCI検証は、必要能力を持つ公開版の実体とchecksumを確認した後に別途接続します。設定と実行scriptは非配布のrepository保守資材であり、provider callee・consumer runtimeへ組み込みません。

内部依存は `runtime/repository/check-runtime-boundaries.mjs` を source verification gate から実行します。既存の固定版 TypeScript compiler で Action entrypoint から到達する local source の静的 import、reexport、literal dynamic import、直接の literal require を解決し、別 Action の内部 source への実装依存、runtime から Action への逆依存、runtime 内の実装循環を拒否します。type-only import、テスト・保守 CLI の独立 entrypoint、任意の動的 module 名の網羅解析は対象外です。正常・違反・誤検知防止は `tests/runtime-boundaries.test.mjs` で検証します。

## 検証と公開前状態

provider固定参照の保守用入口は`npm run lint:provider`です。接続候補とRelease資材生成前には、固定参照の更新順序に記載した検査を使います。全provider callee、自己workflow、Composite Actionの外部参照を列挙してからfull SHAとprovider pin承認を検査し、診断または解析失敗で停止します。consumer canonicalの置換用placeholderをprovider実装の未解決参照と混同しません。Action I/O・権限・配布閉包は既存preflightへ委譲します。

1. SDD の subject、observation、guarantee、verification、test map と契約対象別実行定義を接続。
2. 型検査、処理の正常系・停止条件、公開 entrypoint の出力と失敗伝播を検証。
3. `runtime/repository/verify-action-packages.mjs` で標準 package 構成、Action の source 検証と公開 CLI の strict 型検査を確認。CLI の対象は `tsconfig.cli.json` とし、復元済み Action の compiler・Node 型定義を再利用する。
4. `runtime/repository/check-action-dist.mjs` で配布物再生成・一致を確認。
5. workflow を変更した場合は canonical mapping・registry・preflight・配布閉包も確認。

Hosted runner / 実 provider の検証は [テスト戦略](test-strategy.md) の受入境界に従います。ローカル成功を Hosted 成功へ読み替えません。

実装が存在するだけでは公開済み Action と扱いません。公開前の候補検証とconsumerが採用できる公開状態を区別し、publication契約を満たした単一Releaseから導入します。既存の公開SHAに新Actionが存在するように装いません。公開操作は実装・ローカル検証と別の承認で行います。
