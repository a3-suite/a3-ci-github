# Release

各 Action は bundle 済みの `dist/` を同一コミットに含めて配布します。

## Release ref

- リリース ref の命名・起点・承認条件は、git-branch-strategy と git の正本で判定します。
- 本リポジトリの初回リリース候補は version tag `v0.1.0` と major alias `v0` です。alias は検証済みリリースと同一コミットに付与します。
- 実際のタグ作成・push は、対象コミットと検証結果を確認した別の release 操作で行います。

## 公開後の整合確認

Action実装からworkflow・callerへ接続するコミットの順序は、[固定参照の更新順序](../maintenance/action-construction.md#固定参照の更新順序)に従います。

本repositoryのRelease公開から公開Skillの利用可能化までを、次の経路で確認します。

1. `.github/workflows/release.yml`の公開・3資材のreadback・alias更新結果と、対象tagのpeeled full SHAを確認します。
2. [preset registry](../../skills/ci-github/references/ci-github-preset-assets.reference.yml)のAction固定参照とcanonical workflowの接続先を、公開実装に合わせて更新します。各targetの利用可能化はregistryのactivation条件と証拠で判定します。
3. 再利用workflowごとに要求されるHosted受入を確認します。provider自身のCIや配布Releaseのreadbackを、consumerのpublication・handoff・required checkの受入証拠として扱いません。未達の経路は受入待ちとして残します。
4. 修正した正本と公開済み配布物を区別し、配布物側に残る旧registryは次の修正版Releaseで反映します。既存Releaseの固定参照は維持します。
5. [skills-deploy](../../.agents/skills/skills-deploy/SKILL.md)で対象Skillと明示された配備先の差分確認・承認された反映・再検査を行います。

完了報告では、Release公開、registryの利用可能化、経路別Hosted受入、配布物への反映、Skill配備の達成状態と未確認・受入待ちを分けて示します。対応する後続操作が未実施なら、公開成功だけで全体の切替完了としません。
