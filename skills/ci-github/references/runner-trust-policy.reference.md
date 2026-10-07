# CI runner trust policy

> この文書は GitHub Actions provider profile である。provider-neutral な trust boundary は `ci` の CIプリセット契約で定義し、GitHub 固有の trigger、権限、workflow 起動方式を本スキルへ写像する。

## 理解できること
- CI runner の選定判断軸
- self-hosted runner を使う条件
- untrusted PR、merge gate check、post-merge verification の分離方針
- trusted PR check の入力境界
- trusted CI assets の bootstrap 方針
- runner trust control の適用条件

## 目的
- CI runner の選定方針を一元化し、workflow 設計、review、audit、publish 例で同じ判断軸を使う。

## 適用条件
- runner 選定と check 境界は、すべての CI workflow で確認する。
- 未信頼入力を処理する、または self-hosted runner を使う場合は、runner 選定と check 境界の該当制約を適用する。
- trusted PR check を実行する場合は、trusted PR check の入力境界を適用する。
- trusted PR check が project-local な trusted CI assets を実行する場合は、trusted CI assets bootstrap を適用する。
- secret または write 権限を使う場合は、privileged workflow の trusted CI control を適用する。
- artifact を公開する場合は、privileged workflow の trusted CI control に加え、対象プロジェクトで公開経路を所有する契約を適用する。
- 適用条件に該当しない control の証跡は要求しない。

## 本文
### runner 選定
- runner は trust boundary、OS / toolchain、isolation、availability、無料枠消費を根拠に選ぶ。
- `runs-on` の versioned label と self-hosted image の identity は `references/workflow-version-policy.reference.md` に従う。
- trust boundary / isolation は cost より優先し、cost は同等に安全な選択肢間で比較する。
- self-hosted runner は第一選択にしない。
- self-hosted runner は、プロジェクトが管理する信頼済み runner と隔離要件が明確な場合だけ採用する。
- untrusted PR は self-hosted runner で実行しない。
- GitHub-hosted runner は、未信頼入力の隔離、標準 toolchain、運用負荷低減を優先する場合に採用する。

### check 境界
- merge gate check と post-merge verification の境界を混ぜない。
- `trusted` は PR の投稿者や head source を信頼済みとみなす名称ではなく、base SHA または監査済み commit SHA から取得した trusted CI control で判定する境界名とする。
- merge gate check 境界名は `trusted`、`untrusted-pr` とする。
- merge gate check は branch protection / ruleset の required 判定対象として扱う。
- post-merge verification 境界名は `post-merge` とする。
- post-merge verification は merge 後の検証であり、merge gate required check として扱わない。
- `runs-on` の具体値はプロジェクトの runner、権限、trigger、toolchain に合わせて置き換える。

#### PR check の選択
| PR source | 実行する merge gate check | 実行しない check の扱い |
| --- | --- | --- |
| same repository | `trusted` | `untrusted-pr` job を job-level condition で skip する |
| fork | `untrusted-pr` | `trusted` job を job-level condition で skip する |

- `trusted` と `untrusted-pr` を配置する場合、両 workflow または両 job は required 対象となるすべての `pull_request` で起動し、相互排他的な job-level condition で実行対象を選ぶ。
- 配置した merge gate check は安定した job 名で branch protection / ruleset の required check に設定する。
- required 対象の `pull_request` では、workflow 自体を `paths` / `paths-ignore`、branch filter、commit message で skip しない。対象外処理は workflow 起動後の job または step で判定する。
- merge queue を運用する場合は `merge_group` payload で成立する check を required check として用意する。`pull_request` 固有 field を参照する既存 workflow に trigger だけを追加しない。

#### platform 別 quality check
- platform 別 quality job の runner は platform manifest の allowlist 済み versioned label だけを使い、未信頼入力から runner 値を解決しない。
- same-repo / fork の双方で固定名の集約 check が起動し、platform job の skip、cancel、runner 不提供、matrix の欠落を成功に読み替えない。
- trusted CI assets bootstrap（後述）を除き、platform 選択データと CI 資産は base SHA から取得し、PR head 側の変更で検証対象 platform を無効化または追加できないようにする。
- opt-in の platform 検証は base `quality-gate` とは別の固定名 check として required にし、base check の判定へ暗黙に混ぜない。

### trusted PR check の入力境界
- trusted CI assets bootstrap（後述）を除き、trusted PR check が project-local な trusted CI assets を実行する場合は、その assets と lockfile / dependency set を event payload の base SHA から取得し、PR head 側の変更で判定を弱めない。
- trusted PR check の base / head 入力は event payload の immutable SHA に固定し、mutable branch ref または merge alias を入力にしない。

### trusted CI assets bootstrap
- trusted CI assets は、workflow が呼び出す `.ci/scripts/**`、policy script、adapter descriptor、またはそれらに相当する project-local CI 実行資産とする。
- base の採用済み marker は `.ci/ci-assets.lock.json` の存在とする。marker は配布同一性 lock の正本 path を使い、内容は runtime で解析しない。
- base に marker がある場合、workflow が必要とする trusted CI assets が base に揃っていなければ fail closed で停止する。資産が無い状態で marker だけを残さない。
- base に marker が無く、対象資産も無い場合に限り、初回導入として same-repo head の資産と trusted project root を使用できる。このとき trusted project root は同じ snapshot とし、required script binding を同一 snapshot で評価する。
- same-repo の trusted resolution で base に marker が無く対象資産のいずれかが存在する場合は、lock を欠く不整合として停止する。取得失敗を head fallback の根拠にしない。docs-only など資産解決を行わない実行では、停止判定を次の解決実行へ委ねる。fork 経路は base の資産だけを使用し、marker 有無による head 選択を行わない。
- marker と対象資産を同時に削除した base は初回導入と同じ状態として扱う。この受容は required check と ruleset による base 変更保護を前提とする。
- bootstrap は provider profile の canonical state であり、use-case の例外経路へ登録しない。
- fork PR では head fallback を許可せず、base の資産だけを使用する。

### privileged workflow の trusted CI control
- 本契約は caller の `github.workflow_ref` / `github.workflow_sha` を提供する GitHub.com を対象とする。GHES では同等の context 契約を確認できない限り導入を停止する。
- 標準 Release は `authority` job、標準 Package は `publish` job の最初の step で publication entry を検証する。event は `workflow_run`、caller ref は consumer repository の所定 caller path と default branch の組合せ、control SHA は40桁の小文字hexに fail closed で照合する。入口検証より前に他の Action、checkout、project-local code を実行しない。
- Release の後続 control job は `authority` の成功に依存し、独自の実行条件で失敗・skip・cancel を迂回しない。入口の成功を job output の control SHA で伝搬させず、各 control checkout は `repository: github.repository` と `ref: github.workflow_sha` を直接使い、直後に HEAD をその SHA と照合する。source SHA、別入力、mutable ref へ fallback しない。
- caller から local `./.github/workflows/` 参照で呼ぶ callee は GitHub の同一commit保証を使い、caller/callee の SHA equality を重ねて検証しない。preflight は固定した local callee path、入口検証、成功依存、control checkout と直後の HEAD 照合を検査し、control job の container / services を許可しない。外部 provider 参照へ変更する場合は repository / workflow path / full commit SHA を固定し、その接続を別途受け入れる。consumer と provider の SHA equality は要求しない。
- workflow の保護と権限設定を trust の前提とし、変更可能な workflow 内の自己検証だけを信頼根拠にしない。
- `workflow_dispatch` などの手動起動権限や tag push は、選択された ref やその ref 内の CI assets の信頼根拠として扱わない。
- publish、deploy などの権限付き処理では、workflow orchestration 自体も trusted CI control に含める。event ref 上の workflow に publish 権限を与えず、権限を持たない request workflow と、default branch 上の `workflow_run` で起動する privileged workflow を分離する。
- project-local trusted CI control を実行する job だけが、その control を監査済み commit SHA の snapshot から checkout する。checkout したファイルを実行または参照しない job へ trust marker として追加しない。
- request workflow は source checkout、policy projection、authority 判定、publish 権限を持たず、event / ref / source SHA を未信頼 request として渡すだけにする。
- privileged workflow は request の event と source SHA を `workflow_run` payload に照合し、repository、conclusion、ref 形式、event と ref の対応を fail closed で検証する。request artifact の内容を trusted CI control として扱わない。
- 未信頼の context、step output、job output を inline shell script の `${{ }}` へ直接展開しない。shell へ渡す場合は `env` でデータとして境界を越え、shell 側で引用した環境変数として参照する。Action へ渡す場合は `with` input を使い、shell source code として再解釈させない。
- publish requestを処理するCI controlはdefault branchまたは監査済みcommit SHAから取得する。
- trusted CI control と操作対象 source は checkout path を分離し、操作対象 source 側の同名 script で authority 判定を置き換えられないようにする。
- 操作対象sourceは未信頼として扱い、権限付きjobでは実行しない。
- 操作対象sourceのbuild / validateはwrite権限のないjobへ分離し、権限付きjobへは検証済みのimmutable handoffだけを渡す。
- 権限付きjobは操作対象sourceをcheckoutまたは実行せず、trusted CI control、検証済みplan、同一handoffだけを実行入力にする。公開対象ごとのidentity、inventory、登録手順は各owner契約に従う。
- 手動 workflow では manual invocation authority と source trust を分離し、選択sourceを権限付きjobで実行しない。

### Action の実行境界
- `a3-suite/a3-ci-github` の Action は、registry の `available` bindingを40桁の exact commit SHAで参照する。release aliasやbranch refを実行時の信頼根拠にしない。
- registry の availability gate を満たす `available` の Action だけを consumer workflow へ接続する。Hosted 証拠は接続可否とは別の運用記録として扱う。
- trusted CI control という分類だけで Action 化を禁止しない。候補適格条件と移管しない責務は registry の `actionization` を正本とし、Action 化によって本章の trust boundary を変更しない。
- Action の `trust: read-only` は、その Action 自体が provider への write 副作用を持たないことを表し、write 権限を持つ job での実行許可を表さない。既定では、`contents: read` など必要最小限の権限を持つ非特権 job で実行する。
- read-only provider access に credential が必要な場合も、credential の注入境界と禁止責務は registry の `actionization.candidateEligibility` に従う。
- write 権限を持つ job で read-only Action を使う必要がある場合は、registry の対象 Action に `workflow-id/job-id` を `privilegedJobs` として完全一致で登録する。固定 SHA の trusted CI control、検証済み source identity / handoff、外部 write より前の入力検証を満たす接続だけを登録し、preflight は未登録の接続を停止する。Action の `trust` 値だけでは write 権限を付与しない。

## チェックリスト
- 適用条件に該当する項目だけを確認する。
- [ ] runner 選定理由が trust boundary、OS / toolchain、isolation、availability、無料枠消費で説明できる
- [ ] trust boundary / isolation より cost を優先していない
- [ ] untrusted PR を self-hosted runner で実行しない
- [ ] self-hosted runner を使う場合、信頼済み runner と隔離要件が明確である
- [ ] trusted PR / untrusted PR の merge gate check と post-merge verification の境界が分離されている
- [ ] `trusted` を PR 投稿者や head source の信頼判定として扱っていない
- [ ] 配置した PR merge gate workflow がrequired対象となるすべての `pull_request` で起動し、job-level condition で実行対象を選んでいる
- [ ] required対象の `pull_request` で workflow 自体を filter または commit message により skip していない
- [ ] merge queue を使う場合、`merge_group` payload で成立する required check を用意している
- [ ] post-merge verification を merge gate required check として扱っていない
- [ ] trusted PR check の入力境界を満たしている
- [ ] trusted CI assets は標準で base SHA から取得している
- [ ] base の採用済み marker として `.ci/ci-assets.lock.json` の存在を使用している
- [ ] marker がある base で対象資産の欠落を fail closed にしている
- [ ] marker が無く対象資産も無い初回導入でだけ same-repo head を使用している
- [ ] marker が無く対象資産がある不整合を fail にしている
- [ ] fork PR で head fallback を許可していない
- [ ] 標準 publication の入口、callee 参照、後続 job の成功依存が本章の trusted CI control 契約に従っている
- [ ] trusted control の checkout と直後の HEAD 照合が本章の trusted CI control 契約に従っている
- [ ] GitHub.com 以外では同等の caller context 契約を確認できない限り停止している
- [ ] 権限付き workflow で request identity を検証し、操作対象sourceを実行していない
- [ ] event ref 上の request workflow が source checkout、policy、authority 判定、publish 権限を持っていない
- [ ] privileged workflow の orchestration が default branch または監査済み commit SHA から実行されている
- [ ] request artifact の event / source SHA / ref を `workflow_run` payload と ref 規約へ照合している
- [ ] 未信頼の context / step output / job output を inline shell script の `${{ }}` へ直接展開せず、`env` または Action input でデータとして渡している
- [ ] 権限付き手動 workflow で、manual invocation authority と source trust を分離している
- [ ] 権限付き workflow の authority 判定を trusted CI control から実行している
- [ ] 権限付き job の操作対象を verifier が出力した `source_sha` で固定している
- [ ] 権限付きjobが操作対象source、その依存、source由来scriptを実行せず、trusted CI controlと検証済みhandoffだけを入力にしている
- [ ] write 権限を持つ job で使う a3 Action が、対象 Action の `privilegedJobs` に `workflow-id/job-id` で明示登録されている

### 関連
- `design-ci-workflow.guide.md`
- `review-ci-workflow.guide.md`
