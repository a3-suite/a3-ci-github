# Release

各 Action は bundle 済みの `dist/` を同一コミットに含めて配布します。

## Release ref

- リリース ref の命名・起点、バージョンの表記・確定条件、公開後の統合・forward-port の可否は git-branch-strategy の正本で判定し、操作の承認は git の正本に従います。
- 実際のタグ作成・push は、対象コミットと検証結果を確認した別の release 操作で行います。

## このrepositoryの公開実行

source versionの正本は`VERSION`です。

`.github/workflows/release.yml`は`workflow_dispatch`で実行します。`release-tag`には承認したannotated exact tag、`release-notes`には承認した本文をそのまま指定します。titleはexact tagです。タグのpushだけでは公開しません。dispatchするworkflow revisionも承認対象に含め、今回の検証済み実装を使います。

sourceとhotfix baseのmain統合証拠は、[publication契約](../../sdd/dsl/specs/contract-core/subjects/ci-selective-distribution/clauses.sdd.yml)の`selective-distribution-publication-intent`を正本とし、`runtime/repository/update-release-aliases.sh`が検証します。

公開処理はdraft作成、3資材の登録、asset IDとbytesのreadback、tag・Release identity・承認本文の再確認、draft解除の順です。既存資材を上書きせず、公開済みReleaseへ不足資材を追記しません。既存本文が承認本文と異なる場合も停止します。公開前に失敗したdraftは保持し、修正後の再実行で同じ資材を検証します。公開後の最終確認または独立readbackの失敗でもalias更新は停止し、公開物を上書きせず原因と次の対応を判断します。

公開後の独立readbackが成功してからaliasを更新します。exact tagは移動しません。

## 公開後の整合確認

Action実装からworkflow・callerへ接続するコミットの順序は、[固定参照の更新順序](../maintenance/action-construction.md#固定参照の更新順序)に従います。

Release公開結果を確認し、接続変更・利用可能化・Skill配備を行う場合は該当する項目を確認します。

1. `.github/workflows/release.yml`の公開・3資材のreadback・alias更新結果と、対象tagのpeeled full SHAを確認します。
2. Action・workflowの接続を変更する場合は、[preset registry](../../skills/ci-github/references/ci-github-preset-assets.reference.yml)とcanonical workflowの参照を、上記の固定参照更新順序に従って更新します。各targetの利用可能化はregistryのactivation条件と証拠で判定します。
3. 再利用workflowの利用可能化を行う場合は、対象workflowに要求されるHosted受入を確認します。provider自身のCIや配布Releaseのreadbackを、consumerのpublication・handoff・required checkの受入証拠として扱いません。未達の経路は受入待ちとして残します。
4. 公開後にregistryを変更した場合は、修正した正本と公開済み配布物を区別し、配布物への反映は次のReleaseで行います。既存Releaseの固定参照は維持します。
5. 公開Skillを配備する場合は、[skills-deploy](../../.agents/skills/skills-deploy/SKILL.md)で対象Skillと明示された配備先の差分確認・承認された反映・再検査を行います。

完了報告では、今回の対象となったRelease公開、registryの利用可能化、経路別Hosted受入、配布物への反映、Skill配備の達成状態と未確認・受入待ちを分けて示します。対応する後続操作が未実施なら、公開成功だけで全体の切替完了としません。
