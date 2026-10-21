# Maintenance

開発・保守に関する補足文書を配置します。

- [Action 構築方針](action-construction.md): 方式選択、既存 Action との対称性、配布・検証導線。
- [テスト戦略](test-strategy.md): 統合テストと Hosted E2E の受入境界。
- [installer 保守](installer-maintenance.md): installer の配置・構築・検証方法。
- [移行記録](migration-baseline.md): 再構築の移行元と切替時点の受入結果。

## バージョン制約の判断

runnerだけでなく、toolchain、runtime、依存package、Actionや配布資材の参照を追加・更新するときも、[導入・更新要件](../../sdd/dsl/requirements/items/requirements/github-ci-project-lifecycle/requirement.sdd.yml)に照らして固定の必要性と選択の幅を慎重に決めます。既存の固定値や検証済み一覧があることだけを、同じ制限を維持する理由にしません。

決定前に、次を自問します。

- 固定しなければ、どの保証が具体的に損なわれるか。sourceの同一性、再現性、API・ABI互換性などの根拠があるか。
- 完全一致が必要か。major・minor単位、互換範囲、利用projectの指定まで幅を持たせられるか。選択した幅を何で確認できるか。
- provider内部の実行前提とconsumerが選ぶ環境を混同していないか。consumerの版変更だけでproviderの改修・公開を必要にする制限に、具体的な理由があるか。
- 検証済み一覧を受理範囲へそのまま転用していないか。範囲を広げても既存の信頼・権限・資材同一性の保証を保てるか。
- セキュリティ更新やrunner廃止時に移行を妨げないか。制約の見直しが必要になる条件と、更新する責務は明確か。

採用した固定粒度・許容範囲・選択を所有する側と、その理由を対象の既存設計または変更記録に残します。仕様や実装へ反映するときは、その正本を更新し、この文書へ具体的な許可値を複製しません。

## 公開導入ガイドの版選定

本リポジトリの公開スキルでは、導入先のprovider・CLIの採用版や最低対応版を具体的なリリース番号で固定しません。導入時に、dependency-selectionの版選定（公開待機期間と例外を含む）で採用可能な提供元の最新の公開済み安定版と導入済みrevisionを比較し、公開契約と必要機能を確認して採用するexact Releaseを確定する導線にします。確認できない機能を利用可能として扱いません。

再現性を保つ実行時の固定SHA・checksumはregistryとmanifestを正本とし、ガイドへ値を重複させません。導入手順は[選択配布ガイド](../../skills/ci-github/references/deploy-ci-assets.guide.md#対応条件)を参照してください。
