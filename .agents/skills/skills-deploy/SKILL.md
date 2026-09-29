---
name: skills-deploy
description: a3-ci-github の公開 Agent Skill `skills/ci-github` を外部スキルルートへ反映するときに、対象、配備先、差分、stale、prune の承認境界を固定し、汎用 project-skill-deploy へ安全に委譲するために使う。
---

# skills-deploy / SKILL

## 目的

- 本リポジトリの公開 Agent Skill を外部スキルルートへ配備する操作入口を提供する。
- リポジトリ固有の対象境界だけを保持し、配備処理は `project-skill-deploy` スキルへ委譲する。

## 原則

- 正本は `skills/ci-github/` とし、配備先を直接編集しない。
- source root、対象スキル、配備先を明示し、作業ディレクトリや既知のホームディレクトリから推測しない。
- dry-run で更新、stale、管理外、prune 候補を確認してから反映する。
- 外部スキルルートへの書き込みと削除は、利用者が明示的に許可した場合だけ実行する。
- workflow、Action、runtime、lint rule は公開 Agent Skill に複製しない。

## 関連スキル

- 必須: `project-skill-deploy` - 公開契約検証への委譲を含め、selectable skill の探索、差分検査、反映、stale と prune の判定を実行するため

## 注意

- 非対象: `workflows/`、`actions/`、`runtime/`、`lint-rules/` の配布
- 非対象: a3-ci-github source root の取得、Release 公開、consumer 接続
- 非対象: 外部スキルルートの自動選択、認証情報、環境固有設定の保持
- 非対象: 汎用デプロイ処理やその安全規則の再実装

## トリガー＆アクション

### 公開 Agent Skill の配備差分を確認したい

- `references/deploy-context.md` で source root、対象、配備先、非対象を固定し、差分検査を `project-skill-deploy` へ委譲する。
- 返された更新、stale、管理外、prune 候補を、リポジトリ固有の判断で再分類せず報告する。

### 公開 Agent Skill を外部スキルルートへ反映したい

- 外部書き込みの明示許可後に限り、差分検査と同じ固定入力を `project-skill-deploy` へ渡す。
- stale の削除は prune 対象を個別に確認し、明示許可がある場合だけ委譲する。

### 旧 ci-github スキルを置換したい

- 既存配備先と新しい配備先を同一の明示入力として扱い、二重配置を作らない。
- 旧スキル内の実装資産は stale 候補として報告し、削除対象を確認してから prune する。
- 反映後は新しい `SKILL.md` と `references/` について、許可された反映対象の残存差分を成功扱いしない。

## 参照

- [ci-github スキルデプロイコンテキスト](references/deploy-context.md)
