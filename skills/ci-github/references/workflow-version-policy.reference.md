# CI ワークフローのバージョン指定ポリシー

> この文書は GitHub Actions provider profile である。provider-neutral な version 固定条件は `ci` の CIプリセット契約で定義し、GitHub 固有の `uses`、runner、workflow path を本スキルへ写像する。

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
- package の immutable version、channel alias、artifact 種別、配布経路、registry 条件は workflow runtime の版ではない。CI は `implement-package-publish-workflow.guide.md` に従い、git スキルの owner 契約で許可された version plan だけを具体化する。

## 適用対象
- project で実行する `.github/workflows/**` の workflow、reusable workflow、job、step。
- `workflows/` のcanonical sourceも同様に、配置後に実行される workflow へ本ポリシーを適用する。sourceに残るplaceholderや例示値は実行時の適合を示さない。
- workflow が直接または Action 経由で起動する runner、container、service、runtime、package manager、外部バイナリ。

## バージョン指定の不変条件
- 版を持つ入力は省略せず、実行時に `latest`、`stable`、未指定の既定値、mutable な branch/tag alias へ暗黙 fallback しない。
- 動的な matrix を使う場合も、各候補は repository 内でレビュー可能な versioned value とし、event payload や手動入力を任意の version selector として実行しない。
- 同じ実行で使う Action、runner、runtime、依存、外部資材の版を別の job や script が再選択しない。解決済みの値を job 境界で渡す。

### 対象別の指定

| 対象 | 標準指定 | 禁止・補足 |
| --- | --- | --- |
| 外部 Action / reusable workflow の `uses:` | upstream repository の 40 桁 commit SHA（小文字の hex） | branch、tag、短縮 SHA、未指定を使わない。SHA が実行時の正本で、release tag や human-readable version は確認用の補足に留める。 |
| repository-local Action / reusable workflow | workflow と同じ commit に含まれる path reference | 外部 repository の mutable ref を追加しない。path reference の資材を別 commit から取得する場合は、その取得元 commit を別途固定して検証する。 |
| GitHub-hosted runner の `runs-on` | OS と世代を含む versioned label（例: `ubuntu-24.04`） | `ubuntu-latest` などの moving label、OS 名だけの未指定 label、任意の event/input 由来 label を使わない。matrix の全候補にも適用する。 |
| self-hosted runner | owner が管理する immutable image/toolchain の識別子と、versioned label・更新 owner の証跡 | label だけを version の証拠にしない。untrusted PR へ使わず、採用可否は runner trust policy で判定する。 |
| 言語 runtime / toolchain | 選択機能が許す範囲で major.minor.patch の exact version | `latest`、`*`、`x`、未指定を使わない。patch 固定ができない tool は、許容範囲、更新 owner、検証方法を workflow の正本で明示する。 |
| package manager / dependency | package manager の version を明示し、lockfile による解決を使う | lockfile を無視する install、暗黙の global tool、実行ごとに変わる解決範囲を使わない。 |
| container / service image（`docker://` の container Action を含む） | immutable digest（`@sha256:<64桁hex>`） | tag や `latest` だけで指定しない。digest を取得できない場合は実行を許可しない。 |
| 外部バイナリ・installer・OS package | exact version と checksum または署名を検証できる取得元 | version のない download、取得後に検証しない実行、`curl ... | sh` のような未固定経路を使わない。 |
| timezone / locale / architecture | テストや生成物に影響する場合は workflow の環境変数または matrix で明示 | runner host の既定値へ依存しない。 |

### Action と版情報の扱い
- Action は許可された発行元から選び、commit SHA が実在する upstream commit であることを確認する。
- release tag や version をコメントへ残してよいが、コメントを実行参照や SHA の代替にしない。コメントと SHA が一致しない場合は SHA を受理せず、更新を停止する。
- local Action は workflow と同じ commit に含まれる資材として扱い、外部 Action の tag pin へ置き換えない。
- `a3-suite/a3-ci-github` の Action は a3 管理 Action として扱う。consumer 接続前に `actionization.implementationSource.releaseTag` の exact release tag が公開済みであり、その peeled target が `exactRef` と一致することを確認する。`uses` は `exactRef` の40桁 SHAを実行参照とし、tag を実行参照へ使わない。
- GitHub 公式、vendor、community の third-party Action は upstream owner の release policy を上書きしない。consumer は full commit SHA を実行参照とし、採用時に upstream の exact release tag、その target commit、実行参照の SHA が一致することを確認する。
- provider Action の実行参照は registry（`ci-github-preset-assets.reference.yml` の `providerActions`）の承認 pin（`pinnedVersion`、`commitSha`、`runtime`）と一致させ、runtime は `approvedRuntimes` の値に限る。承認値以外を使う場合は、先に registry を更新して承認してから実行参照にする。
- registry の `runtime` は entry の `runtimeBasis` が指す `action.yml` の `runs.using` を示す。sub-path の entrypoint を使う場合と `composite` の内部 Action は含まないため、実行前にその entrypoint と内部 Action の runtime を確認し、未確認のまま承認済みとして扱わない。
- registry の `pinCompanion` が宣言する `path`（`.ci/provider-action-pins.yml`）を適用時に生成して配置し、project は workflow の実行参照を同 file の承認値と照合する。companion は registry の射影であり独自編集しない。適用・更新時は採用した registry の射影と一致することを確認する。
- 照合は preset のcaller生成時と適用後の検証時に必須とする。参照解決・製品設定の入力は`distribute-ci-assets.guide.md`に従う。preflightはcanonical、registry、manifestと生成済みcallerの参照を照合する。companionは必要な経路だけでregistryの射影と比較する。
- upstream がランタイムのサポート終了や移行を通知した場合（例: Node.js ランタイムの deprecation 警告）は、registry と consumer の pin を同一変更で更新し、`## 更新と停止条件` の追跡項目へ記録する。
- registry に無い provider Action、または `approvedRuntimes` 外の runtime を実行参照にした場合は、`## 更新と停止条件` に従って workflow の追加・更新・publish を進めない。
- registry の availability gate を満たす `available` の Action だけを workflow へ接続する。Hosted 実行は別の運用証拠として扱う。

### runner/host の扱い
- versioned GitHub-hosted label は OS 世代を固定するための契約であり、image 内の全 package が immutable になることを意味しない。toolchain、package manager、container は別途固定する。
- runner image の変更、廃止、提供状況を確認できない場合は、実行済み・適合済みと判断しない。
- trust boundary と version の判断を混ぜない。安全な runner でも version が未指定なら不適合であり、version が固定されても untrusted input を安全に実行できる証拠にはならない。

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
- version、commit、digest、runner image の identity が workflow または設定に未指定・不正・mutable の場合は、観測した対象契約違反を `ci-audit-contract.reference.yml` の `statusClassification` へ渡し、workflow の追加・更新・publish を進めない。
- 必須 identity の観測結果と監査statusは同契約の `statusClassification` と `result` に従い、監査または適合のsuccessを確定できない場合は workflow の追加・更新・publish を進めない。
- `actionlint` の成功だけでは version の固定、upstream identity、runner image の実体、外部設定の適用を証明できない。静的検証と運用証跡を分けて報告する。

## 確認項目
- [ ] すべての外部 `uses:` が full commit SHA へ固定されている。
- [ ] provider Action の実行参照が registry の承認 pin（`pinnedVersion`、`commitSha`、`runtime`）と一致している。
- [ ] a3 管理 Action は公開済み exact release tag と registry の exactRef の対応を確認している。
- [ ] third-party Action は upstream の exact release tag、target commit、実行参照の SHA の一致を確認している。
- [ ] `runs-on` が versioned label または immutable self-hosted image の証跡へ結び付いている。
- [ ] runtime、toolchain、package manager、依存解決、container、外部資材の版が明示されている。
- [ ] `latest`、未指定の既定値、任意入力由来の selector、未解決 placeholder が実行 workflow に残っていない。
- [ ] digest、checksum、署名、lockfile など、対象に応じた identity 検証がある。
- [ ] version の変更理由、upstream 根拠、検証結果、更新 owner を追跡できる。
- [ ] version の証拠と runner trust、権限、trigger、publish authority の証拠を混同していない。

## 関連
- `design-ci-workflow.guide.md`
- `references/workflow-authoring-policy.reference.md`
- `references/runner-trust-policy.reference.md`
