# ci-vitest-summary

Vitest JSON レポートを GitHub step summary へ変換する framework-specific の read-only Action です。レポートが欠落・不正・不整合でも `unresolved` を出力して step 自体は失敗させず、入力パスの不正や書き込み失敗だけを失敗にします。一般的な複数結果の集約は `ci-quality-summary` が担当します。

プロジェクトへコピーした後も `skills/` ツリーやこのリポジトリのファイルを参照しません。
