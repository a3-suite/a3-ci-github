# ci-quality-adapter

`ci-quality-adapter` は trusted descriptor に定義された read-only quality commands を fixed source checkout で実行し、構造化結果を出力します。workflow の checkout、権限、credential、trusted descriptor の選択は所有しません。

`bundle-path`、`source-root`、`toolchain-version` は必須です。project script の一致を要求する場合は `require-trusted-project-scripts: true` と `trusted-project-root` を指定します。outputs は `status` と `result-path` です。

descriptor の `toolchain.verify` は `command` / `args` だけを宣言し、実行時出力の形式・パース規則はこの Action が所有します。Action は `command` を実行し、stdout と stderr を連結した出力を ASCII 空白で分割して、`toolchain-version` が独立トークン（`{version}` / `v{version}` / `V{version}` の完全一致）として現れることを検証します。exit≠0 またはトークン不一致の場合は `quality-adapter-toolchain-version-mismatch` と `expected=` / `received=` を stderr に出力します。旧 descriptor の `expectedOutput` は無視します。
