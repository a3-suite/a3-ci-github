# Runtime

workflowの配置・preflightと、Actionから再利用する定型処理を管理します。

- `adapter/`: language／project adapterのmaterialize
- `provisioner/`: gh／jq provisionerが共有するchecksum照合、download、PATH handoff
- `preset/`: canonical workflowの配置同一性、lock、platform manifestの検証
- `github-toolchain/`: GitHub CI toolchainの固定版検証
- `rust-release/`: Rust CLI Releaseのsource identity、build、package、artifact検証
- `repository/`: Action catalogと配布物を検証するリポジトリ保守処理
- `diagnostics/`: 失敗診断の共通出力
- `distribution/`: 選択配布の取得と適用
- `installer/`: installerの組立と検証
- `path/`: path同一性の判定
- `platform/`: platform manifestの解釈と選択
- `release-publication/`: Release資材の組立、公開、読み戻し検証
- `vitest/`: リポジトリ検証が使うVitestレポートの判定

契約対象別の実行定義とcoverageの検証入口は `tests/coverage-tools/contract-subject-coverage.mjs` です。

各処理は引数、環境変数、終了状態、診断メッセージを公開契約として持ち、単独で検証できる状態を保ちます。Composite Actionは同じrefのruntimeを呼び出す薄いadapterとし、処理本体を複製しません。
