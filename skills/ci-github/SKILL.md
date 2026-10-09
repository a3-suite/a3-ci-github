---
name: ci-github
description: GitHub Actions向けCIの設計、セットアップ・更新、canonical workflowの選択・配置、固定SHA Actionの接続、preflight、品質検証、Release／package公開、構成監査・証跡監査、復旧を行うときに使う。
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

### CIをセットアップ・更新したい、またはcanonical workflowを適用したい

- `references/configure-ci-preset.guide.md`を実施し、導入完了条件まで確認する。Releaseの選定・比較は選択配布ガイド、標準構成の優先と既存の固有実装の必要性確認はセットアップガイドに従う。ガイドの紹介や構成提案だけで終了せず、実施結果・未確認事項・ブロッカーを報告する。
- exact Releaseの配布manifestから対象presetを取得し、導入時runtimeで製品設定を埋め込んだcallerを生成する。差分planと明示承認を経て配置し、更新ではcallerの宣言済み設定を保持する。
- 選択した経路の準備は導入ガイドに従い、preflightで適用先を検証する。
- 参照: `references/distribute-ci-assets.guide.md`
- 参照: `references/configure-ci-preset.guide.md`
- 参照: `references/validate-ci-preset.guide.md`

### 必要なCI資材だけを取得・更新・復旧したい

- presetまたはassetを選択し、full commit SHA固定sourceから検証済みproject-local distributionへ取得する。
- workflowのcopy、更新、rollbackはfetch／plan／apply／rollbackの境界に従う。
- 参照: `references/distribute-ci-assets.guide.md`

### 適用済みCIを監査したい

- 通常の監査は構成監査とする。証跡監査・両段階・リリース前の実行確認を指定された場合は、同じ対象について構成監査から証跡監査へ進む。段階選択と判定範囲は監査契約の`auditContract.stages`に従い、構成適合と実行証跡の結果を分けて報告する。
- リリース前の確認として、最新の公開済み安定版の標準構成との整合を中心に監査する。必須subjectの比較基準を固定し、監査ガイドの標準比較工程を実施してから差分の必要性と移行対象を判定・報告する。installerが適用対象なら、固定providerの対応確認とOS別比較を含むowner結果を受け取ってから整合判定へ進む。permissions、runner trust、artifact handoff、停止条件とリリース前の検証証拠は、その裏付けとして確認する。目的と対象境界は監査契約、判定・報告は監査ガイドとsubject catalogに従う。
- 参照: `references/verify-applied-ci-preset.guide.md`

### Releaseまたはpackage公開を実装・復旧したい

- authority、固定source、handoff、非上書き、公開後readbackを確認し、状態不明や部分公開では自動上書きしない。
- 参照: `references/implement-release-asset-publication-workflow.guide.md`
- 参照: `references/implement-package-publish-workflow.guide.md`
