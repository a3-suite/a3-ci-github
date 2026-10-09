# インストーラセットアップガイド

## 目的

製品宣言から固定provider runtimeでinstallerを組み立て、実候補の検証証跡と製品READMEのインストール手順を揃える。

## 選択条件

GitHub Release native assetから、共通実装をコピーせずinstallerを組み立てる場合に使う。

## 標準構成からのセットアップ

use caseとplatformの適用範囲を確認し、対応する固定provider runtimeと製品宣言を最初の導入案とする。製品固有の配置値・manifest・許可されたadapterは、共通installerの固有再実装と区別する。

Unixは、共有入口の`install.sh`がOS・CPUを判定し、対応する対象別installerを取得・checksum検証して実行する構成を第一案とする。対象別installerは内部payloadとして配布を続け、利用者に選択させない。適用範囲とWindows対象別`.ps1`の併用条件は`references/installer-standard-assembly-contract.reference.yml`へ照合する。共有入口を採用しない場合は、対象OS・製品要件・固定providerの対応可否から理由を記録する。既存の対象別配布を採用済みという事実だけで維持を決めない。

既存の固有installer・builder・owner adapterがある場合は、変更前に標準構成との差分を整理し、利用者と次を確認する。

- 固有実装が満たしている必須要件は何か。その要件は現在も必要か。
- 製品宣言・manifest・許可されたadapterで同じ要件を満たせるか。満たせない場合は、標準runtimeのどの適用範囲・機能が不足するか。
- A: 標準構成へ移行する（要件を満たせる場合の推奨）、B: 必要性を確認した最小限のowner extensionを残す、のどちらを採用するか。

採用方針が確定するまではその実装を変更せず、独立して進められる標準構成の調査・差分確認を進める。固有差分の判定と必要な証跡は`installer-contract-coverage.reference.yml`の`projectOverrideClassification`を正本とする。固有実装がない場合は、この対話を追加せず通常の手順へ進む。

## 固定providerの対応確認

配備されたスキル・サンプルは導入案であり、利用projectが固定するproviderの対応証拠ではない。宣言を変更する前に、次を確認する。

1. 最新公開安定版を比較基準にし、採用するproviderのRelease・full commit SHA・配布manifestを対応付ける。workflowが呼ぶ固定版とローカル照合に使う版を一致させ、開発中runtimeの対応を公開版へ読み替えない。
2. 固定版の入力検証・実装へ、選択するuse case・platform集合・profile・実行環境を構成として照合する。Unix共有入口とWindows対象別installerの同時宣言も、一つの組合せとして確認する。WindowsはPowerShell 5.1以降を第一案とし、固定版のscriptのAPI・要求とnative検証の実行ファイルが対応するかを確認する。`powershell`と`pwsh`は別の実行ファイルであり、呼出し名だけの変更で対応済みにしない。実候補の実行結果は別の証跡確認とする。
3. URLの未確定値を確認する。assemblyサンプルの`sharedWrapper.deliveryUrls`は組立契約に従って実際の固定製品Release URLへ置換する。READMEのURLも同じ製品版・asset名へ揃える。製品Releaseが未公開なら公開後の手順と明記し、現在実行できる手順として案内しない。

固定版が未対応なら、未対応の宣言を適用せず、現在使える構成・不足機能・提供元のリリース後に必要な移行を差分表へ記録する。既存の有効な対象別入口やPowerShell 7要件は、提供元の対応待ちとして根拠を残す。対応済みproviderへの更新なしに共有入口・5.1対応を完了と扱わず、共通runtimeを利用側で再実装して補わない。

## 手順

1. 「標準構成からのセットアップ」と「固定providerの対応確認」に従い、利用可能なuse caseとplatformを選ぶ。既存の固有実装がある場合は、必要性と採用方針を利用者と確認する。入力の正本は `references/installer-standard-assembly-contract.reference.yml`。
2. `assets/examples/standard-assembly.example.json` と `assets/examples/native-manifest.template.json` を製品宣言へ適合させる。配置、activation、lock、state、compatibilityは製品が決める。manifestの対応するrelease identity・artifact・provenanceのmarkerは固定runtimeがauthorityとbuildから解決する。assemblyのURLも同じように自動解決されるとは扱わない。製品宣言とmanifestをソースの同一commitで固定する。
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
6. 「製品READMEへのインストール手順追記」に従い、製品READMEへインストール手順を追記する。既存の手順がある場合は今回の配布構成へ更新し、同じ導入経路を重複記載しない。

## 完了条件とCI側への引き渡し

- 標準構成の採否と、固有実装を残す場合の必要性が確定している。
- 製品宣言・manifestが配置され、CIで組み立てる場合はCI接続が選択した構成と一致している。
- 固定providerの対応確認結果と根拠を保持し、未対応の組合せ・未確定のURLが残っていない。
- 組立・製品候補の検証結果を確認し、製品READMEのインストール手順が配布構成と一致している。
- 変更したファイル、構成、検証結果、未確認事項・ブロッカーを報告する。CIからの委譲では、この結果をCI側へ返す。
- 権限・外部副作用・実行環境等で実施できない手順は、理由と必要な対応を明示し、セットアップ完了と扱わない。監査のみの依頼では成果物を変更しない。

## 製品READMEへのインストール手順追記

READMEのみの修正依頼では、本節を実施範囲とする。セットアップ全体の手順と候補組立・検証の完了条件を、README改稿の前提へ持ち込まない。本節の完了は、許可範囲の改稿と必要な構成値・導入導線・参照先の再確認で判定し、未確認事項は保持する。実行証跡が未依頼なら未実施として別記し、installerセットアップ全体の完了とは分けて報告する。

`assets/examples/readme-installation.example.md`を出発点にし、「固定providerの対応確認」を行ってから、提供元が対応する短い既定オンライン起動を製品情報へ適合させる。既存の配布形式を採用していることだけで、より短い標準起動との比較を免除しない。サンプルのplaceholderを残したまま公開せず、未提供のOS・操作は削除する。

installerを主工程とし、配布経路・コマンド・対応環境・配置先・安全性の正当性を確認する。本文の構成・最短導線・詳細への参照はroot-docsスキルの`references/maintain-readme.guide.md`を補助として適用する。root-docsへ確認済みの製品情報と未確認範囲を渡し、返却されたREADME固有の判断を保持する。完了レビューは主工程からpost-artifact-reviewへ一度だけ渡す。

READMEの基本形は、対応環境・前提、採用経路のOS別インストールコマンド、配置先・必要なPATH設定・起動確認とする。installerが担う配布物の取得・検証・展開を利用者へ重ねて要求しない。高度な操作は次の手順4で扱い、必要な前提・権限・注意事項は残す。サンプルへの字句一致や行数ではなく、必要な導入操作で判断する。

初回の既定オンライン導入では、対応する固定HTTPS URLからinstallerを直接起動する標準入口を先に確認する。ファイルへの保存と別コマンドでの実行、既定のinstall/online引数、README内の独自例外処理は、それが必要な根拠がなければ置換対象にする。Unix共有wrapperと対象別payloadの実行shell、Windows installerが要求するPowerShell実装を確認し、サンプルの呼出し名をそのまま別runtimeへ適用しない。短い起動に配布側の変更が必要なら、その不足と移行案を別記し、現手順との一致を標準適合の根拠にしない。

入口の比較では、配布する実行ファイルの名前と役割を確認する。共有`install.sh`とOS別`install-*.sh`の違いを、`sh`・`bash`などの起動shell名の違いへ置き換えない。共有入口へ移行する場合は、製品宣言・組立profile・公開asset・READMEのURLを一緒に揃える。READMEのURLだけを未生成の`install.sh`へ変えない。

1. 製品READMEのインストール節に、対応OS・CPU、前提ツール・権限、既定のインストールコマンドを書く。配布形態とコマンドは`installer-use-case-contract.reference.yml`の`delivery`と検証済み配布物を参照する。共有wrapperとtarget-specific assetを区別し、未提供・未検証の経路を対応済みとして記載しない。検証済みのowner extensionは、提供元と適用範囲を明示する。
2. 起動コマンドの固定URL・対応OS・CPUを製品宣言、manifest、配布物と照合する。manifestと配布物の取得・検証はinstallerに委譲し、READMEへ同じ検証処理を実装しない。未確定値から実行コマンドを推測せず、未確認項目を記録する。
3. launcherとmanaged rootの配置先、必要なPATH設定、起動確認コマンドと期待結果を書く。配置先はmanifestから取得し、実行時に展開されるpathはその旨を示す。
4. 更新・dry-run・repair・rollback・offline操作の詳細は、必要な場合だけ対応する製品の運用文書へ寄せ、READMEから参照する。初回導入に不可欠な操作は理由を確認してREADMEに残す。既存データの扱いと失敗時の注意は導入に必要な範囲で簡潔に説明する。
5. READMEのコマンド・入力・版・配置先をmanifest・実装・配布計画へ照合し、必要な導入操作だけで起動確認へ到達できるかをroot-docsの観点で再確認する。検証済み候補がある場合はその内容とも照合する。実行結果は対象platformと実候補に結合して別記し、未取得だけで構成を不適合にしない。CI内部の組立手順や共通契約をREADMEへ再定義しない。

修正依頼では、許可されたREADMEのインストール節を本節の手順に沿って実際に改稿し、置換案の提示だけで終了しない。同じ配布経路の文章整理のためにinstaller本体を変更しない。別の配布経路や実装選択が必要なら、その問題と必要な判断を分けて報告する。

## 非標準経路

標準契約で満たせない製品要求だけをowner extensionの対象にする。owner-adapter経路は必要性を確認した拡張の接続先として利用できる。共有WindowsやMaven/npmの実行engineを標準対応済みと扱わない。Windows共有の必要性がある場合も、先に共通提供元の拡張を検討する。

## 関連契約

- `references/installer-use-case-contract.reference.yml`
- `references/installer-asset-assembly-evidence-contract.reference.md`
