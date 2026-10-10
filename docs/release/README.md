# Release

各 Action は bundle 済みの `dist/` を同一コミットに含めて配布します。

## Release ref

- リリース ref の命名・起点、バージョンの表記・確定条件、公開後の統合・forward-port の可否は git-branch-strategy の正本で判定し、操作の承認は git の正本に従います。
- 実際のタグ作成・push は、対象コミットと検証結果を確認した別の release 操作で行います。

## このrepositoryの公開実行

source versionの正本は`VERSION`です。

通常リリースとhotfixは、[publication契約](../../sdd/dsl/specs/contract-core/subjects/ci-selective-distribution/clauses.sdd.yml)に従い、実装と接続を1つのexact tagとReleaseで公開します。準備と検査コマンドは[固定参照の更新順序](../maintenance/action-construction.md#固定参照の更新順序)へ委譲します。Release workflowは最終tagのcheckoutで包含・同一性と固定SHA先の契約を検査してから資材を生成します。

`.github/workflows/release.yml`は`workflow_dispatch`で実行します。`release-tag`には承認したannotated exact tag、`release-notes`には承認した本文をそのまま指定します。titleはexact tagです。タグのpushだけでは公開しません。dispatchするworkflow revisionも承認対象に含め、今回の検証済み実装を使います。

sourceとhotfix baseのmain統合証拠は、[publication契約](../../sdd/dsl/specs/contract-core/subjects/ci-selective-distribution/clauses.sdd.yml)の`selective-distribution-publication-intent`を正本とし、`runtime/repository/update-release-aliases.sh`が検証します。

公開処理はdraft作成、3資材の登録、asset IDとbytesのreadback、tag・Release identity・承認本文の再確認、draft解除の順です。既存資材を上書きせず、公開済みReleaseへ不足資材を追記しません。既存本文が承認本文と異なる場合も停止します。公開前に失敗したdraftは保持し、修正後の再実行で同じ資材を検証します。公開後の最終確認または独立readbackの失敗でもalias更新は停止し、公開物を上書きせず原因と次の対応を判断します。

公開後の独立readbackが成功してからaliasを更新します。exact tagは移動しません。

## Release公開と利用側受入の順序

公開条件と導入時生成・導入後検証の責務は、[配布契約](../../sdd/dsl/specs/contract-core/subjects/ci-selective-distribution/clauses.sdd.yml)のpublication／applicationを正本とします。

公開前は提供元CIで生成・固定参照・接続契約を検証します。公開後、導入先は提供スクリプトでtemplateへ製品設定と固定参照を埋め込み、生成したcallerを配置して環境を検証します。全5経路のHosted成功証拠を公開・導入の必須条件にしません。

公開workflowは生成・接続契約の回帰を実行してから配布資材を組み立てます。導入先のHosted実行結果はmanifestや通常planの入力にしません。

## 公開後の整合確認

Action実装からworkflow・callerへ接続するコミットの順序は、[固定参照の更新順序](../maintenance/action-construction.md#固定参照の更新順序)に従います。

Release公開結果を確認し、接続変更・利用可能化・Skill配備を行う場合は該当する項目を確認します。

1. `.github/workflows/release.yml`の公開・3資材のreadback・alias更新結果と、対象tagのpeeled full SHAを確認します。
2. manifestのcallee参照が公開tagのpeeled SHAに一致し、Action・installerの固定参照が同じReleaseのpublication契約を満たすことを確認します。公開後に参照更新を必須の後続作業として残さず、実装SHAとcalleeのSHAを混同しません。
3. 導入先では選択presetのcallerを生成し、製品設定・認証・required checkの受入を行います。生成・接続契約の検証は導入先の環境確認の代替にはしません。
4. 公開物は更新しません。実装・template・契約の修正は次のReleaseへ含めます。
5. 公開Skillを配備する場合は、[skills-deploy](../../.agents/skills/skills-deploy/SKILL.md)で対象Skillと明示された配備先の差分確認・承認された反映・再検査を行います。

完了報告では、今回の対象となったRelease公開、registryの利用可能化、経路別Hosted受入、配布物への反映、Skill配備の達成状態と未確認・受入待ちを分けて示します。対応する後続操作が未実施なら、公開成功だけで全体の切替完了としません。
