# ci-quality-toolchain

品質検証で選択した固定toolchainを準備するcomposite Actionです。公開入力の正本は
[action.yml](action.yml)です。TypeScriptはNode、PythonはPythonとuv、Rustはrustfmt／clippyを含むRustとcargo-auditを準備します。

入力の検証を準備処理より先に実行します。toolchainの版は3成分の固定版（必要ならprerelease suffix）を指定し、Pythonではuv、Rustではcargo-auditの版も必要です。未選択の補助toolchain入力は使用しません。未知のprofile、版の不足・不正、選択した準備処理の失敗でActionを失敗させます。

Nodeのnpm cache設定とRustの`RUSTUP_TOOLCHAIN`設定を維持します。準備後の完全一致バージョン確認と品質command実行は[ci-quality-adapter](../ci-quality-adapter/README.md)が担当します。
checkout、runner、実行条件、権限、credential、品質結果・公開判断はworkflowが所有します。

公開状態と承認済み固定参照は[preset registry](../../skills/ci-github/references/ci-github-preset-assets.reference.yml)を正本とし、preflightはそのavailability gateに従います。
