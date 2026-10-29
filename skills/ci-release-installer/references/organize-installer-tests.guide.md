# インストーラテスト整理ガイド

## 目的
- インストーラ契約に沿って、成功系、失敗系、冪等再実行、rollback、dry-run、state / audit 境界のテスト証跡を整理できるようにする。

## 選択条件
- インストーラ実装のテスト観点を整理する。
- fixture、coverage matrix、監査証跡の対応関係を確認する。

## 注意
- サンプル入力は形を理解するための資料であり、テスト証跡として扱わない。
- fixture の合否を exit code だけで判定しない。
- 成功系だけで準拠を判断せず、違反検出と残存状態を必ず確認する。
- 非 native 環境で skip された platform 別 runtime テストを証跡として扱わない。

## フロー
1. coverage matrix で invariant と contract ID を確認する。
2. fixture baseline で入力、期待結果、残存状態の最低範囲を確認する。
3. fixture catalog の expected outcome と coverage role を使い、成功証跡と違反検出証跡を分ける。
4. Java / Maven、Node / npm などの runtime overlay がある場合は、固定 version、runtime 存在確認、可変参照拒否、credential 非永続の観点を追加する。
5. 共通実装・共通回帰はproviderが保有・実行する。利用projectにはコピーや新規実装を要求しない。製品の実manifest・archiveに対するcandidate検証は固定runtimeで実行し、profileの証跡を残す。nativeでskipした結果やdelivery test doubleを他OS実機の成功として扱わない。製品独自の差分と要求受入に必要なテストだけをprojectが保有する。
6. CI など installer 外で組み立てた installer asset は、インストーラ asset 組立証跡契約に従い、asset checksum、manifest checksum、provenance、検証結果を同じ証跡 record に残す。
7. 実装テスト、fixture、監査ログ、install state、handoff state の対応を記録し、対応する証跡が無い invariant を証跡不足として扱う。
8. 失敗診断の正本と検査導線は`references/audit-installer-compliance.guide.md`の「契約 surface へ対応付ける」から解決する。失敗終了だけで診断保証を満たしたとせず、最終ログ・必要な既存証跡と元の終了/残存状態を照合する。共通回帰はproviderの固定実装に結合した結果を使い、子処理・診断/保持故障の検証範囲と未確認条件を記録する。

## platform runtime テストの受け入れ条件
- 組立済み candidate（固定 provider runtimeの `assemble` 出力の manifest と archive）を対象 platform の native 環境で起動する runtime テストを最低 1 つ実行する。
- 成功系は非ゼロ終了せず、違反系は非ゼロ終了することを確認する。
- managed root、launcher、install state の残存状態を確認する。
- native 実行できない platform の結果を、他 platform（Linux コンテナなど）の実行で代替しない。
- Windows CIを使う場合も、対象契約が選択したPowerShell実行器の結果を確認する。job配置だけを実行成功とせず、非nativeのskipと未実行の実行器を分ける。

### 確認手段
- 固定 provider runtimeの検証 profile（`references/installer-standard-assembly-contract.reference.yml` の `profiles`）を、対象 platform の native runner（Windows は Windows runner）で実行する。
- 組立済み asset を実 manifest / archive で起動していることをテストソースで確認する。
- installer の配置検証のみを目的とする distribution-layout validator は launcher / runtime の証跡として使わない。

## リファレンス
### インストーラ fixture baseline
- 参照: references/installer-fixture-baseline.reference.md

### インストーラ fixture catalog
- 参照: references/installer-fixture-catalog.reference.yml

### インストーラ契約 coverage matrix
- 参照: references/installer-contract-coverage.reference.yml

### インストーラ asset 組立証跡契約
- 参照: references/installer-asset-assembly-evidence-contract.reference.md
