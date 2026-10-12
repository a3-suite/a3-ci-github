# ci-release-publisher

標準GitHub Releaseのcreate・asset upload・finalizeを提供する。

公開APIは[action.yml](action.yml)、証跡shapeは[共通schema](../../runtime/release-publication/evidence.schema.json)、公開保証は[公開契約](../../skills/ci-github/references/release-asset-publication-contract.reference.yml)を参照する。

workflowがcredentialを注入する。標準bindingは`github.token`専用であり、credentialの選択・fallbackを行わない。draft閲覧能力の証拠は[verifier固有契約](../../sdd/dsl/specs/contract-core/subjects/ci-release-publication-verifier/clauses.sdd.yml)に従う。default branchに対するworkflow treeの一致をremoteから再観測し、観測不能・truncated tree・workflow変更は停止する。ownerの公開判断・承認・version policyは移管しない。

write前にauthority directoryの承認済みnotes・approval・publication requestとhandoff・pre-observationを照合し、最後のremote観測後にhandoffを再検証する。既存Releaseはdraftも含めて拒否し、create結果のimmutable IDにupload・finalizeを固定する。asset一覧の反映待ちはGETだけを上限内で再観測し、writeを繰り返さない。結果不明や部分失敗では停止し、再create・上書き・削除・自動recoveryを行わない。失敗後の部分Releaseはownerが診断する。

`receipt-path`／`readback-path`は後続のread-only `ci-release-publication-verifier`に渡す。jobの成功出力は独立verifierから取得する。公開状態と承認済み固定参照は[preset registry](../../skills/ci-github/references/ci-github-preset-assets.reference.yml)を正本とする。
