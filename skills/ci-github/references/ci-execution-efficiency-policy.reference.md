# CI 実行効率ポリシー

> この文書は GitHub Actions provider profile である。品質不変条件、重複実行のキャンセル、publish の直列化、project-local 事前判定、platform 別検証のスコープ、適用判定は `ci` スキルの CI 実行効率ポリシーに従い、本文書は GitHub への写像だけを定める。

## 理解できること
- 実行効率の判断を GitHub Actions の設定と観測へ写像する方法

## GitHub への写像
- 重複実行のキャンセルと publish の直列化キューは、`references/workflow-authoring-policy.reference.md` の「concurrency」の設定で実現する。
- queue 上限を超えて置換された run は job を実行しないため workflow summary では観測できず、GitHub の run status（`cancelled`）で観測する。
- OS選定、検査の同等性、代表OSと省略解除の判断は[OS・版の選定と廃止判断](references/workflow-version-policy.reference.md#os-version-selection)に従う。
