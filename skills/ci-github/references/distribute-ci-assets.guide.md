# CI資材の選択配布ガイド

## 目的

GitHub Releaseの配布manifestを起点に、必要なpresetまたはassetだけをfull commit SHA固定sourceから取得し、製品設定を埋め込んだcanonical callerを差分確認後に配置する。

## 対応版

このガイドの生成・適用経路は、**v0.2.7以降のexact Release**を対象とする。fetch CLI、manifest、`SHA256SUMS`は同じexact Releaseから取得する。対象Releaseが未公開の場合は、公開後に取得して導入を開始する。

v0.2.6はschema `2`と利用可能なreusable workflowを導入した版だが、pin companionの自動生成・lock管理・完全検証と、旧distributionがない場合の分類診断には対応していない。schema `2`であることだけでは本ガイドの対応版条件を満たさない。

## 境界

- 配布assetと依存閉包の正本は`ci-distribution-assets.reference.yml`と`ci-github-preset-assets.reference.yml`とする。
- Releaseはmanifest、単独実行できるfetch CLI、`SHA256SUMS`だけを公開する。
- checksumは取得byteの完全性を検証する。発行者の真正性はGitHub repositoryのRelease公開権限、protected source、exact tag、TLSを信頼境界とする。
- workflow以外のruntime、lint rule、registryは`{project-root}/.a3-skills/ci-github/distributions/{sourceRevision}/`から導入・保守・検証時だけ参照する。
- Actionはdownloadせず、registryの40桁commit SHAをworkflowへ設定する。
- external skill asset、project-owned extension、Secret、project設定は取得・copyしない。

## 取得

Releaseページから`fetch-a3-ci-github.mjs`と`SHA256SUMS`を取得し、CLIのchecksumを確認する。manifestは次のexact Release URLを指定する。

```text
https://github.com/a3-suite/a3-ci-github/releases/download/{exact-tag}/a3-ci-github-distribution-manifest.json
```

presetの全必須閉包を取得する。

```bash
node fetch-a3-ci-github.mjs fetch \
  --manifest-url "{exact-manifest-url}" \
  --preset quality-gate \
  --repo-root "{project-root}"
```

assetだけを取得する場合は`--asset`を繰り返す。直接asset選択では依存を暗黙追加しないため、必要な依存assetも明示する。workflow assetの直接選択は取得までに限定し、copyのplanには対応presetを必ず指定する。

```bash
node fetch-a3-ci-github.mjs fetch \
  --manifest-url "{exact-manifest-url}" \
  --asset runtime.preset \
  --asset registry.ci-github \
  --repo-root "{project-root}"
```

標準presetにはmaterializerを含めない。設定検査・binding確認または独自adapter配置で必要になった場合だけ、同じexact manifestで選択presetに追加する。同一revisionの取得済み資材は検証後に併合され、既存ファイルを保持する。

```bash
node fetch-a3-ci-github.mjs fetch \
  --manifest-url "{exact-manifest-url}" \
  --preset quality-gate \
  --asset runtime.adapter-materializer \
  --repo-root "{project-root}"
```

optional platform品質はcallerと検証用calleeソースを明示選択する。fetchとplanの両方に同じ選択を渡す。

```bash
node fetch-a3-ci-github.mjs fetch \
  --manifest-url "{exact-manifest-url}" \
  --preset quality-gate \
  --asset workflow.quality-gate-platforms \
  --asset runtime.quality-platforms-workflow \
  --repo-root "{project-root}"
```

calleeソースは選択したworkflowの依存閉包だけ取得し、distribution内でpreflightが参照する。consumerへのcopy対象には含めない。依存assetのIDと構成は配布registryを正本とする。

repository保守またはoffline再構成では、同じsnapshotのlocal manifestとsource rootを明示できる。通常consumer導入でbranch checkoutへ置き換えない。

取得済みdistributionを別の操作で利用する前に、receiptに記録された全fileを再検証できる。

```bash
node fetch-a3-ci-github.mjs verify \
  --source-revision "{distribution-full-commit-sha}" \
  --repo-root "{project-root}"
```

## Plan

この生成経路はmanifest schemaVersion `2`を使用する。旧`1`は受理しない。既存の旧配布を暗黙に変換せず、新manifestと差分を確認して移行する。

取得結果が返した`sourceRevision`と、取得時と同じpresetまたはassetを指定する。先に`configure-ci-preset.guide.md`の導入時runtimeを準備する。生成処理は既存runtimeのYAML依存を使用し、導入先に個別の生成スクリプトや追加の設定ファイルは作らない。

`--set 'workflow.{asset名}:{placeholder名}={JSON値}'`を繰り返して製品設定を渡す。設定名は選択したtemplateを正本とし、文字列、真偽値、branch配列をJSONで指定する。未知・未指定の必須設定、型不一致は停止する。Action pinとcalleeのSHAはmanifestから自動解決し、利用者は指定しない。

```bash
node fetch-a3-ci-github.mjs plan \
  --source-revision "{distribution-full-commit-sha}" \
  --preset quality-gate \
  --set 'workflow.quality-gate:protected-branch=["main"]' \
  --set 'workflow.quality-gate:versioned-runner="ubuntu-24.04"' \
  --set 'workflow.quality-gate:language-profile="typescript"' \
  --set 'workflow.quality-gate:toolchain-version="24"' \
  --set 'workflow.quality-gate:standard-bundle-id="typescript-npm-quality"' \
  --repo-root "{project-root}"
```

planはworkflow destinationを`create`、`reuse`、`update`、`conflict`へ分類する。直接参照する外部Actionがあるcallerには、provider CLIがregistryの`providerActions.entries`と`pinCompanion.fields`から完全なpin companionを生成し、同じ分類・承認対象に含める。companionは独自編集しない。品質callerだけを持つprojectでは生成しない。既存asset lockが現在のdestination digestを所有する場合だけ`update`とし、それ以外の差分は`conflict`とする。所有権判定に使ったasset lockの存在状態とdigestもplanへ固定する。過去のlockにあり今回選択されないpathは`stale`として報告するが削除しない。

### 旧配布からの初回移行（create経路）

v0.2.5以前のschema `1`からは通常の`update`を使わず、「対応版」を満たす新Releaseへ`create`経路で移行する。旧schemaの読み込み・自動変換は行わない。旧lockのrevisionに対応するdistributionがない場合は`distribution-local-manifest-missing`、旧schemaの場合は`distribution-manifest-contract-unsupported`で停止する。lockを手編集して更新を通さない。

1. 新しいexact Releaseを取得し、旧lock、置換対象caller、retired資産を棚卸しする。retiredの定義はpreset registryを参照し、製品設定・owner adapter・Secretsを移行対象と混同しない。旧callerの許可された設定値を確認して、後述のplanへ`--set`で明示する。
2. consumerの運用者が退避・除去対象の正確なpathを承認する。consumerのGit除外された`tmp/`配下に専用退避先を作り、各対象を元の相対pathを維持してcopyする。元path・退避path・SHA-256を記録し、退避byteとの一致を確認する。退避対象外は変更しない。
3. 確認済みの旧lock、置換対象caller、retired資産だけを作業ツリーから除去する。旧distributionと退避は保持する。旧lockが存在しない状態で取得した新revisionを指定してplanし、製品設定を`--set`で渡す。対象callerと必要なcompanionが`create`となること、`conflict`や意図しない対象がないことを確認し、digestを承認してapplyする。
4. 「適用後」のlock生成、lint、preflight、consumer契約テストまで実行する。lock生成直後に新lockのpath・sourceRevision・SHA-256を退避記録へ追記し、後続検証の前に復旧用のidentityを確定する。初回移行の完了はこの検証がすべて成功した時点とし、Hosted受入は別途記録する。

検証完了前に失敗した場合はその先へ進めず、次の順で旧状態を復旧する。apply transactionが存在する場合はtransaction記録の状態と各pathの復旧byteを確認する。`rolled-back`で今回の変更が復旧済みならCLI rollbackを再実行せず、手動復旧へ進む。`applied`、`applying`、`rolling-back`、`rollback-required`ならCLI rollbackを先に実行し、成功と復旧byteを確認する。それ以外の状態や復旧不一致は停止する。新lockが生成されていれば、記録した今回の新lockのdigestと現在byteが一致することを確認して、そのlockだけを除去する。その後、退避SHA-256を再確認して旧caller・retired資産・旧lockを元pathへ戻し、復元後もdigestを確認する。applyの自動rollbackや明示rollbackが復旧するのはplan内の変更だけであり、手動退避した旧資産とapply後に生成したlockは運用者が復旧する。現在pathに想定外のbyteや第三者の変更がある場合は上書きせず停止する。退避と旧distributionの削除はこの移行に含めない。

## Apply

planはsourceと生成後fileのdigestを別々に保持し、生成byteも承認digestに含める。schema `2`同士の更新では旧distributionと既存lockを使い、設置済みcallerの許可された製品設定を引き継ぐ。job・step・permissions等の構造変更は停止する。追加の`--set`だけが設定を上書きする。選択calleeの固定参照は検証済みmanifestから解決する。

`conflict`がないplanの内容とdigestを確認し、同じdigestを明示して適用する。

```bash
node fetch-a3-ci-github.mjs apply \
  --plan "{plan-path}" \
  --approve "{plan-digest}" \
  --repo-root "{project-root}"
```

applyはproject単位の排他を取得し、manifest、source、destination、asset lock、plan digestを再確認する。変化があれば停止する。変更前fileとそのdigestはconsumer変更前にtransactionへ保持し、partial failureでは全backupを事前検証して今回の変更を復旧する。中断したrollbackは記録済み状態から再開できる。

## 適用後

1. 生成済みcallerを製品設定の正本として読み返し、必要なVariablesとSecretsを登録する。placeholderを手動置換しない。
2. 標準bundleの配置は不要。独自adapter配置またはbinding検査が必要な場合だけmaterializerを追加取得し、`configure-ci-preset.guide.md`の準備済みruntimeで実行する。external skillを利用する場合はそのidentityとdigestも確認する。
3. `generate-ci-asset-lock.ts`で`.ci/ci-assets.lock.json`を生成する。必要なcompanionも管理対象となり、registry入力のcanonical digestと設置byteのapplied digestを記録する。使用中・未使用を問わず全entryの欠落・追加・独自編集は拒否する。
4. a3-lintとactionlintを実行する。
5. `validate-ci-preset.guide.md`のpreflightを実行する。
6. project-owned adapterがある場合はその確認を行い、consumer契約テストは常に実行する。
7. GitHub上でしか確認できない契約だけhosted evidenceを取得する。

通常のCI実行はproject-local distributionを参照しない。

生成・適用・lock生成の成功と、導入先のHosted環境受入は別に記録する。Hosted実行や外部への書き込み・公開は別途承認を要する。

## Rollback

apply成功後に配置を戻す場合は、apply結果のtransaction IDを指定する。

```bash
node fetch-a3-ci-github.mjs rollback \
  --transaction "{transaction-id}" \
  --repo-root "{project-root}"
```

rollbackはそのtransactionが変更したcallerとcompanionを変更前状態へ戻す。apply後のasset lock生成はtransaction外であるため、更新時は旧lockも別途退避し、新lockのidentityを確認して復旧する。`applying`で中断したtransactionも、記録済みbackupと現在digestを全件検証してから復旧できる。プロセス強制終了で`apply.lock`が残った場合は、同じprojectを操作するCLIが存在しないことを運用者が確認してからlockを明示的に除去し、自動回収や推測削除は行わない。旧distributionの削除、stale workflowの削除、Agent Skillのpruneは行わない。

## 更新と削除

新revisionは別の`distributions/{sourceRevision}`へ取得し、planから再適用する。新revisionのlock、lint、preflight、consumer契約テストが成功するまで旧revisionを保持する。

旧distributionは、現行lock、rollback対象、実行中transactionから未参照であることを確認した後、別の明示pruneとして扱う。判断不能なら削除しない。Agent Skillは`project-skill-deploy`のdry-runと明示pruneへ委譲する。
