# パッケージ登録ワークフロー実装ガイド

## 目的
- owner 契約が解決した公開入力とversion planを検証し、package publication を安全にオーケストレーションする。
- 公開判断と provider 固有実装を CI から分離し、再実行時の上書き事故を防ぐ。

## 所有境界
- branch category、merge direction、version policy、publish trigger、publish source は git-branch-strategy スキルと git スキルの正本に従う。
- CIは公開要否、公開経路、registry、package種別、channel、credential route、version生成規則を再決定しない。
- development versionのownerが`ci-workflow`、strategyが`ciGenerated`と解決されている場合、trusted CI controlは決定済みcomponent-source bindingからruntime値を取得し、決定済みtemplateとcomponentsを機械的に具体化する。template、component source、生成可否はCIで選ばない。
- provider、言語、ecosystem固有のmetadata、availability、binding、publish commandはproject-local adapterが所有する。
- credentialの分類、保存、注入、ログ秘匿はsecret-managementスキルと対象projectの契約に従う。
- 実行抑止、置換可能性、concurrency、provider queue上限は`references/ci-execution-efficiency-policy.reference.md`に従う。

## 解決済み公開入力
- `source_sha`: 公開対象sourceの不変identity
- `publish_channel`: ownerが許可した公開channel
- `version_plan`: `exact`の不変version、または git スキルの owner 契約が許可した`ciGenerated`のtemplateとnamed components
- `publication_route`: 選択済みの公開経路
- `artifact_descriptor`: handoff root相対で、正規化後もroot内の通常ファイルを指す成果物identity
- `target_identity`: 公開対象resourceのidentity
- `credential_route`: credentialの識別子。秘密値は含めない

必須入力、owner契約、または`version_plan`のcomponentが欠落する場合はpublish前にfail closedする。CIはbranch、tag、manifest、言語、registryの既定値から補完しない。

## フロー
1. owner 契約を確認する。
   - 公開要否、公開経路、registry、package 種別、version plan、channel、credential route を解決する owner 契約を特定する。
   - owner 契約または必須入力が未確定なら workflow を構成せず終了する。
2. 解決済み公開入力を受け取る。
   - 本ガイドの解決済み公開入力を明示的に受け取る。
   - branch、tag、manifest、言語、registry の既定値から不足値を補完しない。
3. workflow の trust 境界を構成する。
   - request、trusted CI control、操作対象 source の境界は選択した provider 固有スキルの trust policy profile に従う。
   - Action、runner、runtime、toolchain、container、外部ツールの版指定は選択した provider 固有スキルの version policy profile に従う。
   - privileged workflow は安全に置換できない concurrency group で直列化する。
4. plan / build / validate / publish を分離する。
   - plan: trusted CI control で入力の完全性とowner契約への参照を検証し、許可済み`version_plan`から`publish_version`を具体化する。
   - build: write 権限なしで固定した `source_sha` を build し、単一の immutable handoff を生成する。
   - validate: trusted CI control で descriptor が handoff root 内の通常ファイルを指すことを検証し、project-local adapter で handoff と解決済み identity の binding を検証する。
   - publish: 操作対象 source を実行せず、検証済み plan と同一 handoff だけを公開する。
5. project-local adapter を接続する。
   - 対象言語または ecosystem の具体スキルと project-local 契約に従い、metadata 検証、availability 観測、publish command、post-publish 観測を実装する。
   - adapter は provider 固有の失敗を安全停止へ写像し、秘密値を出力しない。
   - 共通 interface は `references/ci-script-catalog.reference.md` に従う。
6. 公開直前と公開後を検証する。
   - 公開直前に artifact、version、target identity の binding と非上書き条件を再検証する。
   - `absent` は非上書き条件の再検証後だけ publish へ進み、`complete-same` は成功として停止する。
   - `partial`、`different`、観測不能は fail closed とする。
   - 公開後に対象 identity、version、digest を再観測し、解決済み入力と一致することを確認する。
7. partial publish recovery を構成する。
   - state と rerun eligibility は `references/package-publish-recovery-state.reference.yml` に従う。
   - destructive recovery は workflow に追加せず、対象 resource の owner へ委譲する。

## 注意
- CI は公開経路、registry、package 種別、version生成規則、channel alias、credential route を決定しない。
- provider、言語、ecosystem 固有の規則を本ガイドへ再定義しない。
- write 権限を持つ job で操作対象 source、依存、source 由来 script を実行しない。

## 安全不変条件
- `source_sha`をcheckout、build、検証済みhandoffへ一貫して結合する。
- write権限を持つjobは検証済みplanと同一のimmutable handoffだけを使い、操作対象sourceを実行または再buildしない。
- `artifact_descriptor`の絶対パス、path traversal、symbolic link escape、handoff root外への解決を拒否する。
- project-local adapterは`publish_version`、`target_identity`、`artifact_descriptor`のbindingと非上書き条件を公開直前に検証する。
- 公開後にtarget identity、version、digestを再観測し、入力と一致することを確認する。
- publish検証の期待versionは、materialize済み`publish_version`と同一の値を伝搬し、生入力を別経路で再解釈しない。
- recoveryは`references/package-publish-recovery-state.reference.yml`のstateを使い、削除、上書き、tag操作、Release操作をCIに実装しない。

## アンチパターン
- artifact種別や言語から公開経路、registry、version templateを選ぶ。
- manifestからversion、channel、target identityを共通CI処理で導出する。
- raw trigger、ref kind、手動起動権限からpublish authorityを決定する。
- token名、保存先、fallback条件をCIの共通方針として定義する。
- provider固有のAPI、CLI、credential、package metadata規則をCIスキルの標準assetに実装する。
- 既存resourceを上書きする、または状態不明のまま再publishする。
