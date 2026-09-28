# Rust release scripts

Rust CLI の固定 source を検証し、platform ごとの binary を build、package、検証する共通処理です。

公開実行境界は次の2つです。

- `ci-source-gate.sh`: authority の language profile と source SHA を checkout に照合する
- `ci-release-build.sh`: authority、platform manifest、Rust toolchain、project 設定を照合し、build、package、検証を完了する

`ci-release-build.sh` は同梱した manifest validator で platform ID／target と runner allowlist を検証し、
実行OSに応じて同じディレクトリの Unix／Windows 実装へ委譲します。Rust toolchain は
`major.minor.patch` の完全固定版だけを受け付けます。
出力先が既に存在する場合は上書きせず失敗します。
