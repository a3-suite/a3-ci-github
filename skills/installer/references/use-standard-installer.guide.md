# 標準installerの利用ガイド

## 目的

製品宣言から固定provider runtimeでinstallerを組み立て、実候補の検証証跡を得る。

## 選択条件

GitHub Release native assetから、共通実装をコピーせずinstallerを組み立てる場合に使う。

## 手順

1. use caseとplatformを選ぶ。入力の正本は `references/installer-standard-assembly-contract.reference.yml`。
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

## 非標準経路

標準契約で満たせない製品要求だけをowner extensionの対象にする。既存owner-adapter経路は維持する。共有WindowsやMaven/npmの実行engineを標準対応済みと扱わない。Windows共有の必要性がある場合も、先に共通提供元の拡張を検討する。

## 関連契約

- `references/installer-use-case-contract.reference.yml`
- `references/installer-asset-assembly-evidence-contract.reference.md`
