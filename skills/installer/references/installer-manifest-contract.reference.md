# インストーラ manifest 契約

## 理解できること
- production / release 用 installer の入力 manifest に固定すべき必須項目、任意項目、禁止項目
- GitHub Release native asset、Java / Maven 系、Node / npm 系の overlay 境界
- 標準経路で installer が管理しない実行基盤と、存在しない場合の失敗条件

## 補足
- 本契約は installer が読む入力の論理構造を定義する。
- 具体的なファイル形式は JSON / YAML / TOML のいずれでもよいが、同一プロジェクト内では1形式に固定する。
- 既存プロジェクトの SSOT がない場合、新規 manifest 形式は JSON を推奨する。
- manifest は配布物取得、検証、配置、切替、起動確認の入力正本とする。
- operation mode、dry-run、operator、実行時 option は manifest ではなく execution request で扱う。
- overlay は共通項目に追加する差分であり、共通項目を置き換えるものではない。runtime prerequisite だけは use case 契約に従い、self-contained native asset では持たず、Maven / npm では必須とする。
- installer は対応する schema version 範囲を持ち、範囲外の manifest を拒否する。
- `targetPlatformId` を追加する既存 project schema は version を上げ、旧 schema を同じ version のまま再解釈しない。
- 標準経路から外れる runtime bootstrap、source build、interactive setup、data restore は、共通 manifest の項目を曖昧に拡張せず、project SSOT または project adapter の別契約で扱う。
- project override がある場合も、共通 manifest はインストーラ契約 coverage matrix の core safety invariant を壊さない。

## 標準境界
- checksum は必須とし、signature は任意とする。signature を使う場合も checksum と同じ検証段階で扱う。
- 標準経路では、production installer は source archive から暗黙に build しない。build が必要な場合は CI など installer 外で artifact を生成する。
- production で source archive を扱う場合は、archive 自体を検証済み配布物として扱い、本番 host での build や dependency resolve を伴わせない。
- installer は同一 managed root の lock を必ず取得し、並行実行を拒否する。
- managed root の通常配置は service user で行い、root 権限は system service 登録や owner 正規化など必要な操作に限定する。
- artifact rollback と data restore は分離する。data restore は明示 contract がある場合だけ扱う。
- lifecycle script や hook は既定で禁止し、必要な場合だけ共通の lifecycle hook policy で明示許可する。
- artifact、shared asset、SBOM は verified placement asset として扱う。
- shared asset と SBOM は任意項目だが、使う場合は artifact と同じく checksum / signature 検証を必須にする。
- manifest に指定された verified placement asset の検証が1つでも失敗した場合、installer は commit phase に進まない。
- uninstall / cleanup は標準 installer に含めず、別運用または別 command として扱う。
- installer が health / rollback を担当する場合、health check は process 起動だけでなく、URL または command の成功条件、timeout、retry、失敗時 rollback を固定する。
- service 停止は artifact と manifest に指定されたすべての verified placement asset の検証完了後に限定し、activation strategy に応じた switch と restart が必要な場合だけ、その直前に寄せる。
- activation strategy は installer が検証済み release を稼働対象へ反映する方法、または外部切替へ引き渡す方法を表し、switch phase の責務を固定する。
- production installer は install state を現在状態の正本として必須にする。
- per-user プロファイルでは Unix は `~/...`、Windows は `%LOCALAPPDATA%\...` / `%USERPROFILE%\...` のプレースホルダを許可し、installer が実行時に展開する。system-wide は絶対パスを使う。
- managed root / launcher は選択したプロファイルの許可 base に一致させ、launcher は managed root 外に置く。
- launcher の配置許可 base、installer 管理判定、衝突時の扱いは「launcher 安全不変条件」を正本とする。
- `external-orchestrated` では install state を未反映 release の成功状態として更新せず、検証済み release の引き渡しは handoff state に分ける。
- install state は既存プロジェクトの SSOT がない場合 JSON を推奨する。
- installer は SBOM や vulnerability scan result を生成しない。添付済み SBOM を扱う場合だけ検証、配置、記録する。
- audit log は install state から分離する。audit log を扱う場合、manifest は audit log path と audit log policy を持ち、実行主体、実行時刻、理由は execution request から受け取る。
- config schema を扱う場合、manifest は config schema reference と config schema version だけを持つ。schema 定義本体は project SSOT とし、installer は project adapter が解決した schema で required key / deprecated key の検証だけを行い、ユーザー設定を自動 merge しない。
- rollback 不可の変更がある場合は、roll forward または manual recovery の条件を manifest に明示する。
- required installer version を満たさない installer は manifest を拒否する。

## launcher 安全不変条件
- launcher は managed root 外に置き、配置プロファイル別の許可 base（per-user は `~/.local/bin` または `%LOCALAPPDATA%\Programs`、system-wide は `/usr/local/bin` または `%ProgramFiles%`）に限定する。
- launcher path は空要素、`.`、`..` を含めない。installer は組立時と runtime の両方で同じ基準で拒否する。
- system-wide の launcher は絶対パスで指定する。Unix は組立時と runtime で許可 base 配下かを判定する。Windows は組立時に Windows 絶対パス構文を検証し、runtime で対象ホストの `ProgramFiles` 配下かを判定する。
- launcher の親経路に symlink / reparse point がある場合は変更前に拒否し、current 切替直前と launcher 配置直前にも再確認する。Unix の管理済み launcher 自体の symlink は許可する。
- 既存 launcher が installer 管理かどうかは、次で判定する。
  - install state が無い場合、既存 launcher はすべて非管理として扱う。
  - install state がある場合、`launcherPath` が manifest の launcher path と一致し、かつ
    - Unix: 既存 launcher が symlink で、link 先が `current` 配下の対象 binary（`<current-pointer>/<relative-binary>`）と一致する。
    - Windows: 既存 launcher の内容 checksum が install state の `binaryChecksum` と一致する（copy モード）。
- 管理外 launcher を検出した場合、installer は launcher を変更せず、release、handoff state、activation state、install state を作成・更新しない。preflight で作成した managed root 内の lock は cleanup で解放する。
- starter 標準の launcher は Unix は symlink、Windows は copy とする。Windows の shim は starter 標準では扱わず、使う project は launcher 用 checksum を install state に追加する project override として共通 manifest の外側で扱う。

## validation policy
- production manifest の未知 field は拒否する。拡張は schema version を上げて扱う。
- managed root は filesystem root、Windows drive root、ホームディレクトリそのもの、OS 予約領域を拒否し、`<base>/<app...>` の深さと、インストーラ作成ガイドが定める許可例外の範囲で検証する。
- production download URL は `https://` を基本とし、`file://` は fixture / test だけで許可する。
- proxy は明示設定だけ許可し、production では TLS 検証無効化を禁止する。
- archive 展開では absolute path、parent traversal、symlink entry を拒否する。
- archive entry の permission をそのまま信頼せず、installer 側で明示的に設定する。
- 設定ファイル parser は `KEY=VALUE` と single quote / double quote 程度に限定する。
- command substitution、`export`、複数行、`source` は設定ファイル文法として許可しない。
- ログには version、artifact checksum、manifest checksum、配置先、状態遷移を出してよい。
- token、secret、auth header、env value はログへ出さない。
- token、secret、auth header は manifest、sample、install state、handoff state にも保存しない。
- 失敗時は非ゼロ exit とする。原因別 exit code は必要になった場合だけ追加する。
- 同一 manifest checksum / artifact checksum の再実行は成功扱いにしてよい。異なる checksum は明示 option なしでは失敗する。
- force option は用途別に分ける。checksum mismatch 無視は許可しない。

## fixture baseline の扱い
- manifest 契約で要求する検証 fixture の詳細は、インストーラ fixture baseline を正本とする。
- 本契約では fixture 名を再列挙せず、manifest の必須項目、任意項目、禁止項目、受け入れ条件だけを定義する。

## verified placement asset
- verified placement asset は、installer が検証後に配置または記録する配布単位を表す。
- artifact、shared asset、SBOM は同じ verified placement asset 検証規則に従う。
- verified placement asset を manifest に含める場合、取得元、配置先、file name、checksum と任意の signature を固定する。
- verified placement asset の checksum / signature が一致しない場合、installer は commit phase に進まない。

| 項目 | 意味 |
| --- | --- |
| kind | artifact / shared asset / SBOM などの資材種別 |
| source URL or package coordinate | 取得元。許可済み host / registry / repository owner / package namespace に限る |
| file name | staging と配置時に期待するファイル名 |
| placement path | managed root 内の配置先または handoff 記録先 |
| checksum | network 成功後に照合する完全性情報 |
| optional signature | signature を使う場合の検証情報 |

## activation strategy
- activation strategy は `active-pointer`、`in-place`、`external-orchestrated` のいずれかを基本にする。
- activation strategy は operation mode ではなく、manifest が固定する配置・切替方式である。
- activation strategy ごとの switch phase の扱いは、インストーラ状態遷移契約を正本とする。

| 値 | 意味 |
| --- | --- |
| active-pointer | current link や pointer file などの active release pointer を installer が切り替える |
| in-place | 検証済み staging を in-place target path へ反映し、active release pointer switch は行わない |
| external-orchestrated | installer は検証済み release を handoff state に記録し、稼働対象への切替と現在 install state の更新は外部 orchestration に委ねる |

## 必須項目
| 区分 | 項目 | 意味 |
| --- | --- | --- |
| identity | schema version | manifest の互換性判定 |
| identity | release version | installer が収束させる固定 version |
| identity | target platform id | use case 契約で許可された対象 OS / architecture の識別子 |
| source | source kind | GitHub source archive / Release asset / package registry などの取得種別 |
| source | owner / repository / registry | 許可する取得元境界 |
| source | fixed reference | tag / commit / asset name / package coordinate など、moving reference ではない固定取得単位 |
| artifact | artifact URL | 固定 version に対応する取得 URL |
| artifact | file name | staging と配置時に期待するファイル名 |
| artifact | checksum / optional signature | network 成功後に照合する完全性情報。checksum は必須、signature は任意 |
| placement | managed root | installer が変更してよい root |
| placement | placement target path | activation strategy に応じた配置先。`active-pointer` と `external-orchestrated` では不変 release path、`in-place` では反映先 target path |
| activation | activation strategy | `active-pointer` / `in-place` / `external-orchestrated` のいずれか |
| concurrency | lock path | 同一 managed root の並行実行を拒否する lock |
| state | install state path | production installer の現在状態を記録する path |

## 条件付き必須項目
| 区分 | 項目 | 意味 |
| --- | --- | --- |
| runtime | runtime kind | external runtime を要求する use case で使う Java / Node.js などの実行基盤種別 |
| runtime | required version | external runtime を要求する use case で、事前インストール済み runtime に要求する version |
| placement | active release pointer | `active-pointer` で稼働対象を切り替える path。current link や pointer file などの具体方式 |
| state | handoff state path | `external-orchestrated` で検証済み release を外部 orchestration へ引き渡す記録先 |

## 任意項目
| 区分 | 項目 | 意味 |
| --- | --- | --- |
| placement | profile | `per-user-cli`（既定）または `system-wide`の配置プロファイル |
| placement | channel | 配信チャネル。省略時は `standalone`。store パスの一部として使う |
| activation | launcher path | managed root 外に置く PATH 上のランチャー。プロファイル別許可 base に限定する |
| shared asset | shared asset source URL | 辞書、静的 asset など release 間で共有する資材の取得元 |
| shared asset | shared asset file name | shared asset の staging と配置時に期待するファイル名 |
| shared asset | shared asset path | shared asset の配置先 |
| shared asset | shared asset checksum / optional signature | shared asset を検証する完全性情報 |
| config | env path | runtime が読む設定ファイル path |
| health | health check | installer が restart / health を担当する場合に確認する URL / command / timeout |
| health | retry policy | installer が health / rollback を担当する場合の retry 回数、間隔、失敗時 rollback の扱い |
| provenance | source commit | artifact を生成した source commit |
| provenance | source tag | artifact を生成した tag |
| provenance | CI run id | artifact を生成した CI run |
| supply chain | SBOM source URL | 添付済み SBOM の取得元 |
| supply chain | SBOM file name | SBOM の staging と配置時に期待するファイル名 |
| supply chain | SBOM path | 添付済み SBOM の配置先または記録先 |
| supply chain | SBOM checksum / optional signature | 添付済み SBOM を検証する完全性情報 |
| compatibility | required installer version | manifest を処理できる installer の minimum version |
| compatibility | config schema reference | project SSOT にある config schema を project adapter が解決するための参照 |
| compatibility | config schema version | 設定互換性を確認する schema version |
| execution policy | lifecycle hook policy | lifecycle script / hook を拒否するか、明示許可する場合の検証範囲 |
| service | service name / user / group | service manager を生成・更新する場合の service 境界 |
| service | instance id | 複数 instance を扱う場合に managed root、service name、port、lock path を分離する識別子 |
| audit | audit log path | 実行記録の追記先。記録内容は audit log 契約に従う |
| audit | audit log policy | audit log 書き込みを required / best-effort のどちらで扱うか |
| rollback | rollback strategy | artifact / activation state rollback の範囲。data restore とは分離する |
| recovery | roll forward policy | rollback 不可時に次 version へ進める条件 |

## 共有 wrapper 配信での扱い
- 共有 wrapper 配信でも manifest は platform ごとの本契約（`targetPlatformId` を持つ）を維持する。
- 共有 wrapper は platform installer を検証して実行するだけで、manifest の再解釈や上書きを行わない。
- wrapper と platform installer の対応はインストーラ use case 契約の delivery と、インストーラ asset 組立証跡契約で扱う。

## install state 推奨項目
| 項目 | 意味 |
| --- | --- |
| release version | install 後の固定 version |
| artifact checksum | 配置した artifact の checksum |
| manifest checksum | 入力 manifest の checksum |
| installed at | install を完了した時刻 |
| previous release | rollback 判断に使う直前 release |
| installer version | install を実行した installer の version |
| launcher path | 実行時に設置した launcher のパス。launcher がない場合は空 |
| source commit / tag / CI run id | artifact provenance の最小記録 |
| SBOM checksum | SBOM を配置した場合の検証記録 |
| activation strategy | 現在状態に反映済みの activation strategy |
| activation state | active pointer、in-place target、または project SSOT が定める現在稼働対象 |
| handoff state reference | 外部切替待ち release がある場合だけ参照する handoff state |

## handoff state 推奨項目
| 項目 | 意味 |
| --- | --- |
| release version | 外部切替へ引き渡す固定 version |
| artifact checksum | 検証済み artifact の checksum |
| manifest checksum | 入力 manifest の checksum |
| handoff recorded at | handoff state を記録した時刻 |
| previous release | 外部 orchestration が切替判断に使う直前 release |
| installer version | handoff を記録した installer の version |
| verified release path | 外部 orchestration が参照する検証済み release path |
| source commit / tag / CI run id | artifact provenance の最小記録 |

## overlay 項目
### GitHub Release native asset overlay
| 区分 | 項目 | 意味 |
| --- | --- | --- |
| source | release tag | moving reference ではない固定 release tag |
| artifact | platform-specific asset name | target platform id に対応する asset 名 |
| runtime | external runtime prerequisite | self-contained native asset では指定しない |

### Java / Maven overlay
| 区分 | 項目 | 意味 |
| --- | --- | --- |
| package | repository URL | Maven artifact を取得する repository |
| package | groupId | Maven groupId |
| package | artifactId | Maven artifactId |
| package | version | 固定 release version。production では SNAPSHOT を許可しない |
| artifact | jar file name | 配置対象 Jar 名 |
| runtime | java major | 標準経路で事前インストール済み JRE / JDK に要求する major version |

### Node / npm overlay
| 区分 | 項目 | 意味 |
| --- | --- | --- |
| package | registry URL | npm package を取得する registry |
| package | package name | npm package name |
| package | version | 固定 package version。production では latest / tag / range を許可しない |
| artifact | tarball URL or lockfile | tarball 配布または frozen install の入力 |
| artifact | integrity or checksum | tarball または lockfile install 結果の検証情報 |
| runtime | node major | 標準経路で事前インストール済み Node.js に要求する major version |
| runtime | package manager version | npm / pnpm / yarn などに要求する version |
| execution policy | npm lifecycle script name | Node package に含まれる `postinstall` などの npm lifecycle script 名 |

## 禁止項目
- GitHub branch、moving tag、registry の `latest`、version range、SNAPSHOT を production / release 用 manifest の固定入力にしない。
- JRE、Node.js、package manager の download URL や checksum を共通 manifest に含めない。runtime bootstrap は project override の別契約で扱う。
- 認証 token、secret、認証 header を manifest に含めない。
- target platform id を省略せず、use case 契約にない値を独自追加しない。
- self-contained native asset の manifest に external runtime prerequisite を含めない。
- `install`、`upgrade`、`repair`、`dry-run` などの実行 mode を manifest に含めない。
- fallback registry や fallback URL を暗黙に許可しない。
- production 用 manifest に source build を暗黙実行する指定を含めない。source build は project override の別契約で扱う。
- production 用 manifest に lifecycle script / hook の暗黙実行を含めない。
- vulnerability scan の合否判定や OS patch 実行を manifest に含めない。

## 受け入れ条件
- manifest と checksum / signature が一致しない場合、installer は配置、handoff state 記録、activation state 変更を行わない。
- external runtime を要求する use case で runtime が存在しない、または required version を満たさない場合、installer は runtime を導入せず失敗する。
- target platform id がない、または use case 契約の許可値ではない場合、installer は取得や配置を開始しない。
- platform-specific asset が target platform id と一致しない場合、installer は取得や配置を開始しない。
- managed root が広すぎる（filesystem root、Windows drive root、ホームディレクトリそのもの、OS 予約領域）場合、installer は取得や配置を開始しない。
- installer 実行時に、検証済み manifest とは別の manifest を再取得しない。
- artifact rollback と data restore が同じ自動処理に混在していない。
- lock を取得できない場合、installer は managed root を変更しない。
- launcher が管理外の既存ファイルと衝突する場合、installer は switch を行わない。
- switch または record の失敗時、installer は変更した launcher を旧状態へ復元する。
- unsafe archive entry を検出した場合、installer は staging 反映を行わない。
- manifest に指定された verified placement asset の checksum / signature が一致しない場合、installer は配置、handoff state 記録、activation state 変更、install state 更新を行わない。
- production installer で install state path がない場合、installer は実行を開始しない。
- `external-orchestrated` で handoff state path がない場合、installer は未反映 release を install state に代替記録せず失敗する。
