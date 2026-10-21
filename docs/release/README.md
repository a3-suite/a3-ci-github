# Release

各 Action は bundle 済みの `dist/` を同一コミットに含めて配布します。

## Release ref

- リリース ref の命名・起点、バージョンの表記・確定条件、mainへの統合方式、tagの作成元、公開後の統合・forward-port の可否は git-branch-strategy の正本で判定し、操作の承認は git の正本に従います。
- このrepositoryに固有なのは、固定SHA接続の準備コミット、下記のRelease作成の例外、main統合で追加する確認、alias更新の条件だけです。

## このrepositoryの公開実行

source versionの正本は`VERSION`です。

通常リリースとhotfixは、[publication契約](../../sdd/dsl/specs/contract-core/subjects/ci-selective-distribution/subject.sdd.yml)に従い、実装と接続を1つのexact tagとReleaseで公開します。実装コミットAと接続コミットBの準備と候補検査は[固定参照の更新順序](../maintenance/action-construction.md#固定参照の更新順序)に従います。

Bと同じtreeを持つコミットにannotated exact tagを作成した後、そのtagのcheckoutで公開検査を実行します。

```sh
node runtime/repository/check-provider-references.mjs --contracts --release-tag "$RELEASE_TAG"
```

Release workflowはこの公開検査が成功した後だけ資材を生成します。検査JSONとworkflowの結果要約に`implementationSourceRevision`と`implementationBindingStatus`を残します。引数なしの既存参照検査はregistryが宣言するtagを確認する保守用入口であり、公開検査には使いません。

`.github/workflows/release.yml`は`workflow_dispatch`で実行します。`release-tag`には承認したannotated exact tag、`release-notes`には承認した本文をそのまま指定します。titleはexact tagです。タグのpushだけでは公開しません。dispatchするrefは`release-tag`と同じexact tagとし（例：`gh workflow run release.yml --ref v0.6.0`）、通常リリースとhotfixのどちらもbranchから起動しません。workflowはそれ以外のrefからの起動を公開前に拒否します。

aliasは公開済みの安定版だけへ向けます。そのため`runtime/repository/update-release-aliases.sh`は、alias更新の前にtag sourceとhotfix baseのmain統合状態を確かめます。この条件はrepository固有で、[publication契約](../../sdd/dsl/specs/contract-core/subjects/ci-selective-distribution/subject.sdd.yml)の`selective-distribution-alias-source-integrated`に従います。git-branch-strategyのmain統合の判定（`mainIntegrationSafety`）の代わりにはなりません。

公開処理はdraft作成、3資材の登録、asset IDとbytesのreadback、tag・Release identity・承認本文の再確認、draft解除の順です。既存資材を上書きせず、公開済みReleaseへ不足資材を追記しません。既存本文が承認本文と異なる場合も停止します。公開前に失敗したdraftは保持し、修正後の再実行で同じ資材を検証します。公開後の最終確認または独立readbackの失敗でもalias更新は停止し、公開物を上書きせず原因と次の対応を判断します。

公開後の独立readbackが成功してからaliasを更新します。

### Release作成の例外

gitスキルのmainタグリリース手順（`run-main-tag-release-flow`）の実行コマンドのうち、手順5〜10（`gh release create`によるRelease作成から資材登録、draft解除、最終状態の確認まで）を上書きする例外です。

- 差分：annotated exact tagの作成・push（手順1〜4）とリリースノートの承認はgitの手順に従います。手順5〜10は実行せず、上記の`.github/workflows/release.yml`をdispatchして、上記の公開処理とその結果で置き換えます。
- 理由：公開検査の成功、3資材の登録とreadback、alias更新を1つのworkflowで順に条件付ける必要があり、手動のRelease作成では資材と検査結果の対応を保証できないためです。
- 適用範囲：このrepositoryの通常リリースとhotfixのRelease作成・資材登録・公開状態の確認だけです。tagの作成元・削除・再作成と操作の承認は、git-branch-strategyとgitの正本に従います。

## mainへの統合

統合方式、統合前後に集める証拠、拒否条件はgit-branch-strategyの`mainIntegrationSafety`に従います。このrepositoryでは、次を追加で確認します。

- 統合後にtagを作るコミットのtreeが、検証済みの接続コミットBと一致すること。準備と検査は[固定参照の更新順序](../maintenance/action-construction.md#固定参照の更新順序)に従います。
- 実装コミットAがbranchまたはtagから到達可能なまま残ること。squashで統合する場合もAを含むbranchを削除しません。

## Release公開と利用側受入の順序

公開条件と導入時生成・導入後検証の責務は、[配布契約](../../sdd/dsl/specs/contract-core/subjects/ci-selective-distribution/subject.sdd.yml)のpublication／applicationを正本とします。

公開前は提供元CIで生成・固定参照・接続契約を検証します。公開後、導入先は提供スクリプトでtemplateへ製品設定と固定参照を埋め込み、生成したcallerを配置して環境を検証します。全5経路のHosted成功証拠を公開・導入の必須条件にしません。

公開workflowは生成・接続契約の回帰を実行してから配布資材を組み立てます。導入先のHosted実行結果はmanifestや通常planの入力にしません。

## 公開後の整合確認

Action実装からworkflow・callerへ接続するコミットの順序は、[固定参照の更新順序](../maintenance/action-construction.md#固定参照の更新順序)に従います。

Release公開結果を確認し、接続変更・利用可能化・Skill配備を行う場合は該当する項目を確認します。

1. `.github/workflows/release.yml`の公開・3資材のreadback・alias更新結果と、対象tagのpeeled full SHAを確認します。
2. manifestのcallee参照が公開tagのpeeled SHAに一致し、Action・installerの固定参照が同じReleaseのpublication契約を満たすことを確認します。公開後に参照更新を必須の後続作業として残さず、実装SHAとcalleeのSHAを混同しません。
3. 導入先では選択presetのcallerを生成し、製品設定・認証・required checkの受入を行います。生成・接続契約の検証は導入先の環境確認の代替にはしません。
4. 公開物は更新しません。実装・template・契約の修正は次のReleaseへ含めます。
5. 公開Skillを配備する場合は、[skills-deploy](../../.agents/skills/skills-deploy/SKILL.md)で対象Skillと`.env`で指定した配備先の差分確認・承認された反映・再検査を行います。

完了報告では、今回の対象となったRelease公開、registryの利用可能化、経路別Hosted受入、配布物への反映、Skill配備の達成状態と未確認・受入待ちを分けて示します。対応する後続操作が未実施なら、公開成功だけで全体の切替完了としません。
