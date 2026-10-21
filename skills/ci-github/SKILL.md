---
name: ci-github
description: GitHub Actions向けCIの設計、セットアップ・更新、canonical workflowと固定SHA Actionの接続、preflightと品質検証、Release／package公開の実装・復旧、製品と対応スキルの同時Release、既存CIのレビュー、CI結果の解析、適用済みCIの構成監査・証跡監査を行うときに使う。
---

# ci-github / SKILL

## 目的

- GitHub Actions 上の quality、Release、package publication を、SDDで確定した契約と実装へ接続する。
- Agent Skill を実装資産の保管場所にせず、設計・導入・検証・監査・復旧の入口に限定する。

## 原則

- 要求、観測可能な契約、設計境界はプロジェクトの current SDD を正本とする。
- canonical workflow は `workflows/`、Action は `actions/`、配置・検証処理は `runtime/` が所有する。
- スキル内へ workflow、Action、runtime、lint rule を複製しない。
- Action は利用可能性と公開契約を確認し、固定 commit SHA で接続する。
- job境界、permissions、credential注入、runner trust、artifact handoff、publish判断はworkflow側に保持する。
- 標準品質commandはこのproviderのbundleとして提供する。言語一般の規約・lintルールは言語owner、project固有のcommandはproject ownerが所有するadapter契約へ委譲する。

## 関連スキル

- 必須: git, git-branch-strategy, post-artifact-review
- 任意: github-actions, a3-lint, dependency-selection

## 注意

- 非対象: GitHub Actions以外のCI provider
- 非対象: language固有commandの定義
- 非対象: branch、tag、version policyの再定義

## トリガー＆アクション

### GitHub Actions CIを設計したい

- SDDで対象ユースケース、trust境界、停止条件、必要なActionとworkflow mappingを確認する。
- 参照: references/design-ci-workflow.guide.md

### CIをセットアップ・更新したい、またはcanonical workflowを適用したい

- 導入完了条件まで実施し、実施結果・未確認事項・ブロッカーを報告する。ガイドの紹介や構成提案だけで終了しない。
- 参照: references/deploy-ci-assets.guide.md
- 参照: references/configure-ci-preset.guide.md
- 参照: references/validate-ci-preset.guide.md

### 必要なCI資材だけを取得・更新・復旧したい

- presetまたはassetを選択し、full commit SHA固定sourceから検証済みproject-local distributionへ取得する。
- 参照: references/deploy-ci-assets.guide.md

### 適用済みCIを監査したい

- 通常は構成監査とし、証跡監査・両段階・リリース前の実行確認を指定された場合だけ、同じ対象について証跡監査へ進む。構成適合と実行証跡の結果を分けて報告する。
- リリース前の確認では、採用可能な最新の公開済み安定版（`references/deploy-ci-assets.guide.md`の「対応条件」）の標準構成との整合を中心に監査する。
- その標準への更新と、製品・installer・公開スキルを同じversionのReleaseで公開することを推奨対応として促す。採用済みの公開経路ではversionの整合も確認する。
- 参照: references/verify-applied-ci-assets.guide.md
- 参照: references/verify-applied-ci-preset.guide.md

### 既存のCIワークフローをレビューしたい

- 参照: references/review-ci-workflow.guide.md

### CI結果を解析したい

- 解析はworkflowの外で行い、CI workflow runtimeへ解析用のcommandを持ち込まない。
- 参照: references/analyze-ci-result.guide.md

### Releaseまたはpackage公開を実装・復旧したい

- authority、固定source、handoff、非上書き、公開後readbackを確認し、状態不明や部分公開では自動上書きしない。
- 参照: references/implement-release-asset-publication-workflow.guide.md
- 参照: references/implement-package-publish-workflow.guide.md

### 製品と対応スキルを同じReleaseで提供したい

- 公開スキルの有無と製品ownerの同梱・未同梱の選択を確認する。同梱する場合は、installerと独立したOS共通ZIPを同じReleaseへ含める。
- 参照: references/publish-project-skills.guide.md
