---
name: installer
description: GitHub 管理のソース/Release asset/Packages、npm・Maven など外部リポジトリから資材取得するインストーラ、インストールスクリプト、関連ドキュメントの作成・修正・レビュー、提供元の固定runtimeを使う製品宣言とCI接続の検証、および作成済みまたは導入判断・project SSOT で要求されるインストーラ成果物の適合監査で、配布物検証、冪等性、既存データ保護、rollback、安全な設定読取を整理するときに使うスキル。
---

# installer / SKILL

## 目的
GitHub 管理のソース、Release asset、Packages、npm・Maven などの外部リポジトリから取得する資材を、検証済み入力として安全に対象環境へ収束させるための判断軸と導線を提供する。

## 原則
- installer を導入すべきかの推奨判断は repository-audit スキル、採否は project SSOT が所有する。本スキルはインストーラ成果物の設計、実装、レビューと、作成済み、導入判断が `required`、または project SSOT で採用済みの場合の適合監査を所有する。`required` 判定や採用済みという事実は、実装または修正の許可を意味しない。
- インストーラは「取得」「検証」「配置」「切替」「起動確認」を混同せず、各段階の責務を分ける。
- 取得元は GitHub、package registry、artifact repository などの外部境界として扱い、信頼は manifest、checksum、署名、固定 version で確立する。
- 標準経路では、JRE、Node.js、package manager などの実行基盤は事前インストール済み前提とし、installer は存在確認と version 照合だけを行う。
- starter の installer は、アーカイブ展開に OS 提供の `tar` を存在確認して使い、無い場合は展開の前に失敗する。Windows は PATH 上の tar に依存せず、`%SystemRoot%\System32\tar.exe`（bsdtar）を絶対パスで使う。取得は Unix が `curl`、Windows が PowerShell の HTTPS 取得を使う。
- 既存データ、既存設定、稼働中プロセスを壊さないことを最優先にする。
- 検証した入力と実行に使う入力を一致させる。
- 失敗時に残る状態を先に定義し、途中成功の副作用を最小化する。
- 共通 installer への準拠を既定とし、非準拠の根拠はインストーラ契約 coverage matrix の project override classification に従って検証する。

## ルール
- manifest、checksum、署名などの検証済み入力を使う場合、インストール実行時に別入力を再取得してはならない。
- production / release 用 installer の入力は manifest contract を正本とし、Java / Node などの runtime 別差分は manifest の overlay として扱う。
- GitHub の branch、registry の `latest`、version range、SNAPSHOT などの可変参照は、明示的に許可された開発用途以外では installer 入力にしない。
- GitHub Packages、npm、Maven などから取得する資材は、registry URL、package coordinate、version、checksum と任意の署名検証を入力契約に含める。
- project override はインストーラ契約 coverage matrix の project override classification に従い、project SSOT の証跡で分類する。
- project override があっても、インストーラ契約 coverage matrix の core safety invariant は緩和しない。
- installer の標準対象 platform 候補と識別子は use case 契約を正本とし、設計時は全候補を常に選択可能な前提で対象 platform を決める。
- project-owned custom installer の実装形式は、インストーラ作成ガイドの選択基準に従う。
- installer が巨大化する場合は、配布単位と保守単位を分け、保守単位は manifest、source、verify、staging、activation、state、audit、service などの契約境界で分割する。
- CI で installer asset を組み立てる場合、installer 側は組立済み asset、manifest、checksum、provenance、テスト証跡の契約を扱い、workflow trigger、job、権限、cache、release publish 手順は ci スキルへ委譲する。
- 標準GitHub Release native経路は、提供元の固定Actionまたは固定配布CLIを使う。利用projectがGit管理するのは製品宣言とmanifestの製品固有値だけとし、共通installer本体・builder・fixture・テスト・adapterをコピーまたは個別実装しない。CI中の取得資材とprojectの追跡sourceを分ける。入力と保証範囲は標準組立契約に従う。
- production installer は未知の manifest field、未許可 download URL、unsafe archive entry、checksum または署名の不一致を拒否し、包括的な強制オプションで迂回させない。
- 標準経路で実行基盤が存在しない、または要求 version を満たさない場合は、installer が取得・導入せず失敗する。
- production installer は本番ホストで source build を暗黙に実行しない。project override で source build を扱う場合も、入力、toolchain、依存解決、出力検証、失敗時状態を固定する。
- 同一 managed root に対する並行実行は lock で拒否する。
- 設定ファイルはデータとして解析し、privileged execution context では user-editable な設定を shell 実行しない。
- 既存データ、secret、ユーザー編集済み設定は既定で上書きしない。
- rollback は変更済み resource ごとの rollback plan として定義し、activation、service、process、shared asset、state、data restore を混同しない。
- 共有 runtime asset は検証済み staging から最後に切り替える。
- installer が runtime script を配置または生成する場合、その script の起動責務、手動操作、service manager handoff、PID、ログ、restart、health 境界は runtime-script スキルの契約に従う。
- destructive な操作、所有権変更、権限変更は managed root 内に閉じる。root 外の launcher 操作は manifest 契約の「launcher 安全不変条件」に従い、service manager 登録は必要な最小操作だけに限定する。

## 関連スキル
- 任意: repository-audit - installer の導入推奨と project SSOT の採否を確認するときに参照する
- 任意: runtime-script - installer が配置または生成する起動スクリプト、service manager handoff、PID、ログ、restart、health 境界を整理するときに参照する
- 任意: env - 環境変数や設定ファイルの扱いを整理するときに参照する
- 任意: secret-management - token、secret、資格情報の保存禁止や注入元を整理するときに参照する
- 任意: backup - DB や永続データの退避・復旧境界を整理するときに参照する
- 任意: review - インストーラの設計や差分をレビューするときに参照する
- 任意: test - 失敗系、rollback、冪等性のテスト方針を整理するときに参照する
- 任意: ci - installer asset の CI 組立、workflow、権限、release publish の実装境界を整理するときに参照する
- 任意: a3-lint - distribution layout の canonical textual marker を事前に機械検証するときに参照する
- 任意: tech-stack-selection - installer 実装言語や配布技術の採否理由を設計書として整理するときに参照する
- 任意: module-boundary-design - installer 実装が巨大化し、保守単位、公開契約、依存方向を整理するときに参照する

## 注意
- 非対象: OS やパッケージマネージャ固有の詳細手順
- 非対象: 個別アプリケーションのリリース仕様そのもの
- 既存プロジェクトに installer の SSOT がある場合は、project 固有の実装詳細ではそれを優先する。

## トリガー＆アクション
### インストーラを作成・修正したい
- 実装前にuse case契約で標準runtimeの適用範囲を確認する。適用できる場合は製品宣言だけを作り、提供元の固定runtimeへ委譲する。
- 既存インストーラがある場合も、共通契約と適用可能なテンプレートに沿う汎用インストーラへ変更できるかを先に検討する。
- 対象環境へ収束させる最小責務を決める。
- 入力固定、staging、切替、rollback、データ保護、検証を順に設計する。
- 参照: references/installer-use-case-contract.reference.yml
- 参照: references/define-installer.guide.md

### runtime / package ecosystem overlay を整理したい
- Java / Maven や Node / npm は、共通 manifest contract に追加する代表 overlay として整理する。
- 参照: references/define-installer.guide.md

### 取得形態と対象 platform ごとの契約を決めたい
- GitHub Release native asset、Maven Jar、npm package のいずれかを選び、標準候補から target platform を決める。
- use case と target platform の選択後に、対応する manifest sample を project schema へ適合させる。
- 参照: references/installer-use-case-contract.reference.yml

### インストーラ実装言語を選びたい
- インストーラ作成ガイドの実装形式の選択基準を適用する。
- 参照: references/define-installer.guide.md

### インストーラが巨大化したため分割したい
- 配布単位、保守単位、契約境界、依存方向、構造退行検査を整理する。
- 参照: references/define-installer.guide.md

### CI で組み立てる installer asset の境界を整理したい
- installer 側では asset 契約、checksum、manifest 固定、provenance、組立後検証の証跡を整理し、workflow 実装は ci スキルへ委譲する。
- 参照: references/define-installer.guide.md
- 参照: references/installer-asset-assembly-evidence-contract.reference.md

### GitHub Release asset として配る installer の配置を決めたい
- use case契約の `distributionAsset` と標準組立ガイドから固定runtimeを選び、製品宣言とmanifestを適合させる。assetの組立と検証証跡はインストーラasset組立証跡契約に従う。
- 標準経路では製品宣言以外の共通資材がprojectでGit管理されていないことを確認する。
- 参照: references/installer-use-case-contract.reference.yml
- 参照: references/installer-asset-assembly-evidence-contract.reference.md
- 参照: references/define-installer.guide.md

### 標準installerをCIまたはローカルで組み立てたい
- 提供元の固定版を選択し、実装選択・製品宣言path・検証profileを明示する。
- 標準経路では共通実装を利用projectへコピーしない。個別adapterが必要かは、標準契約で満たせない製品要求から判断する。
- 参照: references/use-standard-installer.guide.md
- 参照: references/installer-standard-assembly-contract.reference.yml

### 固定URL配信で共有インストーラを公開したい
- 共有 Unix wrapper（POSIX sh bootstrap）と platform 別 installer（検証済み payload）を分け、delivery 契約に従って固定 HTTPS URL から pipe 実行できるようにする。
- 参照: references/installer-use-case-contract.reference.yml
- 参照: references/define-installer.guide.md

### 標準経路から外れる installer を扱いたい
- project override classification に必要な証跡を project SSOT へ寄せる。
- 参照: references/define-installer.guide.md

### インストーラをレビューしたい
- 検証済み入力と実行入力の一致、設定読取、既存データ保護、失敗時状態を優先して確認する。
- 必要に応じて review スキルのレポート要件に従う。
- 参照: references/define-installer.guide.md

### インストーラを監査したい
- 作成済み、導入判断が `required`、または project SSOT で要求される installer script、manifest、execution request、関連ドキュメント、テスト証跡が本スキルの契約に沿っているかを監査する。期待される成果物が存在しない場合も証跡不足として扱う。
- スキル文書自体の監査ではなく、インストーラ成果物の実装・入力・運用証跡を対象にする。
- 機械検証の成功だけで、実装責務・CI接続・実候補の証跡を確認した意味監査の成功とは扱わない。
- 標準経路は製品宣言・固定provider revision・候補checksum・実候補の検証profileを照合してから意味監査へ進む。
- 意味監査は共通 installer への準拠、準拠可能性、例外根拠の順に確認し、具体的な導入・更新案を提示する。比較基準と手順は監査ガイドに従う。
- 準拠監査での project SSOT の扱いと判定順は、監査ガイドの優先順位に従う。
- 参照: references/audit-installer-compliance.guide.md

### インストーラのテスト観点を整理したい
- fixture baseline と coverage matrix を使い、成功系、失敗系、冪等再実行、rollback、dry-run、state / audit 境界の証跡を整理する。
- 参照: references/organize-installer-tests.guide.md

### インストーラの状態遷移と失敗時状態を整理したい
- preflight、download、verify、stage、switch、health、state / audit の遷移と、各失敗時に残してよい状態を確認する。
- 参照: references/installer-state-machine.reference.md

### インストーラ入力サンプルを確認したい
- use case 別の manifest / execution request と、install state、handoff state の最小 JSON 例を確認する。
- 参照: references/installer-input-examples.reference.md
