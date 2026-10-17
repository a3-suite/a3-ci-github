# ci-release-authority

標準Rust Releaseのowner公開要求を受領し、共通検証を実行するread-only Actionです。公開APIは [action.yml](action.yml)、意味契約は [ci-script-contracts](../../skills/ci-github/references/ci-script-contracts.reference.yml) の `release-authority-scripts` を参照してください。

既存の公開要求にownerが指定したversion・公開対象を記録します。要求run、annotated tagと固定source、notes承認と期限、snapshot、対象repositoryのidentityを検証し、後続assembly・publisher・独立verifier向けのauthorityを生成します。タグからversionを補完せず、sourceやownerコードを実行しません。

owner契約の固定対象は既存の公開要求受領workflowです。trusted checkoutのファイルと公開要求runのrevisionにある同じファイルをbyte単位で照合し、digestをauthorityへ記録します。branch/version方針のdigestや、その方針を承認した証拠ではありません。notes承認と公開要求のdispatch authorizationも区別します。

`contents: read`と`actions: read`のjobでtokenを`github-token`へ注入します。API操作はGETだけです。credentialの選択、公開可否の判断、provider writeを担当しません。build前は対象repositoryのidentityを確認します。公開credentialの権限やproviderの受理可否は予測せず、publisherの実際の操作結果で判定します。

canonical producerはv2入力を必須とします。既存Actionのv1 APIと既存v1 artifactのowner例外経路は維持しますが、旧canonical producerのpreflight互換は維持しません。標準authorityはv1を拒否します。Cargo versionとの一致はownerが採用する追加検証であり、本Actionは実行しません。公開状態と固定参照は[preset registry](../../skills/ci-github/assets/registry/ci-github-preset-assets.yml)を正本とします。consumerの移行とHosted受入は導入先で確認します。
