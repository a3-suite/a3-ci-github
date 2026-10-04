# ci-quality-adapter

`ci-quality-adapter` は固定版に同梱した標準bundle、またはtrustedな独自descriptorのread-only品質コマンドをfixed source checkoutで実行し、構造化結果を出力します。workflowのcheckout、権限、credential、bundleの選択は所有しません。

`standard-bundle-id` と `bundle-path` はどちらか一つだけ指定します。`source-root` と `toolchain-version` は必須です。project script の一致を要求する場合は `require-trusted-project-scripts: true` と `trusted-project-root` を指定します。outputs は `status` と `result-path` です。生成した結果JSONは、品質実行の成功・失敗にかかわらず結果ファイルと同じ内容をActionログへ一度だけ出力します。入力拒否など結果を生成できない場合は診断のみを出力します。

標準IDは `rust-cargo-quality`、`python-uv-quality`、`typescript-npm-quality` です。生成元・revision・digestとdescriptorは `runtime/adapter/standard-quality-bundles.generated.ts` に保持し、生成方法は[Development](../../DEVELOPMENT.md)を参照してください。標準経路はconsumerへdescriptorを配置せず、実行中の外部取得も行いません。projectの依存宣言・lock・固有script・toolchain設定は維持します。新入力の正式固定版が公開されるまでcanonical workflowはpending-releaseです。

descriptor の `toolchain.verify` は `command` / `args` だけを宣言し、実行時出力の形式・パース規則はこの Action が所有します。Action は `command` を実行し、stdout と stderr を連結した出力を ASCII 空白で分割して、`toolchain-version` が独立トークン（`{version}` / `v{version}` / `V{version}` の完全一致）として現れることを検証します。exit≠0 またはトークン不一致の場合は `quality-adapter-toolchain-version-mismatch` と `expected=` / `received=` を stderr に出力します。旧 descriptor の `expectedOutput` は無視します。
