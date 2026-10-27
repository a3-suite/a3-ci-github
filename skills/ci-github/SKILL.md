---
name: ci-github
description: GitHub Actions向けCIの設計、セットアップ・更新、canonical workflowと固定SHA Actionの接続、preflightと品質検証、Release／package公開の実装・復旧、製品と対応スキルの同時Release、既存CIのレビュー、CI結果の解析、適用済みCIの構成監査・証跡監査を行うときに使う。
---

# ci-github / SKILL

## 目的

- GitHub Actions 上の quality、Release、package publication を、プロジェクトの契約と実装へ接続する。
- Agent Skill を実装資産の保管場所にせず、設計・導入・検証・監査・復旧の入口に限定する。

## 原則

- SDD を採用しているプロジェクトでは、要求、観測可能な契約、設計境界は current SDD を正本とする。
- canonical workflow は `workflows/`、Action は `actions/`、配置・検証処理は `runtime/` が所有する。
- スキル内へ workflow、Action、runtime、lint rule を複製しない。
- Action は利用可能性と公開契約を確認し、固定 commit SHA で接続する。
- job境界、permissions、credential注入、runner trust、artifact handoff、publish判断はworkflow側に保持する。
- 標準品質commandはこのproviderのbundleとして提供する。言語一般の規約・lintルールは言語owner、project固有のcommandはproject ownerが所有するadapter契約へ委譲する。

## 責務境界

- 所有: provider 非依存の CI 判断を GitHub Actions の workflow、固定 SHA Action、配布資材、監査へ写像すること
- 非対象: provider 非依存の CI の目的・責務・信頼境界・実行効率の判断（ci スキル）
- 非対象: GitHub Actions以外のCI provider
- 非対象: language固有commandの定義
- 非対象: branch、tag、version policyの再定義

## 関連スキル

- 必須: ci, git, git-branch-strategy, post-artifact-review, audit
- 任意: github-actions, a3-lint, dependency-selection, ci-release-installer, repository-audit, review, test, secret-management, change-proposal, a3-suite

## トリガー＆アクション

### GitHub Actions CIを設計したい

- 対象ユースケース、trust境界、停止条件、必要なActionとworkflow mappingを確認する。
- 成果物: workflow mapping と、選択した preset・Action・trust 境界
- 参照: references/design-ci-workflow.guide.md

### CIをセットアップ・更新したい、またはcanonical workflowを適用したい

- 導入完了条件まで実施する。ガイドの紹介や構成提案だけで終了しない。
- 成果物: 導入したCIと、実施結果・未確認事項・ブロッカーの報告
- 参照: references/deploy-ci-assets.guide.md
- 参照: references/configure-ci-preset.guide.md
- 参照: references/validate-ci-preset.guide.md

### 必要なCI資材だけを取得・更新・復旧したい

- presetまたはassetを選択し、検証済みproject-local distributionへ取得する。
- 成果物: 取得・検証した distribution と、その revision
- 参照: references/deploy-ci-assets.guide.md

### 適用済みCIを監査したい

- 監査段階を選び、スクリプト実行と毎回必須の確認から始める。検出があった場合や詳細確認を依頼された場合だけ専用ガイドへ進む。
- 成果物: 構成監査と証跡監査を分けた監査結果と、推奨対応
- 参照: references/verify-applied-ci-preset.guide.md
- 参照: references/triage-ci-audit-findings.guide.md
- 参照: references/inspect-ci-audit-details.guide.md

### 既存のCIワークフローをレビューしたい

- 参照: references/review-ci-workflow.guide.md

### CI結果を解析したい

- workflow の外で解析する。
- 成果物: 失敗と欠測を分けた解析結果
- 参照: references/analyze-ci-result.guide.md

### Releaseまたはpackage公開を実装・復旧したい

- 公開経路の安全不変条件を確認して実装する。状態不明や部分公開では自動上書きしない。
- 成果物: 実装した公開経路、または復旧の判断と委譲先
- 参照: references/implement-release-asset-publication-workflow.guide.md
- 参照: references/implement-package-publish-workflow.guide.md

### 製品と対応スキルを同じReleaseで提供したい

- 公開スキルの有無と製品ownerの同梱・未同梱の選択を確認する。
- 成果物: 同梱の選択と、同梱する場合の公開宣言
- 参照: references/publish-project-skills.guide.md
