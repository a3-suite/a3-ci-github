# CI スクリプトカタログ

## 理解できること
- a3-ci-github repository が配布する workflow 内スクリプト
- workflow 外で使う補助スクリプト
- 実行時パスと出力契約
- script ユースケースと処理契約に対応する具体 asset

## 本文

この文書は処理契約の意味を定義せず、`ci-script-use-cases.reference.yml` と `ci-script-contracts.reference.yml` で確定した処理を、共通 asset inventory と選択した provider registry に従って使用方法、配置手順、実行例へ写像するカタログである。共通 asset の ID、kind、status、scope、owner、source/entrypoints、copyability は `ci-script-assets.reference.yml`、provider 固有 asset は provider registry だけが所有し、この文書では再定義しない。`copyable: false` の skill script は導入先へコピーせず、スキル側で実行する。
### 実行前提
- 再利用 asset の runtime と toolchain は、選択した asset または provider の公開契約に従って固定する。project-owned 実装は project の実行基盤に従う。
- project rootで実行し、CI runtime境界は`references/ci-runtime-boundary.reference.md`に従う。
- 実行前提を満たせない場合は、追加buildを既定化せずprojectの実行方式を再検討する。
- asset を project へ配置する準備時だけ、`references/ci-script-assets.reference.yml` の `pathResolution.repositorySource` または `pathResolution.externalSkillSource` が示す配布元 source path を参照する。

### 配置単位
- registry の `actionization` に対応する共通処理は、固定 SHA の provider Action binding から実行し、entrypoint や helper を `.ci/scripts/` に配置しない。
- Action 化 target がない `copyable: true` の registry asset を使う場合だけ、inventory で選択した entrypoint と、その entrypoint が直接参照する helper を `.ci/scripts/` に配置する。共有補助モジュールは直接実行しないが、entrypoint と同じディレクトリに配置する。
- provider 固有の workflow、output、summary、artifact の接続方法は、選択した provider 固有スキルの catalog が所有する。
- output を生成する entrypoint は明示した output path へ書き込み、path を省略した場合は stdout へ出力する。provider adapter は自分の output または summary sink の path を引数で渡す。

### ワークフロー内で使用するスクリプト
共通処理のうち、変更範囲、quality adapter 実行、設定 snapshot、結果 summary、handoff integrity、release notes binding、version materialization、Vitest summary は、選択した provider 固有スキルの Action binding が提供する。Action または外部再利用単位の入力・出力・停止条件は provider registry と提供元の公開契約を参照し、Action 化された共通 script を project へコピーしない。

### adapter bundle materializer（skill script）
- 適用条件・取得・実行手順: `distribute-ci-assets.guide.md` と `configure-ci-preset.guide.md` の materializer 手順を参照する。
- 実行時パス: `ci-script-assets.reference.yml` inventory の `ci-adapter-bundle-materializer` の `source`
- 入出力・衝突時の扱い・配置境界: `ci-adapter-bundles.reference.yml` の `materialization` と `copyContract` を参照する。

### ワークフロー外で使用するスクリプト
- テスト結果解析（Vitest）: `runtime/adapter/vitest-test-summary.ts`
  - ユースケース: workflow 外でアーティファクトの Vitest JSON を簡易要約する。
  - 入力: `--log` でJSONレポートを指定し、必要に応じて `--name` で表のテスト単位名を指定する。
  - サマリ形式: `references/ci-summary-format.reference.md`
  - 位置づけ: workflow 外でのアーティファクト解析用。CI workflow runtime との境界は `references/ci-runtime-boundary.reference.md` に従う。

### 関連
- `references/ci-runtime-boundary.reference.md`
