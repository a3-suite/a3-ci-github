# ci-quality-toolchain

品質検証で選択した固定toolchainを準備するcomposite Actionです。公開入力の正本は
[action.yml](action.yml)です。TypeScriptはNode、PythonはPythonとuv、Rustはrustfmt／clippyを含むRustとcargo-audit、`cargo-deny-version`を指定した場合はcargo-denyを準備します。

入力の検証を準備処理より先に実行します。既定の`version-policy: exact`は3成分の完全版（必要ならprerelease suffix）を要求します。通常の品質CIで`compatible`を選ぶと、Nodeのmajor/minorとPythonのmajor.minorも指定できます。Pythonではuv、Rustではcargo-auditの完全版も必要です。未選択の補助toolchain入力は使用しません。

固定setup Actionの出力から実際の版を取得し、指定範囲と照合します。Pythonのuvにはその解決版を渡します。すべての準備が成功してから`resolved-toolchain-version`を出力し、要求値と解決版をlogへ記録します。callerはこの完全版をadapterと関連jobへ渡し、別jobで範囲を再解決しません。完全版指定なら制御jobでの追加準備は不要です。空の解決結果、範囲外の版、未知のprofile、版の不足・不正、準備処理の失敗で停止し、要求値へのfallbackは行いません。

Nodeのnpm cache設定とRustの`RUSTUP_TOOLCHAIN`設定を維持します。準備後の完全一致バージョン確認と品質command実行は[ci-quality-adapter](../ci-quality-adapter/README.md)が担当します。Release品質とauthority/buildは`exact`を維持します。
checkout、runner、実行条件、権限、credential、品質結果・公開判断はworkflowが所有します。

cargo-auditは、指定版・実行環境に対応する公式バイナリの期待SHA-256が[取得資材データ](scripts/cargo-audit-sha256sums.txt)に登録されていれば、ソースビルドを省いて導入します。このデータはActionと同じ固定参照に含め、実行時に可変APIから期待checksumを取得しません。checksumを照合してから実行ファイルだけを展開し、版の完全一致を確認してPATHへ追加します。未登録の版・環境は従来の`cargo install --locked --version`を維持します。登録済み資材の取得・checksum・展開・版確認の失敗は停止し、ソース導入で隠しません。資材を追加するときは[公式Release](https://github.com/rustsec/rustsec/releases)のasset digestと取得したアーカイブのSHA-256を照合します。登録済みの版を入力の許可リストとして扱いません。

cargo-denyは同じ方式で[取得資材データ](scripts/cargo-deny-sha256sums.txt)を使います。Linuxは上流が配布する静的リンクのmusl版を使います。資材を追加するときは[公式Release](https://github.com/EmbarkStudios/cargo-deny/releases)の`.sha256`と取得したアーカイブのSHA-256を照合します。`cargo-deny-version`が空なら準備しません。

公開状態と承認済み固定参照は[preset registry](../../skills/ci-github/assets/registry/ci-github-preset-assets.yml)を正本とし、preflightはそのavailability gateに従います。
