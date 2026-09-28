# ci-release-publication-control

`ci-release-publication-control` は release publication request の生成、workflow handoff との結合、provenance、公開直前の approval を検証します。artifact の取得、GitHub API、job 権限、credential、publish は workflow が所有します。

`operation` は `create-request`、`verify-publication-request`、`verify-provenance`、`verify-approval` のいずれかです。各 operation に必要な値だけを inputs で渡します。全 operation が `status` を、`verify-publication-request` は加えて `request-run-id` を出力します。
