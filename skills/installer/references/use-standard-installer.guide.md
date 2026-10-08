# インストーラセットアップガイド

## 目的

製品宣言から固定provider runtimeでinstallerを組み立て、実候補の検証証跡と製品READMEのインストール手順を揃える。

## 選択条件

GitHub Release native assetから、共通実装をコピーせずinstallerを組み立てる場合に使う。

## 標準構成からのセットアップ

use caseとplatformの適用範囲を確認し、対応する固定provider runtimeと製品宣言を最初の導入案とする。製品固有の配置値・manifest・許可されたadapterは、共通installerの固有再実装と区別する。

既存の固有installer・builder・owner adapterがある場合は、変更前に標準構成との差分を整理し、利用者と次を確認する。

- 固有実装が満たしている必須要件は何か。その要件は現在も必要か。
- 製品宣言・manifest・許可されたadapterで同じ要件を満たせるか。満たせない場合は、標準runtimeのどの適用範囲・機能が不足するか。
- A: 標準構成へ移行する（要件を満たせる場合の推奨）、B: 必要性を確認した最小限のowner extensionを残す、のどちらを採用するか。

採用方針が確定するまではその実装を変更せず、独立して進められる標準構成の調査・差分確認を進める。固有差分の判定と必要な証跡は`installer-contract-coverage.reference.yml`の`projectOverrideClassification`を正本とする。固有実装がない場合は、この対話を追加せず通常の手順へ進む。

## 手順

1. use caseとplatformを選ぶ。既存の固有実装がある場合は「標準構成からのセットアップ」に従い、必要性と採用方針を利用者と確認する。入力の正本は `references/installer-standard-assembly-contract.reference.yml`。
2. `assets/examples/standard-assembly.example.json` と `assets/examples/native-manifest.template.json` を製品宣言へ適合させる。配置、activation、lock、state、compatibilityは製品が決める。release identityのmarkerは固定runtimeがauthorityとbuildから解決する。製品宣言とmanifestをソースの同一commitで固定する。
3. CIは固定版のrelease publication workflowで、`supplemental_release_asset_enabled: true`、`supplemental_release_asset_owner_contract: installer.asset-assembly-evidence-contract`、`supplemental_release_asset_implementation: standard-installer`、`supplemental_release_asset_config_path: installer/assembly.json` を指定する。platform宣言はbuild matrixの選択と一致させる。workflow接続と公開・認証は `ci-github` スキルへ委譲する。
4. ローカルは同じprovider revisionの選択配布asset `runtime.installer` を `ci-github` の固定版取得手順でGit管理外に取得し、次のCLIを使う。Action内部runtimeや共通テストをprojectへコピーしない。

```sh
node <distribution>/runtime/installer/run-installer.mjs \
  --operation build-platform --source-root <fixed-checkout> \
  --authority-path <authority-path> --snapshot-path <snapshot-path> \
  --standard-build-root standard/release-build-<platform-id> \
  --output-directory supplemental/supplemental-build-<platform-id> \
  --provider-revision <distribution-manifest-source-revision>
```

`assemble` では、生成またはdownload済み `release-build-<platform-id>` の親を `--standard-build-root` に、`supplemental-build-<platform-id>` の親を `--supplemental-build-root` に、新しいhandoff directoryを `--output-directory` に渡す。上記例では親はそれぞれ `standard` と `supplemental` である。両phaseは同じsource、snapshot、provider revision、assembly idを使う。ローカルのassembly idはsnapshot digestから導出する。

5. verificationとfinal evidenceを確認する。共通回帰、製品候補のprofile成功、製品要求の受入を分ける。native未実行やhosted未実行は証拠不足として報告する。
6. 次節に従い、製品READMEへインストール手順を追記する。既存の手順がある場合は今回の配布構成へ更新し、同じ導入経路を重複記載しない。

## 製品READMEへのインストール手順追記

1. 製品READMEのインストール節に、対応OS・CPU、前提ツール・権限、既定のインストールコマンドを書く。配布形態とコマンドは`installer-use-case-contract.reference.yml`の`delivery`と検証済み配布物を参照する。共有wrapperとtarget-specific assetを区別し、未提供・未検証の経路を対応済みとして記載しない。検証済みのowner extensionは、提供元と適用範囲を明示する。
2. 取得先URL・asset名・対象version・checksumの確認方法を製品宣言、manifest、配布物と照合する。未確定値から実行コマンドを推測せず、未確認項目を記録する。
3. launcherとmanaged rootの配置先、必要なPATH設定、起動確認コマンドと期待結果を書く。配置先はmanifestから取得し、実行時に展開されるpathはその旨を示す。
4. 選択した構成が対応する更新・dry-run・repair・rollback・offline操作だけを代表例として示す。既存データの扱いと失敗時の状態を簡潔に説明し、詳細は製品の運用文書へ参照を置く。
5. READMEのコマンド・入力・版・配置先が検証済み候補と一致することを確認し、実行確認したplatformと未確認範囲を記録する。CI内部の組立手順や共通契約をREADMEへ再定義しない。

## 非標準経路

標準契約で満たせない製品要求だけをowner extensionの対象にする。owner-adapter経路は必要性を確認した拡張の接続先として利用できる。共有WindowsやMaven/npmの実行engineを標準対応済みと扱わない。Windows共有の必要性がある場合も、先に共通提供元の拡張を検討する。

## 関連契約

- `references/installer-use-case-contract.reference.yml`
- `references/installer-asset-assembly-evidence-contract.reference.md`
