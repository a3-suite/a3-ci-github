# Requirements

リポジトリ横断の要求を配置します。Action 固有の要求は各 Action 配下の `docs/requirements/` に置きます。

共通の Action 要求は `sdd/dsl/requirements/` 配下の requirement manifest と分割 DSL を正本とします。
ここでは `github-actions` スキルが所有する公開契約、入力検証、失敗、配布物、秘密情報、workflow との責務分離だけを定義し、個別 Action の input/output や provider の workflow mapping は再定義しません。
