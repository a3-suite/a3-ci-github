# インストーラ監査ガイド

## 目的
- 作成済み、導入判断が `required`、または project SSOT で要求されるインストーラ成果物が installer スキルの契約に沿って実装されているかを、証跡ベースで監査できるようにする。
- 監査ガイドの型は `compliance` とし、review / validate / check では不足する対象集合、契約、実装、証跡、停止条件の対応を扱う。

## 選択条件
- installer script、manifest schema、manifest、execution request、組立済み installer asset、asset 組立証跡 record、installer が配置または生成する runtime script、systemd unit または service manager 定義、運用ドキュメント、テスト、fixture、audit log などの成果物を監査する。
- repository-audit の導入判断が `required`、または project SSOT が installer 成果物を要求しており、期待される成果物が存在しない状態を監査する。
- 「このインストーラは installer スキル準拠か」を確認する。

## 注意
- 非対象: installer スキル文書そのものの監査。
- 非対象: 個別アプリケーションの release 方針、OS patch、runtime install、DB restore、secret 発行の妥当性そのもの。
- サンプル入力は形を理解するための資料であり、監査証跡として扱わない。
- 監査は読み取り専用とする。準拠のための導入・更新案を提示しても、実際の変更は明示依頼後に行う。
- 既存プロジェクトに installer の SSOT がある場合も、インストーラ契約 coverage matrix の core safety invariant を緩和する根拠にはしない。

## 機械検証と意味監査
- 配置警告は project override の採否を決めない。警告の対象、必要性、既存 project SSOT の証跡を project override classification で判断する。検査不能を配置適合へ読み替えない。
- 意味監査では、distribution layout と実際の物理配置、実装、CI workflow、証跡を照合する。機械検証と意味監査がともに成功し、残る証跡不足がない場合にだけ監査全体を成功とする。

## 監査時の優先順位
- project SSOT は命名、対象 platform、adapter、release 方針など project 固有の実装詳細を判断する正本として扱う。
- 上記の物理配置以外については、installer スキルの標準経路を準拠監査の出発点として扱い、project SSOT が標準経路と異なる場合の分類はインストーラ契約 coverage matrix の project override classification に従う。
- core safety invariant の定義はインストーラ契約 coverage matrix を正本とし、project SSOT が明示していても緩和しない。
- project SSOT が installer スキルの契約より厳しいローカル条件を定める場合は、先に project override classification で必要性と証跡を確認する。採用中の条件は無断で無視せず監査基準に含め、必要性の証跡が欠ける条件は `project-specific exception` としてローカルルールの見直し対象にする。
- project SSOT が標準経路と異なる場合は、project override classification に従って分類し、分類結果と根拠を finding または audit note に含める。

## 権限境界の語彙
- `privileged execution context`: root、または managed root、service、runtime asset、install state、handoff state、secret、credential に影響できる service user の実行文脈を指す。
- `user-editable file`: installer 管理者以外が編集、差し替え、symlink 経由で誘導できる env / config / script / manifest を指す。
- privileged execution context で user-editable file を shell-source できる場合は、root ではなくても権限境界違反として扱う。

## project override 分類
- 分類表はインストーラ契約 coverage matrix の project override classification を正本とする。
- 本ガイドでは、分類表の条件や severity を再定義しない。

## severity 判定
- `blocker`: core safety invariant への到達可能な違反、または runtime-script 監査側で blocker に分類される違反がある。
- `major`: 監査対象として確定した期待成果物が存在しない、または契約 surface はあるが、fixture、state、audit、rollback、source mode、検証済み入力一致、project override classification に必要な証跡が不足している。または危険になり得る設計だが blocker の到達可能性を証跡で確認できない。
- `minor`: ドキュメントの境界説明、ログ粒度、診断メッセージ、fixture 名寄せなど、準拠判定の中核 invariant を直接壊さない改善。
- `none`: project override classification が finding 不要と分類し、core safety invariant への到達可能な違反や証跡不足がない。
- installer が配置または生成する runtime script の runtime-script 契約違反は、runtime-script 監査側の blocker / major 分類を installer 監査で下げずに finding として扱う。
- project SSOT が shell-source を明示している場合でも、それだけで accepted project detail にはしない。project override classification と shell-source 系 fixture の証跡で分類する。
- checksums で検証した manifest と installer が実行する manifest が別物になり得る導線は major 以上とする。実行 manifest が未検証のまま artifact 取得、配置、service 操作、activation state 変更へ到達可能なら blocker とする。
- test timeout / hang は、timeout の主体と残存状態で分類する。test harness や fixture driver の停止で installer の副作用が確認できない場合は証跡不足または検証器不備として major、installer が lock、service 停止、partial state、検証前配置を残す場合は該当 invariant の major または blocker とする。

## action / 停止要否
- `fix-now`: 正解が一意で、project SSOT、coverage matrix、fixture baseline、asset 組立証跡契約のいずれかに照らして局所修正できる。停止不要。
- `stop`: 契約と実装のどちらを真にするか、project override が bounded かどうか、または runtime-script 監査結果の解釈を判断できない場合。停止して確認する。
- `handoff`: runtime-script スキル、ci スキル、backup スキル、secret-management スキル、project SSOT など installer 外の owner で直す必要がある場合。停止して責務者へ戻す。
- `observe`: finding ではない未確認範囲、将来確認、project detail の記録。停止不要。
- `blocker` は `stop` または `fix-now` に限る。正解が一意で局所修正できない blocker は停止する。
- `major` は `fix-now`、`stop`、`handoff` のいずれかへ分類し、証跡不足であっても `observe` に落とさない。
- `minor` は `fix-now` または `observe` とする。
- `none` は `observe` とし、finding ではなく audit note または未確認範囲として記録する。

## runtime-script 監査結果の取り込み
- installer が runtime script、systemd unit、service manager 定義、EnvironmentFile を配置または生成する場合は、runtime-script 監査結果を service runtime 境界の証跡として取り込む。
- runtime-script 監査を実行できない場合の同等証跡は、runtime-script 監査ガイドの最低証跡セットと代替証跡条件を満たす場合だけ準拠証跡として扱う。
- 説明文、サンプル、実行者の口頭確認、証跡元を追跡できない summary は同等証跡として扱わない。
- runtime-script 監査結果を取り込む場合は、runtime-script 監査レポートの `判定`、`最大 severity`、`gate action`、`findings`、`blocker candidates`、`evidence gaps`、`open questions` をそのまま保持する。
- runtime-script 監査結果が `pass` または `pass with minor gaps` の場合だけ、service runtime boundary の確認済み証跡として扱える。
- runtime-script 監査結果が `major evidence gap`、`non-compliant`、`blocked by missing evidence` の場合は、installer 監査でも service runtime boundary の未解決事項として扱い、installer 側で severity や gate action を下げない。
- runtime-script 監査の `blocker candidate` は installer 監査でも blocker candidate として保持し、major evidence gap より下へ落とさない。
- runtime-script 監査の gate action が `provide evidence`、`fix before release`、`block release` の場合、installer 監査結果にも同じ停止理由を併記する。
- runtime-script 監査の audit action、停止要否、handoff 先は installer 監査結果でも保持し、installer 責務へ戻された事項を service runtime 境界の finding または evidence gap から切り離さない。

## 標準経路の所有境界
- 製品宣言・manifest以外の共通source、builder、adapter、共通テストを利用projectでGit管理していないか確認する。
- CI中のruntime取得は許容するが、固定revisionと最小資材集合を確認する。Agent Skillや保守テストをCIに取得しない。
- 検証profileの実行範囲とnative/hosted受入の不足を区別する。標準範囲は標準組立契約を正本とする。
- 参照: references/installer-standard-assembly-contract.reference.yml

## フロー
1. 監査対象を棚卸する。
   - project SSOT、release manifest、execution request、asset 組立証跡 record、coverage matrix、fixture baseline から、installer script、manifest schema、組立済み installer asset、asset checksum、manifest checksum、provenance、組立後検証結果、state / handoff state、audit log、installer が配置または生成する runtime script、systemd unit または service manager 定義、運用ドキュメント、テストを棚卸する。
   - 監査対象外のファイルを明示し、スキル文書や一般サンプルを証跡に混ぜない。
2. 判定基準を固定する。
   - 監査で使う installer の共通契約と適用可能な starter を特定し、比較元のパスと実ファイル checksum または未変更の revision、対象実装の状態を記録する。比較元を特定できなければ証跡不足として扱い、比較済み・最新版に適合と報告しない。
   - 共通構成・動作と対象実装の差分を確認し、製品固有値や許可 adapter の適合で準拠できるかを先に評価する。配置検証の成功だけで実装・動作への準拠を判断しない。
   - 準拠できない場合は、必須制約の必要性と標準経路では満たせない根拠を証跡へ照合し、project override classification で判定する。既存実装や project SSOT の記載だけで例外を正当化しない。正当性の検証前に例外を受け入れない。
   - project SSOT で判断する実装詳細、標準経路から外れる project override、core safety invariant で判断する準拠条件を分ける。
   - project-owned custom installer の実装形式を、インストーラ作成ガイドの選択基準に照らして確認する。
   - project override classification に従い、証跡不足は finding とし、残存リスクは分類結果に応じて finding または audit note として扱う。
3. 契約 surface へ対応付ける。
   - manifest contract、execution request contract、source mode contract、asset 組立証跡契約、state machine、audit log contract、audit event contract、fixture baseline のどれを各成果物が満たすべきかを対応付ける。
   - installer が runtime script を配置または生成する場合は、runtime-script スキルの監査結果、または runtime-script 監査ガイドの最低証跡セットと代替証跡条件を満たす同等証跡を service runtime 境界の証跡として対応付ける。
   - 対応する成果物が存在しない場合は「未確認」ではなく「証跡不足」として扱う。
4. blocker を先に確認する。
   - operator が検証した manifest / artifact と installer が実行に使う manifest / artifact が一致しているか。
   - manifest 再取得や fallback により、検証済み入力と実行入力が別物になり得る到達可能経路がないか。
   - installer が JRE、Node.js、package manager を取得・導入・更新する場合、project override として固定入力、検証、配置、権限、rollback または recovery が定義されているか。
   - production 入力に branch、`latest`、version range、SNAPSHOT、moving tag などの可変参照がないか。
   - checksum / signature 検証前に配置、削除、上書き、service 停止、activation state 変更をしていないか。
   - production host で source build や dependency resolve を実行する場合、project override として固定入力、toolchain、依存解決、出力検証、失敗時状態が定義されているか。
   - unsafe archive entry、manifest contract の launcher 安全不変条件で認められた launcher と必要な親ディレクトリ作成以外の managed root 外の書き込み、広い所有権変更、lock 不在、secret 永続化、audit log と state の混同がないか。
   - privileged execution context で、user-editable env / config、managed root 外の任意ファイル、symlink 経由の path を shell-source していないか。
   - installer が配置または生成する runtime script が、起動時に fetch、build、install、runtime 導入、未検証入力実行、secret 永続化、daemonize、独自 PID 管理、独自 restart 管理へ到達しないか。
5. invariant ごとに監査する。
   - coverage matrix の installer invariant、asset assembly evidence boundary、audit evidence boundary を軸に、入力固定、source mode、operation mode、runtime 前提、state / audit 分離、secret 非永続、activation strategy、配置検証、asset 組立証跡、設定・復旧境界、service runtime 境界、証跡完走性を確認する。
   - fixture catalog の expected outcome と coverage role を見て、成功証跡と違反検出証跡の両方があるかを確認する。
6. runtime overlay を確認する。
   - Java / Maven 系では固定 Maven coordinate、JRE version 照合、SNAPSHOT / moving metadata 拒否、Jar checksum、runtime script と service manager の境界を確認する。
   - Node / npm 系では固定 package version、integrity / checksum、`latest` / range 拒否、package manager version 照合、lifecycle script policy、credential 非永続を確認する。
   - installer が runtime script を配置または生成する場合は、runtime-script スキルの起動責務、手動操作、service manager handoff、PID、ログ、restart、health 境界に沿っているかを確認する。
   - runtime-script 監査で blocker / major に分類される違反または証跡不足は、installer 監査の service runtime 境界 finding として併記する。
7. テスト証跡を確認する。
   - 組立済み asset を扱う場合は、公開 asset と組立証跡 record（candidate / verification / final evidence）の checksum 対応も確認する。
   - fixture baseline に対応する成功系、失敗系、冪等再実行、rollback / handoff、dry-run、state / audit 境界のテストがあるかを確認する。
   - テストがない場合、実装が正しく見えても監査結果は「証跡不足」として扱う。
   - timeout / hang は、test harness の不備、fixture driver の不備、installer 実行の停止を分け、残存 state、lock、service、managed root、audit log の副作用を確認して severity を決める。
8. 指摘を分類する。
   - severity 判定、action / 停止要否、project override classification を基準にする。
   - runtime-script 監査結果を取り込む場合は、runtime-script 側の result class、evidence gap、blocker candidate、audit action、停止要否、handoff 先、gate action を保持する。
   - 同じ事象が複数 invariant に触れる場合は、最も高い severity を採用し、関連 invariant を finding に併記する。
9. 監査結果を出す。
   - 比較元、対象状態、共通 installer への準拠状況、準拠可能性、非準拠の根拠と検証結果を示す。準拠が必要な場合は選択した starter、製品固有の適合箇所、導入・更新の具体手順、既存資産への影響、検証方法を提示する。正当な例外は許容範囲と残存リスクを示す。
   - finding は重大度、分類、result class、audit action、停止要否、handoff 先、gate action、対象 contract / invariant、証跡パスと行番号、問題、推奨案、理想案を含める。
   - confirmed finding、blocker candidate、core evidence gap、major evidence gap、residual evidence gap、open question を分ける。
   - 問題がない場合も、確認済み invariant と残る証跡不足を明示する。
   - installer 成果物が確認できる場合は、監査結果の最後に「インストール概要の表示」に従ってインストール方法とインストール先を表示する。

## インストール概要の表示
- installer 成果物が確認できる場合、監査結果（findings）とは別に、証跡から復元した「インストール方法（インストールコマンド）」と「インストール先」を表示する。成果物が存在しない場合は、表示の代わりに証跡不足として報告する。
- 表示値は manifest（profile / channel / placement / activation / launcherPath）、distribution layout（delivery / release）、execution request（operation mode / source mode）から取得し、推測しない。
- 取得できない値は `未確認`、未設定の項目は `未設定` と表示する。配信 URL や asset 名を確認できない場合はコマンドを推測せず、`未確認` と表示する。
- インストール方法は実行するコマンドそのものを表示する。既定コマンドを Unix / Windows それぞれ1つ示し、非既定は代表例（upgrade、offline の manifest / artifact 指定）だけを示す。
  - 共有 wrapper: `curl ... | sh` / `irm ... | iex` とし、非既定は `INSTALLER_*` を `sh` 側または `$env:` 側へ付ける。
  - target-specific asset: 取得と実行（`./install-*.sh` / `-File install.ps1`）を示し、非既定は CLI 引数で示す。
- インストール先は launcher、managed root、releases、current、lock、state と、権限・所有者を実パスで示す。プレースホルダは展開前の表記のまま示し、実行時に展開されることを注記する。
- 変更・失敗時の挙動（dry-run / upgrade / repair / rollback / uninstall）を簡潔に示す。
- 表示テンプレート:

````markdown
### インストール方法（インストールコマンド）
- 配置プロファイル: <profile> / 配信: <delivery>

#### 既定（Unix）
```sh
curl -fsSL --proto '=https' --proto-redir '=https' <wrapper-url> | sh
```

#### 既定（Windows）
```powershell
powershell -ExecutionPolicy Bypass -NoProfile -Command "irm <wrapper-url> | iex"
```

#### 非既定の例
```sh
curl -fsSL --proto '=https' --proto-redir '=https' <wrapper-url> | INSTALLER_MODE=upgrade sh
curl -fsSL --proto '=https' --proto-redir '=https' <wrapper-url> | INSTALLER_SOURCE=offline INSTALLER_MANIFEST=<path> INSTALLER_ARTIFACT=<path> sh
```
```powershell
powershell -ExecutionPolicy Bypass -NoProfile -Command "$env:INSTALLER_MODE='upgrade'; irm <wrapper-url> | iex"
powershell -ExecutionPolicy Bypass -NoProfile -Command "$env:INSTALLER_MODE='upgrade'; $env:INSTALLER_SOURCE='offline'; $env:INSTALLER_MANIFEST='<path>'; $env:INSTALLER_ARTIFACT='<path>'; irm <wrapper-url> | iex"
```

#### target-specific asset 配布の場合
```sh
curl -fsSL -o <installer-asset-name>.sh <asset-url> && chmod +x <installer-asset-name>.sh && ./<installer-asset-name>.sh
./<installer-asset-name>.sh --mode upgrade --source offline --manifest <path> --artifact <path>
```
```powershell
powershell -ExecutionPolicy Bypass -File <installer-asset-name>.ps1
powershell -ExecutionPolicy Bypass -File <installer-asset-name>.ps1 -Mode upgrade -Source offline -Manifest <path> -Artifact <path>
```

### インストール先
```
<launcher-path>                       # launcher（managed root 外）
<managed-root>/                       # managed root
├── releases/<version>/
├── current -> releases/<version>
├── install.lock
└── state/install-state.json
```
- launcher: <値または未設定>
- managed root: <値>
- activation: <strategy>
- 権限: <実行ユーザー / service user / 所有者>
- 注記: `~/` や `%LOCALAPPDATA%` は installer が実行時に展開する。

### 変更・失敗時の挙動
- dry-run: 検証のみ
- upgrade: 新 release を追加して current を切替
- repair: 現在 release と launcher の整合を復元
- rollback: activation / launcher / state を戻す。data restore は含まない
- uninstall: 標準 installer の対象外

### 未確認
- <未確認の URL、Windows 実機、証跡不足など>
````

## リファレンス
### インストーラ作成ガイド
- 参照: references/define-installer.guide.md

### インストーラ manifest 契約
- 参照: references/installer-manifest-contract.reference.md

### インストーラ execution request 契約
- 参照: references/installer-execution-request-contract.reference.md

### インストーラ source mode 契約
- 参照: references/installer-source-mode-contract.reference.yml

### インストーラ asset 組立証跡契約
- 参照: references/installer-asset-assembly-evidence-contract.reference.md

### インストーラ audit log 契約
- 参照: references/installer-audit-log-contract.reference.md

### インストーラ audit event 契約
- 参照: references/installer-audit-event-contract.reference.yml

### インストーラ fixture baseline
- 参照: references/installer-fixture-baseline.reference.md

### インストーラ fixture catalog
- 参照: references/installer-fixture-catalog.reference.yml

### インストーラ契約 ID catalog
- 参照: references/installer-contract-catalog.reference.yml

### インストーラ契約 coverage matrix
- 参照: references/installer-contract-coverage.reference.yml

### インストーラ状態遷移契約
- 参照: references/installer-state-machine.reference.md

### runtime-script 監査ガイド
- 参照: runtime-script スキルの監査ガイド
