# Actions

各 Action は `actions/<action-name>/` に独立して配置します。

Action ごとに `action.yml`、adapter、テスト、実行方式に応じた配布物、README を所有し、他の Action の
内部実装へ直接依存しません。共通の定型処理は `runtime/` を実装正本とし、Composite Action から同じ ref の
script を呼び出します。

Action の一覧と用途は、root の [Action一覧](../README.md#action一覧) を参照してください。

これらは判定・変換・証跡処理と、公開契約で明示した標準 build adapterを提供します。workflow の job 境界、
project-owned adapter、publish、credential 管理は Action に含めません。各 Action の `action.yml` が公開 I/O の正本であり、利用側は mutable alias
ではなく provider 側で承認した固定 commit SHA を指定します。
