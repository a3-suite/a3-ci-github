# Runtime

workflowの配置・preflightと、Actionから再利用する定型処理を管理します。

- `adapter/`: language／project adapterのmaterializeと結果整形
- `provisioner/`: gh／jq provisionerが共有するchecksum照合、download、PATH handoff
- `preset/`: canonical workflowの配置同一性、lock、platform manifestの検証
- `github-toolchain/`: GitHub CI toolchainの固定版検証
- `rust-release/`: Rust CLI Releaseのsource identity、build、package、artifact検証
- `repository/`: Action catalogと配布物を検証するリポジトリ保守処理
- `contract-subject-coverage.mjs`: 契約対象別の実行定義とcoverageを検証する入口

各処理は引数、環境変数、終了状態、診断メッセージを公開契約として持ち、単独で検証できる状態を保ちます。Composite Actionは同じrefのruntimeを呼び出す薄いadapterとし、処理本体を複製しません。
