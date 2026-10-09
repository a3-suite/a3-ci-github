# Maintenance

開発・保守に関する補足文書を配置します。

- [Action 構築方針](action-construction.md): 方式選択、既存 Action との対称性、配布・検証導線。
- [テスト戦略](test-strategy.md): 統合テストと Hosted E2E の受入境界。

## 公開導入ガイドの版選定

本リポジトリの公開スキルでは、導入先のprovider・CLIの採用版や最低対応版を具体的なリリース番号で固定しません。導入時に提供元の公開済み安定版と導入済みrevisionを比較し、公開契約と必要機能を確認して採用するexact Releaseを確定する導線にします。確認できない機能を利用可能として扱いません。

再現性を保つ実行時の固定SHA・checksumはregistryとmanifestを正本とし、ガイドへ値を重複させません。導入手順は[選択配布ガイド](../../skills/ci-github/references/distribute-ci-assets.guide.md#対応条件)を参照してください。
