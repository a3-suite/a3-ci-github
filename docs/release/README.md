# Release

各 Action は bundle 済みの `dist/` を同一コミットに含めて配布します。

## Release ref

- リリース ref の命名・起点・承認条件は、git-branch-strategy と git の正本で判定します。
- 本リポジトリの初回リリース候補は version tag `v0.1.0` と major alias `v0` です。alias は検証済みリリースと同一コミットに付与します。
- 実際のタグ作成・push は、対象コミットと検証結果を確認した別の release 操作で行います。

## このrepositoryの公開実行

source versionの正本は`VERSION`です。開発中は`X.Y.Z-dev.N`、release fixing後は`X.Y.Z`とし、exact tagはrelease表記のcommitだけに付与します。統合・fixingの承認条件はgit-branch-strategyを参照します。

`.github/workflows/release.yml`は`workflow_dispatch`で実行します。`release-tag`には承認したannotated exact tag、`release-notes`には承認した本文をそのまま指定します。titleはexact tagです。タグのpushだけでは公開しません。dispatchするworkflow revisionも承認対象に含め、今回の検証済み実装を使います。

通常版のsourceはmainへ統合済みであることを要求します。公開前のhotfixに限り、tagged sourceと`origin/hotfix/X.Y.Z`のtipが一致し、直前patchのannotated base tagがsourceとmain双方の祖先であり、mainのVERSIONがbase版に一致することを検証します。この例外では公開成功後にmain統合を行えるため、公開前にmain統合を要求しません。

公開処理はdraft作成、3資材の登録、asset IDとbytesのreadback、tag・Release identity・承認本文の再確認、draft解除の順です。既存資材を上書きせず、公開済みReleaseへ不足資材を追記しません。既存本文が承認本文と異なる場合も停止します。公開前に失敗したdraftは保持し、修正後の再実行で同じ資材を検証します。公開後の最終確認または独立readbackの失敗でもalias更新は停止し、公開物を上書きせず原因と次の対応を判断します。

公開後の独立readbackが成功してからaliasを更新します。hotfixはworkflow全体の成功と公開物を確認し、git-branch-strategyに従ってmain・developへ統合します。exact tagは移動しません。

## 公開後の整合確認

Action実装からworkflow・callerへ接続するコミットの順序は、[固定参照の更新順序](../maintenance/action-construction.md#固定参照の更新順序)に従います。

本repositoryのRelease公開から公開Skillの利用可能化までを、次の経路で確認します。

1. `.github/workflows/release.yml`の公開・3資材のreadback・alias更新結果と、対象tagのpeeled full SHAを確認します。
2. [preset registry](../../skills/ci-github/references/ci-github-preset-assets.reference.yml)のAction固定参照とcanonical workflowの接続先を、公開実装に合わせて更新します。各targetの利用可能化はregistryのactivation条件と証拠で判定します。
3. 再利用workflowごとに要求されるHosted受入を確認します。provider自身のCIや配布Releaseのreadbackを、consumerのpublication・handoff・required checkの受入証拠として扱いません。未達の経路は受入待ちとして残します。
4. 修正した正本と公開済み配布物を区別し、配布物側に残る旧registryは次の修正版Releaseで反映します。既存Releaseの固定参照は維持します。
5. [skills-deploy](../../.agents/skills/skills-deploy/SKILL.md)で対象Skillと明示された配備先の差分確認・承認された反映・再検査を行います。

完了報告では、Release公開、registryの利用可能化、経路別Hosted受入、配布物への反映、Skill配備の達成状態と未確認・受入待ちを分けて示します。対応する後続操作が未実施なら、公開成功だけで全体の切替完了としません。
