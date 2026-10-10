# installer 保守

## 配置と正本

installer はこのリポジトリの機能として保守します。公開仕様と利用方法は `skills/installer/references/`、プロジェクトの保証と検証対応は `sdd/` を参照します。この文書はプロジェクト固有の配置・構築・検証方法だけを扱います。

| 資材 | 保守場所 |
| --- | --- |
| 候補組立、builder、実候補profile検証、OS処理 | `runtime/installer/src/` |
| ローカルCLI入口、配布生成 | `runtime/installer/cli.ts`、`run-installer.mjs`、`build-distribution.mjs` |
| Actionの入力・出力、runnerとの接続 | `actions/ci-release-supplemental-asset/src/` |
| provider回帰、Python計測設定 | `runtime/installer/tests/` |
| Action／CLI境界の統合テスト | `actions/ci-release-supplemental-asset/tests/` |
| 利用入口、portable public contract、製品宣言例 | `skills/installer/` |

公開例を入力にするテストは配布資産の検証として扱います。現在の native manifest template は builder・runtime・Action の共通回帰でも利用し、別の内部fixtureへ同じ定義を複製しません。内部専用の値・障害注入はテスト側で作ります。

公開ガイド・サンプルを変更するときは、[宣言とインストール先の標準配置](../../skills/installer/references/define-installer.guide.md#製品宣言の標準配置)、[製品READMEの記載範囲](../../skills/installer/references/use-standard-installer.guide.md#製品readmeへのインストール手順追記)、[標準比較の完了チェック](../../skills/installer/references/audit-installer-compliance.guide.md#標準比較の完了チェック)との参照整合を確認します。CI監査はinstaller ownerの返却結果を受け取り、同じ判断規則をCI側に複製しません。

## 実装方式

Windows installerの対応環境は、[標準installerの契約](../../sdd/dsl/specs/contract-core/subjects/ci-release-supplemental-asset/clauses.sdd.yml)に従いWindows PowerShell 5.1以降とし、PowerShell 7系への更新を必須にしません。OS処理は両環境で動く共通実装として保守し、Windows CIで5.1と7系の同じ安全性テストを実行します。

配布する`.ps1`はUTF-8 BOM付きで生成します。5.1が日本語などを含む配置先をシステムのANSI文字コードで誤読しないためです。ZIPの安全検査後の展開には.NET APIを使い、外部tarの文字コードで配置先が変わることを避けます。

入力固定とAction／CLI境界はTypeScriptです。候補組立とprofile検証はPython 3.11以上を使います。既存builderのarchive処理・source正規化・checksum・確定処理を同じPython processから利用でき、TypeScriptへ同じ処理を再実装せずに実候補を検証できるため、この部分を[Action構築方針](action-construction.md)の例外とします。Python runtimeに外部package依存はありません。新規の言語非依存な制御処理一般への例外ではありません。

ActionとCLIのPython payloadは同じ `src/` から生成します。利用側の製品宣言・manifest以外に共通実装・テストのGit管理を要求しません。runnerのPython、Git、OS toolchainの前提は [Action README](../../actions/ci-release-supplemental-asset/README.md) に従います。

共有入口の組立では、`assembly.py`が全native候補の証跡を照合した後、wrapper builderとdispatch検証へUnix候補だけを渡します。Windows候補は対象別assetとしてhandoffへ含めます。宣言の選択条件は[標準組立契約](../../skills/installer/references/installer-standard-assembly-contract.reference.yml)、保証は上記のSDD契約を参照します。

## 検証と生成

workspace rootで実行します。固定依存の復元は [DEVELOPMENT.md](../../DEVELOPMENT.md) に従います。

```sh
npm --prefix actions/ci-release-supplemental-asset run lint
npm --prefix actions/ci-release-supplemental-asset run build
npm test -- runtime/installer/tests/common-regression.test.mjs actions/ci-release-supplemental-asset/tests/
node tests/coverage-tools/contract-subject-coverage.mjs --check
npm test -- tests/contract-subject-execution.test.mjs
```

repository CIはLinuxの共有runtime検証から共通回帰を実行し、専用の `installer-windows` と `installer-macos` jobでnative runtimeを検証します。macOSはARM64を明示確認し、両jobで配布Action／CLIの候補生成と受入テストも実行します。全jobが `contract` 集約jobの成功条件に含まれます。workflowは `.github/workflows/quality-gate.yml` を参照してください。Windows／macOSの候補はGitHub artifactでLinuxの `installer-handoff` jobへ搬送し、生成元jobのsource identityと既存の整合性Actionで確認します。製品Releaseの公開・readbackは別受入です。候補からRelease handoffへの組立、複製後の整合性と破損拒否は既存assembler／verifierを使って検証します。

Vitestのprovider regressionはPythonの `unittest` に委譲し、組立profile、builderと利用可能なOS処理を実行します。provider内部の補助回帰として `tests/contract-subject-execution.json` のsource実行集合へ含め、Action出力保証へ直接算入しません。Actionの成功出力・拒否結果は supplemental Action のtest-mapに接続したAction境界のテストで観測します。OS固有のskipや模擬host labelはnative OSの成功証拠になりません。

TypeScript／JavaScriptのlintはrepositoryの `a3-lint.yaml` とActionの型検査に従います。Pythonには公開 `python` スキルが提供するルールを明示して実行します。`A3_SKILLS_ROOT` は導入済みのスキルrootに設定し、ルールをこのリポジトリへコピーしません。

```sh
a3-lint lint runtime/installer/src runtime/installer/tests --lang python --framework any --no-config \
  --add-rule-set-root "$A3_SKILLS_ROOT/python/assets/a3-lint/semantic-extension" \
  --add-rule-set-lib "$A3_SKILLS_ROOT/python/assets/a3-lint/shared" --format json
```

配布生成はAction bundle、CLI bundleと各Python／OS payloadを更新します。生成先の `dist/` を直接保守せず、source変更後に再生成します。公開スキルの配備だけではこの配布物は更新されません。

## Pythonソース計測

```sh
npm run test:coverage:installer
```

保守環境に `uv` とPythonが必要です。固定版coverage.pyを保守用の隔離環境で使い、runtime／consumerの依存には追加しません。`runtime/installer/tests/coverage.ini` がPythonソースと子プロセス計測を定め、runごとの `tests/tmp/coverage/installer/` にdataとJSONを保存します。未ロードのPython sourceも分母に含め、`dist/`・テスト・OS scriptはPython計測対象にしません。JS／TSソースは通常の `npm run test:coverage` で別に計測します。

Linux CIも同じ計測コマンドを実行し、JSONレポートをartifactとして保存します。Python計測値はOS scriptのカバレッジやWindows native実行を表しません。

このローカル検証は公開、配備、Hosted workflowや未実行OSの受入を代替しません。
