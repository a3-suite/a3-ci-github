# Requirements

リポジトリ横断の要求を配置します。対象読者は、要求を確認・変更する保守者です。要求の正本は `sdd/dsl/requirements/` です。

共通の Action 要求は `sdd/dsl/requirements/items/` 配下の要求 DSL を正本とします。その範囲は `github-actions` スキルが所有する公開契約、入力検証、失敗、配布物、秘密情報、workflow との責務分離であり、個別 Action の input/output や provider の workflow mapping は含みません。
