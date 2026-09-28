---
name: ci-github
description: GitHub Actions向けCIの設計、canonical workflowの選択・配置、固定SHA Actionの接続、preflight、品質検証、Release／package公開、監査、復旧を行うときに使う。
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
- languageまたはproject固有のcommandは、そのownerが提供するadapter契約へ委譲する。

## 関連スキル

- 必須: git - branch、tag、version、release notes、公開承認を確認するため
- 必須: git-branch-strategy - branch categoryとpublish triggerを確認するため
- 任意: github-actions - Action自体の公開契約と配布方法を確認する場合
- 任意: 各言語スキル - quality、build、package commandを確認する場合

## 注意

- 非対象: GitHub Actions以外のCI provider
- 非対象: language固有commandの定義
- 非対象: branch、tag、version policyの再定義

## トリガー＆アクション

### GitHub Actions CIを設計したい

- SDDで対象ユースケース、trust境界、停止条件、必要なActionとworkflow mappingを確認する。
- 参照: `references/design-ci-workflow.guide.md`

### canonical workflowを適用したい

- `workflows/` から対象を選び、runtimeのmaterializeとpreflightを使って適用先を検証する。
- 参照: `references/configure-ci-preset.guide.md`
- 参照: `references/validate-ci-preset.guide.md`

### 適用済みCIを監査したい

- 配置済みworkflow、固定SHA、permissions、runner trust、artifact handoff、停止条件を契約証拠に照合する。
- 参照: `references/verify-applied-ci-preset.guide.md`

### Releaseまたはpackage公開を実装・復旧したい

- authority、固定source、handoff、非上書き、公開後readbackを確認し、状態不明や部分公開では自動上書きしない。
- 参照: `references/implement-release-asset-publication-workflow.guide.md`
- 参照: `references/implement-package-publish-workflow.guide.md`
