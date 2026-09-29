# CI資材の選択配布ガイド

## 目的

GitHub Releaseで承認された配布manifestを起点に、必要なpresetまたはassetだけをfull commit SHA固定sourceから取得し、canonical workflowを差分確認後に配置する。

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

repository保守またはoffline再構成では、同じsnapshotのlocal manifestとsource rootを明示できる。通常consumer導入でbranch checkoutへ置き換えない。

取得済みdistributionを別の操作で利用する前に、receiptに記録された全fileを再検証できる。

```bash
node fetch-a3-ci-github.mjs verify \
  --source-revision "{distribution-full-commit-sha}" \
  --repo-root "{project-root}"
```

## Plan

取得結果が返した`sourceRevision`と、取得時と同じpresetまたはassetを指定する。

```bash
node fetch-a3-ci-github.mjs plan \
  --source-revision "{distribution-full-commit-sha}" \
  --preset quality-gate \
  --repo-root "{project-root}"
```

planはworkflow destinationを`create`、`reuse`、`update`、`conflict`へ分類する。既存asset lockが現在のdestination digestを所有する場合だけ`update`とし、それ以外の差分は`conflict`とする。所有権判定に使ったasset lockの存在状態とdigestもplanへ固定する。過去のlockにあり今回選択されないpathは`stale`として報告するが削除しない。

## Apply

`conflict`がないplanの内容とdigestを確認し、同じdigestを明示して適用する。

```bash
node fetch-a3-ci-github.mjs apply \
  --plan "{plan-path}" \
  --approve "{plan-digest}" \
  --repo-root "{project-root}"
```

applyはproject単位の排他を取得し、manifest、source、destination、asset lock、plan digestを再確認する。変化があれば停止する。変更前fileとそのdigestはconsumer変更前にtransactionへ保持し、partial failureでは全backupを事前検証して今回の変更を復旧する。中断したrollbackは記録済み状態から再開できる。

## 適用後

1. workflow placeholder、Action pin、runner、tool version、Variable、Secret参照をprojectの正本へ接続する。
2. 必要なexternal skill identityとdigestを確認し、既存materializerでadapterを生成する。
3. `generate-ci-asset-lock.ts`で`.ci/ci-assets.lock.json`を生成する。
4. a3-lintとactionlintを実行する。
5. `validate-ci-preset.guide.md`のpreflightを実行する。
6. project-owned adapterとconsumer契約テストを実行する。
7. GitHub上でしか確認できない契約だけhosted evidenceを取得する。

通常のCI実行はproject-local distributionを参照しない。

## Rollback

apply成功後に配置を戻す場合は、apply結果のtransaction IDを指定する。

```bash
node fetch-a3-ci-github.mjs rollback \
  --transaction "{transaction-id}" \
  --repo-root "{project-root}"
```

rollbackはそのtransactionが変更したworkflowだけを変更前状態へ戻す。`applying`で中断したtransactionも、記録済みbackupと現在digestを全件検証してから復旧できる。プロセス強制終了で`apply.lock`が残った場合は、同じprojectを操作するCLIが存在しないことを運用者が確認してからlockを明示的に除去し、自動回収や推測削除は行わない。旧distributionの削除、stale workflowの削除、Agent Skillのpruneは行わない。

## 更新と削除

新revisionは別の`distributions/{sourceRevision}`へ取得し、planから再適用する。新revisionのlock、lint、preflight、consumer契約テストが成功するまで旧revisionを保持する。

旧distributionは、現行lock、rollback対象、実行中transactionから未参照であることを確認した後、別の明示pruneとして扱う。判断不能なら削除しない。Agent Skillは`project-skill-deploy`のdry-runと明示pruneへ委譲する。
