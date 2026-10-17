# CI ワークフローのバージョン指定ポリシー

> この文書は GitHub Actions provider profile である。一般的なCIの責務は `ci` スキル、GitHub固有の版指定と解決条件は本ポリシー、製品の版運用は git-branch-strategy スキルが所有する。

## 理解できること
- workflow が使用する Action、runner/host、runtime、toolchain、container、外部ツールの版指定
- mutable な version alias を避け、実行入力を追跡可能にする不変条件
- 版の更新、例外、検証結果を扱う境界

## 目的
- workflow runtime の入力が意図せず更新されることを防ぎ、再現性と変更の追跡可能性を保つ。
- Action の commit、runner の OS、言語 runtime、依存解決、外部資材の版指定を同じ基準で確認する。

## 所有境界
- 本ポリシーは、workflow runtime に渡す実行環境・ツールの版表現と固定条件を扱う。
- ブランチ、tag、artifact の version channel、publish trigger は git-branch-strategy スキルの正本 DSL に従い、本ポリシーで再定義しない。
- runner の信頼境界、self-hosted 採用可否、required check は `references/runner-trust-policy.reference.md` に従う。
- Action 自体の実装・配布は github-actions スキルに委譲する。
- project の依存関係の内容は各言語・package manager の正本に従い、本ポリシーは workflow からの解決条件だけを定める。
- package の immutable version、channel alias、artifact 種別、配布経路、registry 条件は workflow runtime の版ではない。CI は `references/implement-package-publish-workflow.guide.md` に従い、git スキルの owner 契約で許可された version plan だけを具体化する。

## 適用対象
- project で実行する `.github/workflows/**` の workflow、reusable workflow、job、step。
- `workflows/` のcanonical sourceも同様に、配置後に実行される workflow へ本ポリシーを適用する。sourceに残るplaceholderや例示値は実行時の適合を示さない。
- workflow が直接または Action 経由で起動する runner、container、service、runtime、package manager、外部バイナリ。

## バージョン指定の不変条件
- 版を持つ入力は省略せず、実行時に `latest`、`stable`、未指定の既定値、mutable な branch/tag alias へ暗黙 fallback しない。
- 動的な matrix を使う場合も、各候補は repository 内でレビュー可能な versioned value とし、event payload や手動入力を任意の version selector として実行しない。
- 同じ実行で使う Action、runner、runtime、依存、外部資材の版を別の job や script が再選択しない。解決済みの値を job 境界で渡す。
- 固定粒度は、資材同一性、再現性、API・ABI互換性など必要な保証から決める。完全一致、major・minor単位、互換範囲、consumer指定を比較し、必要な保証を満たす最小の制約を選ぶ。検証済みの版一覧をそのまま受理範囲にしない。
- 選択する範囲と実際に解決した版を区別し、選択のowner、粒度の理由、検証方法と見直し条件をworkflowの正本または既存の設計に記録する。利用するActionの公開入力契約がexact指定を要求する場合は、その入力契約に従う。

### 対象別の指定

| 対象 | 標準指定 | 禁止・補足 |
| --- | --- | --- |
| 外部 Action / reusable workflow の `uses:` | upstream repository の 40 桁 commit SHA（小文字の hex） | branch、tag、短縮 SHA、未指定を使わない。SHA が実行時の正本で、release tag や human-readable version は確認用の補足に留める。 |
| repository-local Action / reusable workflow | workflow と同じ commit に含まれる path reference | 外部 repository の mutable ref を追加しない。path reference の資材を別 commit から取得する場合は、その取得元 commit を別途固定して検証する。 |
| GitHub-hosted runner の `runs-on` | OS と世代を含む versioned label（例: `ubuntu-24.04`） | `ubuntu-latest` などの moving label、OS 名だけの未指定 label、任意の event/input 由来 label を使わない。matrix の全候補にも適用する。 |
| self-hosted runner | owner が管理する immutable image/toolchain の識別子と、versioned label・更新 owner の証跡 | label だけを version の証拠にしない。untrusted PR へ使わず、採用可否は runner trust policy で判定する。 |
| 言語 runtime / toolchain | 必要な保証と利用するActionの入力契約に応じた、consumerが明示する固定粒度・許容範囲 | `latest`、`*`、`x`、未指定を使わない。範囲を許容する経路は信頼済み制御で一度解決したexact版を関連jobへ渡し、実行版を照合する。解決版を伝搬できない経路はexact指定を維持する。 |
| package manager / dependency | package manager の version を明示し、lockfile による解決を使う | lockfile を無視する install、暗黙の global tool、実行ごとに変わる解決範囲を使わない。 |
| container / service image（`docker://` の container Action を含む） | immutable digest（`@sha256:<64桁hex>`） | tag や `latest` だけで指定しない。digest を取得できない場合は実行を許可しない。 |
| 外部バイナリ・installer・OS package | exact version と checksum または署名を検証できる取得元 | version のない download、取得後に検証しない実行、`curl ... | sh` のような未固定経路を使わない。 |
| timezone / locale / architecture | テストや生成物に影響する場合は workflow の環境変数または matrix で明示 | runner host の既定値へ依存しない。 |

### Action と版情報の扱い
- Action は許可された発行元から選び、commit SHA が実在する upstream commit であることを確認する。
- release tag や version をコメントへ残してよいが、コメントを実行参照や SHA の代替にしない。コメントと SHA が一致しない場合は SHA を受理せず、更新を停止する。
- local Action は workflow と同じ commit に含まれる資材として扱い、外部 Action の tag pin へ置き換えない。
- `a3-suite/a3-ci-github` の Action は a3 管理 Action として扱う。consumer接続前に`actionization.implementationSource.releaseTag`のReleaseが公開済みであり、`exactRef`と公開対象の対応を提供元の[publication契約](https://github.com/a3-suite/a3-ci-github/blob/main/sdd/dsl/specs/contract-core/subjects/ci-selective-distribution/clauses.sdd.yml)に従って確認する。採用版の契約と検証結果を使い、変更された契約を旧版へ遡及適用しない。tagのpeeled SHAとAction SHAが同じであることだけを確認方法にせず、実装の事前Releaseや接続専用の後続Releaseを要求しない。`uses`は`exactRef`の40桁SHAを実行参照とし、tagを実行参照へ使わない。
- GitHub 公式、vendor、community の third-party Action は upstream owner の release policy を上書きしない。consumer は full commit SHA を実行参照とし、採用時に upstream の exact release tag、その target commit、実行参照の SHA が一致することを確認する。
- provider Action の実行参照は registry（`assets/registry/ci-github-preset-assets.yml` の `providerActions`）の承認 pin（`pinnedVersion`、`commitSha`、`runtime`）と一致させ、runtime は `approvedRuntimes` の値に限る。承認値以外を使う場合は、先に registry を更新して承認してから実行参照にする。
- registry の `runtime` は entry の `runtimeBasis` が指す `action.yml` の `runs.using` を示す。sub-path の entrypoint を使う場合と `composite` の内部 Action は含まないため、実行前にその entrypoint と内部 Action の runtime を確認し、未確認のまま承認済みとして扱わない。
- registry の `pinCompanion` が宣言する `path`（`.ci/provider-action-pins.yml`）は、必要なcallerを扱うprovider CLIのplanが`providerActions.entries`と`pinCompanion.fields`から生成し、確認済みplanのapplyが配置する。companionはregistryの完全な射影であり独自編集しない。lock生成とpreflightは使用中・未使用を問わず全entryとfieldを比較し、欠落・追加・独自編集を拒否する。手順は`references/distribute-ci-assets.guide.md`を参照する。
- 照合は preset のcaller生成時と適用後の検証時に必須とする。参照解決・製品設定の入力は`references/distribute-ci-assets.guide.md`に従う。preflightはcanonical、registry、manifestと生成済みcallerの参照を照合する。companionは必要な経路だけでregistryの射影と比較する。
- upstream がランタイムのサポート終了や移行を通知した場合（例: Node.js ランタイムの deprecation 警告）は、registry と consumer の pin を同一変更で更新し、`## 更新と停止条件` の追跡項目へ記録する。
- registry に無い provider Action、または `approvedRuntimes` 外の runtime を実行参照にした場合は、`## 更新と停止条件` に従って workflow の追加・更新・publish を進めない。
- registry の availability gate を満たす `available` の Action だけを workflow へ接続する。Hosted 実行は別の運用証拠として扱う。

### runner/host の扱い
- consumerが信頼済み設定で選ぶOS世代をproviderの検証済み世代へ限定しない。platform manifestの信頼経路と初回導入の制約はrunner trust policyに従い、labelの形式だけでHosted originを証明しない。
- versioned GitHub-hosted label は OS 世代を固定するための契約であり、image 内の全 package が immutable になることを意味しない。toolchain、package manager、container は別途固定する。
- runner image の変更、廃止、提供状況を確認できない場合は、実行済み・適合済みと判断しない。
- trust boundary と version の判断を混ぜない。安全な runner でも version が未指定なら不適合であり、version が固定されても untrusted input を安全に実行できる証拠にはならない。

<a id="os-version-selection"></a>
## OS・版の選定と廃止判断

platform manifestの新規作成、OS/CPU・runner・toolchainの追加・変更・削除時と、CI監査時に次を判断する。providerは本基準・標準構成・結果集約を所有し、consumerは製品の対応範囲と検査の同等性を判断する。

### 選定と固定粒度

1. 製品が保証するOS/CPUと必要な検証を先に決め、共通化できる処理を確認した後に時間・費用を比較する。native build/test、path、権限、installer等のOS固有保証は対応構成ごとに維持する。
2. 「なぜ固定が必要か」「どの幅まで許容できるか」を、前節の対象別指定と必要な保証に照らして自問する。完全一致を選ぶなら、同一性・互換性等の理由と、制約を緩めるための検証条件を残す。新しい版が出たことや未検証であることだけで既存の受理範囲を狭めない。
3. 共通検査は、command、入力、source、依存解決、projectとHOMEの設定、toolchain、OS/CPUによる対象の差を照合する。format/securityという名前だけで同等と判断しない。代表OSは必要能力・実測時間・費用・保守性から選び、先頭platformに置く理由を残す。同等性が不明または崩れた場合は全OSの全検査へ戻す。
4. 選定理由、固定粒度・許容幅、省略する検査と代替保証、証拠のidentity、owner、次回見直し日・条件を既存の設計またはissueへ記録する。manifestは実行設定に限定し、判断記録用の必須fieldを追加しない。`sharedStandardChecks`はこの判断を済ませたconsumerの宣言として扱う。

### 廃止の線引きと見直し

| 判断 | 根拠と扱い |
| --- | --- |
| 標準CIから除外する | Hosted providerのrunner廃止、OSのsecurity support終了、runtime/toolchainのEOL、必要能力との非互換、解消できない不具合を起点に代替構成と検証を決める。継続する場合は理由・緩和策・期限を記録する。 |
| 製品の対応を終了する | consumerが利用者への影響、代替先、告知日と終了日を決める。標準CIからの除外だけで製品対応終了を決定しない。 |
| validatorが入力を拒否する | 入力形式、必要能力、信頼境界に対する具体的な不適合を根拠にする。年齢、標準CIでの非採用、新版の登場だけを拒否条件にしない。 |

- providerが廃止日を公表したら、90日前までの移行着手と30日前までの代替検証完了を運用目安とする。製品対応終了は原則90日前の告知を目安とする。短い予告期間、重大な脆弱性、突然の提供停止では例外理由・影響・代替策を記録する。これらの日数をvalidatorの固定閾値にしない。
- 少なくとも各release時と監査時に固定理由・許容幅を見直す。対応範囲、依存、設定、toolchain、runner imageの変更時には検査の同等性も再確認する。監査では当日の公式な提供・サポート状況と判断記録を照合し、未確認を適合へ読み替えない。
- 例えば新版runnerが登場しただけなら旧版を拒否しない。providerが旧runnerの提供終了を告知した場合は代替runnerで検証して移行する。HOME設定がOSごとに異なると判明した場合は共通検査の省略を解除する。

## テンプレートと例外
- 配布templateのplaceholderは共通生成処理の入力である。製品設定を導入時に渡し、固定参照は配布元のmanifestとregistryから解決する。利用者はplaceholderを手動置換せず、生成済みcallerを設定の正本として読み返す。配置後のworkflowにplaceholderを残してはならない。
- workflow `workflow_dispatch` の入力で runtime や runner を選ぶ場合は、repository 内でレビュー済みの allowlist へ写像し、入力値を `runs-on`、`uses`、download URL、shell source として直接再解釈しない。privileged workflow では trusted CI control が解決した値だけを受け取る。
- provider 処理が利用する `gh`、`jq`、`sha256sum` は workflow 初期パラメータで exact version を固定し、固定 SHA の toolchain verifier Action で実行前に検証する。
- `jq` は固定 SHA の `ci-jq-provisioner` Action で指定版を供給してから検証する。Action は jqlang/jq の該当 Release の取得物を同 Release の `sha256sum.txt` と照合し、検証済みの実行ファイルを `GITHUB_PATH` へ追加する。供給失敗は `jq-provision-failed`、供給後の版不一致は verifier の `jq-version-mismatch` で区別する。標準 publication 経路では runner trust policy の入口成功条件と制御checkout照合を満たしてから供給する。
- `gh` は固定 SHA の `ci-gh-provisioner` Action で指定版を供給してから検証する。Action は cli/cli の該当 Release の取得物を同 Release の `gh_<version>_checksums.txt` と照合し、検証済みの実行ファイルを `GITHUB_PATH` へ追加する。対応 runner は Linux X64/ARM64 とし、それ以外は `gh-provision-failed` で停止する。供給失敗は `gh-provision-failed`、供給後の版不一致は verifier の `gh-version-mismatch` で区別する。供給順は jq 供給の直後、verifier の直前とし、標準 publication 経路では runner trust policy の入口成功条件と制御checkout照合を満たしてから供給する。gh を検証する mode を使う preset は release-publication、package-publication とし、主quality-gateはjq-versionを指定した場合だけjqを供給・検証し、空値なら準備を省略する。必要性はproject ownerが判断する。
- `sha256sum` は供給対象外とする。供給可能な単体 Release asset を持たないため、許容する版は versioned runner label が提供する coreutils の版に限定する（Ubuntu LTS の runner image では coreutils が rebase されにくい）。`release-publication` の該当 mode は、workflow 初期パラメータ（`CI_SHA256SUM_VERSION`）がその版と完全一致する場合だけ verifier を通過する（`package-publication` は `gh-jq` のため対象外）。runner image の更新で版が変わった場合は、preset を適用した project の CI owner が初期パラメータを更新し、verifier 実行で再検証してから公開を再開する。
- placeholder は consumer が決める値に限る。provider が所有する実行時出力の形式やパース規則を consumer に設定させない。
- placeholder の空許容は、その placeholder を消費する step が未使用時に skip される場合に限る。

## 更新と停止条件
- CI配布資産の版識別には配布元のfull commit SHAとcontent digestを使う。`.ci/ci-assets.lock.json`の`generatedAt`はUTC分単位の観測時刻であり、同一性、新旧、版順序の判定に使わない。
- 版を更新する場合は、対象、旧版、新版、upstream の根拠、影響する runner/toolchain、検証結果を同じ変更で追跡できるようにする。
- security fix で緊急更新する場合も、mutable alias へ戻さず、確認できる commit、version、digest のいずれかへ固定してから検証する。
- version、commit、digest、runner image の identity が workflow または設定に未指定・不正・mutable の場合は、観測した対象契約違反を `references/ci-audit-contract.reference.yml` の `statusClassification` へ渡し、workflow の追加・更新・publish を進めない。
- 必須 identity の観測結果と監査statusは同契約の `statusClassification` と `result` に従い、監査または適合のsuccessを確定できない場合は workflow の追加・更新・publish を進めない。
- `actionlint` の成功だけでは version の固定、upstream identity、runner image の実体、外部設定の適用を証明できない。静的検証と運用証跡を分けて報告する。

## 確認項目
- [ ] すべての外部 `uses:` が full commit SHA へ固定されている。
- [ ] provider Action の実行参照が registry の承認 pin（`pinnedVersion`、`commitSha`、`runtime`）と一致している。
- [ ] a3 管理 Action は採用Releaseのpublication契約に従い、公開対象とregistryのexactRefの対応を確認している。
- [ ] third-party Action は upstream の exact release tag、target commit、実行参照の SHA の一致を確認している。
- [ ] `runs-on` が versioned label または immutable self-hosted image の証跡へ結び付いている。
- [ ] runtime、toolchain、package manager、依存解決、container、外部資材の版が明示されている。
- [ ] `latest`、未指定の既定値、任意入力由来の selector、未解決 placeholder が実行 workflow に残っていない。
- [ ] digest、checksum、署名、lockfile など、対象に応じた identity 検証がある。
- [ ] version の変更理由、upstream 根拠、検証結果、更新 owner を追跡できる。
- [ ] version の証拠と runner trust、権限、trigger、publish authority の証拠を混同していない。

## 関連
- `references/design-ci-workflow.guide.md`
- `references/workflow-authoring-policy.reference.md`
- `references/runner-trust-policy.reference.md`
