# ci-release-publication-control

`ci-release-publication-control` は release publication request の生成、workflow handoff との結合、provenance、公開直前の approval を検証します。artifact の取得、GitHub API、job 権限、credential、publish は workflow が所有します。

`operation` は `create-request`、`verify-publication-request`、`verify-provenance`、`verify-approval` のいずれかです。各 operation に必要な値だけを inputs で渡します。全 operation が `status` を、`verify-publication-request` は加えて `request-run-id` を出力します。

## Explicit Release decision

`release-version` and `target-identity` together create `ci.release-publication-request.v2`. The version is owner-selected and must match the stable tag. The verified default-branch dispatch authorizes these publication inputs; separate notes approval remains scoped to the exact body. An absent pair retains v1 for owner exception consumers. Standard `ci-release-authority` requires v2. Input/output details are defined in [action.yml](action.yml).

`create-request` はownerが明示した `release-version` と `target-identity` を必須とし、`ci.release-publication-request.v2` だけを生成します。検証操作はrequest内の値を検証し、この2入力の再指定を要求しません。旧版・未知schema・不完全なowner decisionは拒否します。
