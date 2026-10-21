# ci-quality-adapter

`ci-quality-adapter` は固定版に同梱した標準bundle、またはtrustedな独自descriptorのread-only品質コマンドをfixed source checkoutで実行し、構造化結果を出力します。workflowのcheckout、権限、credential、bundleの選択は所有しません。

`standard-bundle-id` と `bundle-path` はどちらか一つだけ指定します。`source-root` と `toolchain-version` は必須です。project script の一致を要求する場合は `require-trusted-project-scripts: true` と `trusted-project-root` を指定します。outputs は `status` と `result-path` です。生成した結果JSONは、品質実行の成功・失敗にかかわらず結果ファイルと同じ内容をActionログへ一度だけ出力します。入力拒否など結果を生成できない場合は診断のみを出力します。

実行した各コマンドのphase、マスク済みID、経過ミリ秒、終了状態、終了コードを `ci-quality-command-timing:` に続くJSONとしてstderrへ出力します。実行順と結果JSONの形式は維持し、引数・パス・子プロセスの出力は時間ログへ含めません。

`execution-scope`は既定`all`で全検査を実行します。`native`は固定標準Rustだけに対応し、format/security/dependency-policyを除き、toolchain検証・依存準備・clippy/test/metadataを維持します。独自descriptor・他言語・未知scopeはコマンド実行前に拒否します。結果JSONは実行したコマンドだけを含み、nativeの成功だけでは全品質成功になりません。callerは同一source/lock/toolchainで共通検査の成功と全nativeの成功を集約します。標準platform workflowのopt-in条件は[platform導入ガイド](../../skills/ci-github/references/configure-ci-preset.guide.md)を参照してください。

標準IDは `rust-cargo-quality`、`python-uv-quality`、`typescript-npm-quality` です。正本path・digestとdescriptorは `runtime/adapter/standard-quality-bundles.generated.ts` に保持し、生成方法は[Development](../../DEVELOPMENT.md)を参照してください。標準経路はconsumerへdescriptorを配置せず、実行中の外部取得も行いません。標準bundle IDを持つローカルdescriptorは拒否します。標準Rustの`dependency-policy`（cargo-deny）は任意で、`CI_CARGO_DENY_VERSION`と`CI_CARGO_DENY_CONFIG_PATH`を両方指定した場合だけ実行します。両方空なら結果に`not-run`（reason `not-configured`）を記録し、全体statusは変えません。一方だけの指定や存在しない設定fileはコマンド実行前に停止します。失敗時は、cargo-denyのJSON出力から検査ごとのerror・warning件数と、errorの診断コード・crate名と版だけを結果の`diagnostics`に残します。messageなどの本文は他のcommandの出力と同じく公開しません。projectの依存宣言・lock・固有script・toolchain設定は維持します。公開状態と固定参照は[preset registry](../../skills/ci-github/assets/registry/ci-github-preset-assets.yml)を正本とします。

標準Python bundleは初期同期成功後のformat/lintで準備済み環境を再利用し、test/securityの同期は維持します。構文検査はuvが選んだPython環境で実行し、確認できた仮想環境のディレクトリだけを走査から外します。製品・テストの配置は限定せず、仮想環境を確認できない場合は全体を検査します。

descriptor の `toolchain.verify` は `command` / `args` だけを宣言し、実行時出力の形式・パース規則はこの Action が所有します。Action は `command` を実行し、stdout と stderr を連結した出力を ASCII 空白で分割して、`toolchain-version` が独立トークン（`{version}` / `v{version}` / `V{version}` の完全一致）として現れることを検証します。exit≠0 またはトークン不一致の場合は `quality-adapter-toolchain-version-mismatch` と `expected=` / `received=` を stderr に出力します。旧 descriptor の `expectedOutput` は無視します。
