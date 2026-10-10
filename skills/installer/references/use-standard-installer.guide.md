# インストーラセットアップガイド

## 目的

製品宣言から固定provider runtimeでinstallerを組み立て、実候補の検証証跡と製品READMEのインストール手順を揃える。

## 選択条件

GitHub Release native assetから、共通実装をコピーせずinstallerを組み立てる場合に使う。

## 標準構成からのセットアップ

use caseとplatformの適用範囲を確認し、対応する固定provider runtimeと製品宣言を最初の導入案とする。製品固有の配置値・manifest・許可されたadapterは、共通installerの固有再実装と区別する。

宣言・手順の変更前に、`references/audit-installer-compliance.guide.md`の「機械検証と意味監査」「プロジェクト固有規則との競合確認」を実施する。固有実装がなくても適用されるローカル規則を確認し、競合の解決案とownerを採用方針へ含める。

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
   README・セットアップガイドの前提ツール、要求version、権限も固定版の実装・契約へ照合する。既存の前提一覧を根拠にせず、READMEへの記載は「READMEに残す内容」で判断する。前提を確定できなければ確認元と未確認項目を報告する。
3. URLの未確定値を確認する。assemblyサンプルの`sharedWrapper.deliveryUrls`は組立契約に従って固定製品Release URLへ置換する。READMEのURLも同じ製品版・asset名へ揃える。製品の公開状況とURL取得の実証結果は監査・リリース準備記録へ分け、READMEへ作業状況を追記しない。

固定版が未対応なら、未対応の宣言を適用せず、現在使える構成・不足機能・提供元のリリース後に必要な移行を差分表へ記録する。既存の有効な対象別入口やPowerShell 7要件は、提供元の対応待ちとして根拠を残す。対応済みproviderへの更新なしに共有入口・5.1対応を完了と扱わず、共通runtimeを利用側で再実装して補わない。

## 手順

1. 「標準構成からのセットアップ」と「固定providerの対応確認」に従い、利用可能なuse caseとplatformを選ぶ。既存の固有実装がある場合は、必要性と採用方針を利用者と確認する。入力の正本は `references/installer-standard-assembly-contract.reference.yml`。
2. `assets/examples/standard-assembly.example.json` と `assets/examples/native-manifest.template.json` を製品宣言へ適合させる。宣言ファイルとインストール先は`references/define-installer.guide.md`の「製品宣言の標準配置」の標準配置から始め、templateのplacement・activation・lock・stateを同ガイドの配置プロファイルへ揃える。compatibilityは製品要求へ適合させ、標準から外れる配置には必要性の根拠を残す。manifestの対応するrelease identity・artifact・provenanceのmarkerは固定runtimeがauthorityとbuildから解決する。assemblyのURLも同じように自動解決されるとは扱わない。製品宣言とmanifestをソースの同一commitで固定する。
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
- `references/audit-installer-compliance.guide.md`の「標準比較の完了チェック」を満たし、標準との比較と差分の必要性をCI側へ返す。
- 最終結果は同ガイドの「最終結果の独立レビュー」に従って確認する。READMEのみの修正では、同節への入力を許可された改稿範囲とその正当性の根拠に限定する。
- 変更したファイル、構成、検証結果、未確認事項・ブロッカーを報告する。CIからの委譲では、この結果をCI側へ返す。
- 権限・外部副作用・実行環境等で実施できない手順は、理由と必要な対応を明示し、セットアップ完了と扱わない。監査のみの依頼では成果物を変更しない。

## 製品READMEへのインストール手順追記

READMEのみの修正依頼では、本節のインストール・アンインストール案内を実施範囲とする。セットアップ全体の手順と候補組立・検証の完了条件を、README改稿の前提へ持ち込まない。本節の完了は、許可範囲の改稿と必要な構成値・導入導線・参照先の再確認で判定し、未確認事項は保持する。実行証跡が未依頼なら未実施として別記し、installerセットアップ全体の完了とは分けて報告する。

`assets/examples/readme-installation.example.md`を出発点にし、「固定providerの対応確認」を行ってから、提供元が対応する短い既定オンライン起動を製品情報へ適合させる。既存の配布形式を採用していることだけで、より短い標準起動との比較を免除しない。サンプルのplaceholderを残したまま公開せず、未提供のOS・操作は削除する。

README改稿だけの場合も、同監査ガイドの競合確認をインストール・アンインストール節・参照先・その手順を制約する規則へ限定して行う。範囲外の契約やスキルの変更が必要なら、競合と解決案をownerへ返し、READMEの編集権限だけで変更しない。

installerを主工程とし、配布経路・コマンド・対応環境・配置先・安全性の正当性を確認する。本文の構成・最短導線・詳細への参照はroot-docsスキルの`references/maintain-readme.guide.md`を補助として適用する。root-docsへ確認済みの製品情報と未確認範囲を渡し、返却されたREADME固有の判断を保持する。完了レビューは「完了条件とCI側への引き渡し」に従い、主工程から一度だけ渡す。

### READMEに残す内容

READMEは対象製品版の導入・利用手順として書く。対応OS・CPU、OS別コマンド、launcherとmanaged rootの配置先、必要なPATH設定、起動確認、アンインストール手順を基本形とする。PowerShell 5.1以降などの対応する実行環境の範囲は一度だけ明示する。

前提は、標準対応環境に別途導入・設定が必要な場合だけ記載する。通常使えるツールは列挙せず、実装上の依存があるだけではREADMEへの記載理由にしない。依存の存在確認と安全な停止は実装・検証側で維持する。

1. 固定providerが対応する短い既定オンライン起動と、現在のREADMEコマンドをOSごとに比較する。Unixの共通コマンドはLinux・macOSで一つにまとめる。サンプルの字句や行数ではなく、必要な導入操作で判断する。
2. 共有`install.sh`と対象別`install-*.sh`・`.ps1`の名前と役割、起動shell、固定URL・asset名・対応OSを製品宣言と配布計画へ照合する。共有入口への移行では宣言・profile・asset・URLを一緒に揃え、READMEのURLだけを未生成の入口へ変えない。
3. 配置先をmanifestから取得し、`references/define-installer.guide.md`の「配置プロファイルと標準配置」との差分を確認する。配置先の説明は一箇所にまとめ、詳細な内部構造はREADMEへ展開しない。必要な導入操作だけで起動確認へ到達できるかをroot-docsの観点で再確認する。
4. アンインストール手順はサンプルの削除対象をmanifestへ照合し、製品専用のlauncher・managed rootだけを対象にする。共有ディレクトリ・共有PATHを削除対象にせず、製品の設定・データが削除されるか残るかを確認する。未提供のuninstallコマンドを案内しない。

候補があれば同じ対象identityへ照合し、実行結果は監査記録へ分ける。未依頼の実行証跡不足だけで構成を不適合にしない。必要な値を確定できなければ推測せず、未確認項目と確認先を報告する。

### READMEへ書かない内容

次は製品READMEのインストール節へ書かない。既存記述も確認し、修正依頼では削除または適切な参照へ置き換える。

- **公開・作業状況**：「未公開です」「公開後に実行してください」「移行中です」「検証予定です」。監査・リリース準備記録で扱う。
- **監査・証跡の状況**：「CI監査済み」「preflight成功」「Windows実行証跡未取得」。監査記録で扱う。
- **通常ツールの列挙・一般説明**：標準対応環境で通常使えるBash・curl・sh・checksumツールの前提一覧、`curl … | sh`に対する「curlとshが必要」、取得・検証・配置といった処理の言い換え。
- **不要な導入操作**：installerの保存・別実行、手動checksum確認、既定のinstall/online引数、独自例外処理。短い標準起動で満たせる操作を重ねない。
- **重複**：Linux・macOSの同じコマンド、同じ説明・ガイドリンクの繰り返し。
- **高度な操作の詳細**：offline、dry-run、repair、rollbackなど。必要な場合は製品の運用文書へ一度だけリンクする。
- **内部CI・保守情報**：provider revision、assembly profile、Action接続、内部payload構造、監査契約、採用理由。

初回導入に不可欠な操作や、より厳しいproject固有の安全方針は、必要性を確認して最小限残す。理由はproject SSOT・監査記録へ置き、READMEへ監査の説明を追加しない。配布側の変更が必要な短縮は、現手順の維持と移行案を分けて報告する。

修正依頼では、許可されたREADMEのインストール・アンインストール節を実際に改稿し、置換案の提示だけで終了しない。同じ配布経路の文章整理のためにinstaller本体を変更しない。別の配布経路や実装選択が必要なら、その問題と必要な判断を分けて報告する。

## 非標準経路

標準契約で満たせない製品要求だけをowner extensionの対象にする。owner-adapter経路は必要性を確認した拡張の接続先として利用できる。共有WindowsやMaven/npmの実行engineを標準対応済みと扱わない。Windows共有の必要性がある場合も、先に共通提供元の拡張を検討する。

## 関連契約

- `references/installer-use-case-contract.reference.yml`
- `references/installer-asset-assembly-evidence-contract.reference.md`
