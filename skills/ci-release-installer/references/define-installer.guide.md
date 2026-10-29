# インストーラ作成ガイド

## 目的
- GitHub 管理のソース、Release asset、Packages、npm・Maven などの外部リポジトリから取得する資材を、検証可能で冪等な状態収束処理として設計・実装・レビューできるようにする。

## 選択条件
- GitHub の source archive / Release asset / Packages、npm・Maven などの registry artifact、manifest、checksum、署名、設定ファイル、service manager、DB、永続データを扱う installer を作る。
- 既存 installer の安全性、失敗時挙動、ドキュメント整合を確認する。

## 関連スキル
- 任意: temp-management, runtime-script, env, secret-management, test

## 標準経路と project override
- 標準経路は、安全な既定値とレビューの出発点であり、すべての project に同じ運用形態を強制するものではない。
- 標準経路から外れる場合は、project override classification に必要な証跡を project SSOT に残す。
- project override があっても、インストーラ契約 coverage matrix の core safety invariant は緩和しない。
- 例外は `--force` のような包括 option で扱わず、runtime bootstrap、source build、interactive setup、data restore など責務別に分ける。
- 監査では、標準経路との差分を即 blocker にせず、project override classification に従って分類する。

## 固定URL配信と pipe 実行
- 固定 HTTPS URL から pipe 実行する標準導線（`curl ... | sh` / `irm ... | iex`）は、次を満たす場合だけ採用してよい。
  - 配信 URL は project SSOT が固定した HTTPS URL とし、ユーザー入力や可変参照にしない。
  - wrapper は Unix では POSIX sh 互換、Windows では iex 互換とし、ファイル実行と同じ検証・失敗時状態の契約を満たす。
  - wrapper 自体は配信 URL と TLS を信頼する。payload（platform installer、manifest、artifact、archive）は実行前に checksum 検証する。
  - 検証完了前に managed root、handoff state、activation state、service、install state への破壊的副作用を起こさない。pipe の途中終了でも検証前の段階で停止する。
  - 非既定の operation mode / source mode は環境変数で選択し、pipe の引数に依存しない。
- Windowsの実行方式は`references/use-standard-installer.guide.md`の「Windowsの実行方式の選択」に従う。標準のオンラインコマンドは`assets/examples/readme-installation.example.md`を参照する。Windows共有wrapperは必要性と対応を確認した非標準extensionに限り、同じ起動オプションで取得URLをその固定wrapper URLへ置き換える。
- Unix共有wrapperの配信コマンド例:
  - Unix: `curl -fsSL --proto '=https' --proto-redir '=https' <wrapper-url> | sh`
- 共有 Unix wrapper は、プラットフォームを実行時に検出し、検証済み platform installer を選んで実行する。wrapper と platform installer は別 asset として公開し、組立証跡で対応付ける。

## 製品宣言と配置
- 製品宣言の配置、配置プロファイル、managed root の標準配置は、インストーラ manifest 契約の「製品宣言と配置の標準」に従う。

## 用途と標準runtimeの選択
- use case契約の `distributionAsset` を確認し、標準組立ガイドを使う。標準GitHub Release nativeは固定Actionまたは配布CLIに委譲し、project側に共通実装・共通テスト・builder・adapterを持たせない。
- 製品固有のmanifest・配置・宣言だけをGit管理する。CI実行中の資材取得と、projectにコミットするsourceは分ける。
- 共有wrapperの標準提供範囲はUnixの2platform。Windows共有wrapperは標準対象外で、必要性が確認された場合のみ共通拡張または明示owner extensionを検討する。
- Maven/npmは入力契約と例を提供するが、標準実行engineは提供しない。個別実装が本当に必要かはpackage managerの既存機能と製品要求から判断する。
- providerの共通回帰と、製品の実manifest・archiveを使うcandidate検証を分ける。profile成功だけでinstall/upgrade/rollback等の全受入を保証しない。
- 固定 provider runtime の installer は、Unixのアーカイブ展開にOS提供の`tar`を存在確認して使い、無い場合は展開の前に失敗する。WindowsのZIP展開には.NETのAPIを使う。取得は Unix が `curl`、Windows が PowerShell の HTTPS 取得を使う。
- 参照: references/use-standard-installer.guide.md

## フロー
1. インストーラの責務を固定する。
   - 取得、検証、配置、切替、起動確認、rollback のうち、どこまでを installer が担当するか決める。
   - 対象 platform は標準候補から選び、単一または複数の選択結果を入力契約と配布単位へ反映する。
   - 標準経路では、JRE、Node.js、package manager などの実行基盤は事前インストール済み前提とし、installer は取得・導入・更新しない。
   - runtime bootstrap を project override として扱う場合は、取得元、version、checksum、署名、配置先、権限、rollback または recovery、既存 runtime との衝突条件を固定する。
   - 標準経路では、production installer は source archive から暗黙に build せず、CI 生成済み artifact または registry artifact を配置する。
   - source build を project override として扱う場合は、依存解決を固定し、build 入力、toolchain、lockfile、出力 checksum、失敗時残存状態を検証対象に含める。
   - production で source archive を扱う場合は、archive 自体を検証済み配布物として扱い、本番 host での build や dependency resolve を伴わせない。
   - アプリケーション設定、secret 発行、DB 復旧、監視設定などを installer 外に置く場合は、その境界を明示する。
2. 入力を固定する。
   - version、manifest、artifact URL、checksum、署名、required runtime を単一の入力契約へ集約する。
   - production / release 用 installer では、manifest contract を入力正本にする。
   - GitHub source archive を使う場合は tag または commit SHA を固定し、branch 名を release 入力にしない。
   - GitHub Release asset を使う場合は asset 名、release tag、checksum と任意の署名を固定する。
   - GitHub Packages、npm、Maven などを使う場合は registry URL、group/name/artifact/package coordinate、version、checksum と任意の署名検証を固定する。
   - `latest`、version range、SNAPSHOT、moving tag などの可変参照は、明示的な開発用途以外では禁止する。
   - `checksums` や署名で検証した manifest を使う場合、実行時も同じ manifest を参照する。
   - remote URL から再取得する導線を残す場合は、未検証入力を使う導線として明示オプションにする。
   - production manifest の未知 field は拒否し、拡張は schema version で扱う。
3. 取得元の信頼境界を定義する。
   - 許可する host、registry、repository owner、package namespace を allowlist として扱う。
   - 認証 token は実行時注入に限定し、設定ファイル、manifest、ログ、サンプルへ保存しない。
   - download retry は同じ固定入力に対してだけ行い、fallback URL や別 registry へ暗黙に切り替えない。
   - cache を使う場合も、cache hit を checksum / signature 検証なしで信頼しない。
4. managed root を狭く定義する。
   - managed root は1つに限定する。root 外の launcher と必要な親ディレクトリ作成はインストーラ manifest 契約の「launcher 安全不変条件」に従う。
   - 親 traversal、symlink component を拒否する。
   - managed root の深さ、拒否対象、OS 予約領域配下の許可例外は、インストーラ manifest 契約の「配置プロファイルと managed root」に従う。
   - 標準経路で扱えないシステム配置は project override として証跡を残す。
   - 所有権変更や権限変更は managed root 内に閉じる。
5. 事前検証を先に終える。
   - 必須コマンド、runtime version、service user、空き権限、既存ファイル種別、lock 取得を切替前に確認する。lock の扱いは `references/installer-manifest-contract.reference.md` の標準境界に従う。
   - runtime bootstrap 対象外の JRE、Node.js、package manager などが存在しない、または manifest の要求 version を満たさない場合は、資材配置、handoff state 記録、activation state 変更前に失敗する。
   - 起動確認を行う場合は、設定ファイルと runtime asset の可読性を handoff state 記録または activation state 変更前に検証する。
6. staging に配置してから commit する。
   - 配布物はリポジトリの追跡対象外の一時ファイルへ取得し、checksum / signature / archive entry を検証してから正規パスへ移す。プロジェクト内へ置く場合は `.gitignore` で除外する。
   - archive を展開する場合は absolute path、parent traversal、symlink entry を拒否し、permission は installer 側で明示設定する。
   - manifest に指定された verified placement asset は artifact と同じく checksum / signature を検証してから正規パスへ反映する。
   - 既存ファイルを退避・削除するのは、新しいファイルの検証完了後に限定する。
   - activation strategy に応じた switch は symlink rename、pointer file update、in-place target 反映、external handoff state 記録などから固定する。
7. 既存データと設定を保護する。
   - DB、ユーザー編集済み設定、secret、アップロード済みデータは既定で上書きしない。
   - backup は自動作成してよいが、restore の自動実行は破壊範囲が明確な場合に限定する。
   - migration 後 rollback が必要な場合は、artifact rollback と data restore を別判断にする。
8. 設定ファイルを安全に読む。
   - installer が値を読むだけなら、設定ファイルを shell として実行せず、`KEY=VALUE` と quote 程度に限定した parser で読む。
   - command substitution、`export`、複数行、`source` は設定ファイル文法として扱わない。
   - shell source を許す場合は、入力が信頼済みであること、実行権限、実行される内容、失敗時状態を明示する。
   - token や secret は installer 実行時に注入し、runtime env やサンプルファイルへ保存しない。
9. service manager との責務分担を確認する。
   - systemd などと runtime script の間の環境変数、PID、ログ、restart の責務分担は runtime-script スキルに従い、同じ責務を重複定義しない。
   - installer が runtime script を配置または生成する場合、起動責務、手動操作、service manager handoff、PID、ログ、restart、health 境界は runtime-script スキルの契約に従う。
10. 失敗時状態を定義する。
   - 状態遷移と失敗時の残存状態は、インストーラ状態遷移契約を基準に整理する。
   - download / verify 失敗では handoff state と activation state を変更しない。
   - installer が health / rollback を担当する strategy では、restart / health check 失敗時に前 release があれば activation state を戻し、初回導入なら failed activation state を残さない。
   - rollback は失敗時に初めて考えず、switch / health / record 前に変更済み resource ごとの rollback plan として固定する。
   - rollback plan では activation state、service manager state、process state、shared asset、install state / handoff state、audit result、data restore の扱いを分ける。
   - data restore は標準 rollback に含めず、明示 contract がある場合だけ別処理として扱う。
   - 失敗後も既存 DB、既存設定、既存 secret が残っていることを確認できるようにする。
11. テストとドキュメントを揃える。
   - fixture baseline を先に固定し、成功系、失敗系、再実行、rollback の最低確認範囲を実装差分から分離する。
   - テストは fixture で成功系、checksum 不一致、runtime 不足、取得元境界、execution request 境界、未知 manifest field、unsafe archive / config、cache / offline 検証、lock 競合、冪等再実行、state / audit 境界、installer が担当する restart rollback または external handoff を最低限確認する。
   - project 内テストでは、選択した各実装が担当する入力と、実装形式の選択基準で定めた合格条件を検証する。
   - CI など installer 外で installer asset を組み立てる場合、インストーラ asset 組立証跡契約に従い、組立済み asset、manifest、payload、provenance、検証結果を同じ証跡 record で対応付ける。
   - ドキュメントの実行例は、検証済み入力と installer 実行入力が一致する形で書く。
   - 「installer が行うこと」と「運用者が別途行うこと」を同じ文章で混ぜない。

## 基本で決めること
- 対応 OS / service manager:
  - 標準候補は、利用者要求や project SSOT による事前指定がなくても、設計時にいずれも選択できるようにする。
  - 選択した platform ごとに、Linux + systemd、macOS + launchd または手動 runtime script、Windows + Windows service または手動 runtime script など、service manager 境界を明示的に固定する。
  - platform 固有の path、archive、service manager の差分は各実装で扱ってよい。共通 core や adapter の導入は、実際に重複を減らし、保守性を改善できる場合だけ検討する。
- installer 実装言語:
  - 実装言語は、利用者が installer を取得して実行するまでに必要な前提 runtime を最小化する方向で選ぶ。
  - Linux / macOS では shell、Windows では PowerShell など、対象 platform の標準スクリプト環境を既定にする。スクリプトは wrapper に限定せず、安全条件を簡潔に満たせる範囲で installer 本体としてよい。
  - 固定済み資材の取得、checksum 検証、staging、atomic な切替、失敗時の非活性化を標準コマンドで明瞭に実装できる場合は、スクリプトを維持する。
  - 信頼できない構造化入力の厳密な解析、安全な archive 展開、堅牢な lock・状態・rollback 管理、権限境界、または platform 間の同一挙動をスクリプトで安全かつ保守可能に実現できない場合は、Go / Rust などの native executable を選ぶ。
  - native executable の自己完結性は選択後の配布特性であり、すべての installer に要求する選択基準にはしない。
  - Python、Node.js、Java など runtime 前提の実装は、その runtime が installer 実行前から保証され、追加依存を正当化できる場合だけ選ぶ。標準スクリプトと native executable の間に必須の共通 core として置かない。
  - platform 間で実装や検証コードを共有することは要求しない。固定入力、完全性検証、検証前の非活性化、失敗時に不完全な配置を残さないこと、非ゼロ終了を共通の合格条件とし、各実装で確認する。
  - PowerShell は Windows の標準スクリプト候補とし、Linux / macOS の実行前提にしない。
  - アプリケーションの実装言語と installer 実装言語は分けて判断し、同一言語にする場合も配布前提、保守体制、検証容易性を理由として記録する。
- installer 実装分割:
  - 巨大化した installer は、配布単位と保守単位を分ける。
  - GitHub Release asset として配布する導線では、利用者が取得・実行する配布単位を単一 wrapper、または wrapper と固定済み payload archive に固定してよい。選択した platform 間で wrapper、archive、実行形式が異なる場合は platform 別配布を検討する。
  - shell installer を GitHub Release asset として直接公開する場合、Linux / macOS 共通の asset 名は `install.sh`、Windows の asset 名は `install.ps1` を推奨する。platform ごとに内容の異なる同名 asset が必要なら、名前で区別する。標準 GitHub Release native runtime は組立済みの単体スクリプトを公開する。
  - 共有 wrapper を固定 URL 配信する場合は、共有 `install.sh`（POSIX sh bootstrap）とプラットフォーム別 platform installer（検証済み payload）を別 asset として公開する。wrapper は platform を実行時に検出し、選んだ payload を checksum 検証してから実行し、検証前に破壊的副作用を起こさない。
  - 利用先の installer source は project owner の正本として扱い、製品宣言と同じ `.ci/installer/` 配下へ置く。スキル専用の隠し領域へは置かない。
  - CI など installer 外で wrapper と payload archive を組み立てる場合、asset の組立と検証証跡はインストーラ asset 組立証跡契約に従う。workflow trigger、job 分割、runner trust、permissions、cache、release publish 手順は ci スキルの責務として扱う。
  - CIとローカルでは同じ固定provider runtimeを使う。project-owned custom sourceは標準では満たせない要求に限定する。
  - CI実行時にAgent Skillをダウンロードしない。Action同梱のruntimeだけを使い、ローカルは固定配布CLIを管理外領域へ取得する。共通builder・fixtureをprojectへコピーしない。
  - 保守単位は処理順ではなく、manifest、execution request、source、verify、staging、activation、state、audit、runtime prerequisite、service manager、config、rollback、permission などの契約境界で分ける。
  - shell installer を単一 file で配布する場合は、保守用 fragment を契約境界ごとに分け、builder が固定順序で結合する。fragment inventory は絶対 path、parent traversal、未許可配置、placeholder 重複を拒否する。
  - manifest schema から installer に埋め込む key contract を生成する場合、schema を正本とし、手書き allowlist と schema が分岐しないようにする。
  - `main`、`run`、`orchestrator` などの入口は phase 呼び出しと失敗時 finalize に寄せ、manifest 検証、取得、checksum、配置、activation、state、audit、service 操作の詳細を集約しない。
  - state と audit は別 module / fragment に分け、install state / handoff state を現在状態、audit log を実行履歴として扱う。audit log を現在状態の判定に使わない。
  - service manager 連携は runtime script 境界に委譲し、systemd unit 生成、reload / enable、restart / health、rollback を activation や state と混ぜない。
  - 構造退行検査では、fragment 順序、生成 contract の差し込み位置、禁止 fragment 名への退行、unsafe fragment inventory、入口が service / rollback 分岐を正しく dispatch することを確認する。
- migration の責務:
  - DB migration は既定で自動実行しない。
  - installer から実行する場合は明示 option とし、artifact rollback と data restore を分離する。
- cache / offline install:
  - offline install は通常 download とは別 source mode として定義し、operation mode とは混ぜず、同じ検証契約を通す。
- operation mode:
  - 既存状態から暗黙に mode を推測する場合も、実行前に選択された mode をログへ出す。
- 設定ファイルの所有者:
  - installer 管理設定とユーザー管理設定を分ける。
  - ユーザー編集済み設定は merge せず、既定では上書きしない。
- secret / token の注入元:
  - 環境変数、secret manager、CI runtime injection など、許可する注入元を限定する。
- signature key / checksum の管理元:
  - signature を使う場合は、署名鍵の信頼元と key rotation の扱いを manifest 外で固定する。
- 複数 instance:
  - 初期は single instance を基本にする。
  - 複数 instance を扱う場合は managed root、service name、port、lock path、install state、handoff state を instance id で分離する。
- 保持世代数:
  - release artifact は直近2から3世代を推奨する。
  - data backup の保持数と復旧手順は installer 外の backup / restore 契約で決める。

## 必要になったら決めること
- artifact provenance:
  - artifact が作られた source commit、tag、CI run id を manifest、install state、handoff state のいずれかに記録する。
  - provenance 署名や attestation の検証は release gate 側を基本にし、installer は合格済み artifact を扱う。
- roll forward 方針:
  - rollback 不可の変更、特に DB migration 後は roll forward 条件を明示する。
  - rollback、roll forward、manual recovery のどれに委ねるかを installer 実行前に判断できる形へ分ける。
- 監査対象外:
  - OS patch、runtime install、DB restore、secret 発行など installer が扱わない範囲を明示する。
  - install、release、operation、recovery の責務を同じ installer に混ぜない。

## 代表 overlay
### Java / Maven 系
- 入力契約:
  - 共通 manifest contract に Java / Maven overlay を追加する。
  - Maven repository URL、`groupId`、`artifactId`、`version`、artifact file name、artifact checksum と任意の署名を固定する。
  - GitHub Packages など認証付き Maven repository を使う場合、read token は installer 実行時だけ注入する。
- 配置単位:
  - 検証済み Jar を activation strategy に応じた placement target へ配置または反映する。
  - application config、secret、DB、log、dictionary などの runtime data は release directory の外に置く。
- runtime:
  - Jar 用 runtime script を配置または生成する場合は、runtime-script スキルの Java / Spring Boot Jar 向け導線に従う。
- 検証観点:
  - Jar checksum 不一致、Java version 不足、`SNAPSHOT` 拒否、既存 DB 保持、installer が担当する restart / health check 失敗時 rollback または external handoff を fixture で確認する。

### Node / npm 系
- 入力契約:
  - 共通 manifest contract に Node / npm overlay を追加する。
  - npm registry URL、package name、version、tarball URL または lockfile、integrity / checksum を固定する。
  - private registry や GitHub Packages を使う場合、read token は installer 実行時だけ注入し、`.npmrc` や runtime env へ保存しない。
- 配置単位:
  - npm package tarball を取得する場合は、tarball を staging へ展開し、integrity / checksum と expected files を検証してから activation strategy に応じた placement target へ配置または反映する。
  - lockfile から依存を解決する場合は、`npm ci` や同等の frozen install を staging で実行する方式を候補にし、lockfile と package manager version を固定する。
  - 本番ホストで build するか、CI 生成済み artifact を配置するかを先に決め、暗黙に build step を増やさない。
- runtime:
  - Node.js 用 runtime script を配置または生成する場合は、runtime-script スキルの Node 向け導線に従う。
  - `postinstall` など lifecycle script は既定で信用せず、必要な場合だけ共通 lifecycle hook policy で許可理由と検証範囲を明示する。
- 検証観点:
  - integrity 不一致、未許可 registry、`latest` / range 拒否、lockfile 不一致、lifecycle script の扱い、installer が担当する restart / health check 失敗時 rollback または external handoff を fixture で確認する。

## リファレンス
### インストーラ use case 契約
- 参照: references/installer-use-case-contract.reference.yml

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

### インストーラ入力サンプル
- 参照: references/installer-input-examples.reference.md

## 注意
- installer は便利な運用スクリプトではなく、対象環境の状態を変更する境界面として扱う。
- dry-run を作る場合は、実行と同じ検証を使い、状態遷移契約の副作用可否に従って永続変更だけを抑止する。
- 外部リポジトリからの取得は network 成功を信頼根拠にしない。成功後に固定入力との一致を必ず検証する。

## アンチパターン
- 検証条件（固定 HTTPS、実行前の payload 検証、検証前の副作用なし、POSIX sh / iex 互換）を満たさない `curl | bash` を標準導線にする。
- 安全条件を明瞭に満たせない複雑な解析、archive 展開、状態遷移を、実装形式を再評価せず shell script へ継ぎ足す。
- アプリケーション runtime と同じだからという理由だけで、preflight、version 固定、依存解決方針、事前テスト証跡なしに installer 実装言語を選ぶ。
- shell fragment を処理順だけで分け、fragment inventory、生成 contract、構造退行検査を持たない。
- `main` fragment に manifest 検証、download、checksum、staging、activation、state、audit、service rollback を集約し続ける。
- root で広いディレクトリに `chown -R` する。
- fixture なしで本番に近いパスや実サービスだけを使って installer テストを行う。

## 完了確認
- [ ] 対象 platform の選択が project の入力に反映されている。該当する use case がある場合はその選択と、テンプレートがあれば配置への適用結果を確認できる。該当する use case またはテンプレートがない場合は、その判断を確認できる。
- [ ] manifest、execution request、source mode、状態遷移の各契約と project SSOT で、入力・副作用・失敗時状態を確認できる。
- [ ] インストーラ契約 coverage matrix と fixture baseline に対応するテスト証跡がある。
- [ ] installer asset を組み立てる場合、組立済み asset と入力・検証結果がインストーラ asset 組立証跡契約で対応付く。
- [ ] 固定 URL 配信を使う場合、wrapper と platform installer が組立証跡で対応付き、実行前に checksum 検証され、検証前に破壊的副作用を起こさない。
- [ ] 配置プロファイル（既定 per-user-cli / system-wide）と launcher base が契約に一致し、launcher の衝突・rollback を確認できる。
- [ ] 運用ドキュメントの実行入力が検証済み入力と一致する。
