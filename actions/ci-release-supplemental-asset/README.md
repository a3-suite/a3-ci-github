# ci-release-supplemental-asset

固定 source checkout で、authority の config snapshot が選択した owner adapter を呼び出します。共通入力検証を持つ TypeScript / `node24` Action です。consumer に Node 準備・依存復元を要求しません。既存 v2 呼出しと同じ Git・Bash 環境を利用し、shebang と引数 vector を維持します。入力はコマンド文字列へ埋め込みません。Windows は caller が用意した Git Bash を利用します。

## 入出力

`operation` は `build-platform` または `assemble`。`authority-path`、`snapshot-path`、`standard-build-root`、`output-directory` は必須です。`source-root` は既定で `.`。残りの path はすべて source-root からの相対パスで、NUL・改行・遡り・symlink を拒否します。`supplemental-build-root` は assemble の場合だけ必須です。

adapter は snapshot の `CI_SUPPLEMENTAL_RELEASE_ASSET_ADAPTER` から解決します。独立した command override はありません。選択、publication contract、owner contract ID、snapshot digest、authority の source SHA と checkout HEAD、実行可能 adapter の bytes と固定 source の Git blob の一致、入力 directory、出力の不在・非重複を実行前に検証します。

[外部 CI 契約](../../skills/ci-github/references/ci-script-contracts.reference.yml) の `release-supplemental-asset-build-scripts.adapterInterface` v2 と同じ引数順を維持します。

- build-platform: authority、snapshot、標準 platform directory、新規 supplemental platform directory
- assemble: authority、snapshot、標準 build root、supplemental build root、新規 output directory

実行後は HEAD、authority、snapshot、adapter と入力 tree の名前・mode・bytes が実行前の観測と一致すること、owner exit zero、新規の非空 output directory を確認します。成功時だけ `status=success` と `output-directory` を出力します。失敗時は分類したエラーだけを出力し、owner の stdout/stderr は再出力しません。caller Action の runner file channel 環境変数は child に渡さず、common Action が自分の出力を設定します。途中の owner 生成物は削除・再利用せず、次回も既存 output を拒否します。

## 責務境界

installer 固有のビルド、platform 意味検証、provenance・verification・owner evidence の生成と意味検証は owner adapter に残します。この Action の成功は installer 意味検証の独立証拠ではありません。最終 handoff の不透明 evidence と digest の結合は `ci-release-assembly` が検証します。

workflow が固定 checkout、read-only permissions、toolchain、artifact 搬送、job 順序を所有します。この Action は execution sandbox ではなく、owner code の全書込先・中間状態を制限するものではありません。provider API・publish write・credential fallback は持ちません。処理時間の上限は caller の job timeout が所有します。

新 Action は pending-release です。公開済み exact ref が承認・登録されるまで、preflight は導入を拒否します。
