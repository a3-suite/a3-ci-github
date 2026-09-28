# CI GitHub scripts

GitHub 向け CI で再利用する定型処理を管理します。

## verify-github-toolchain.sh

指定した mode に必要な CLI が存在し、期待バージョンと一致することを検証します。

```sh
CI_GH_VERSION=2.80.0 \
CI_JQ_VERSION=1.7 \
CI_SHA256SUM_VERSION=9.5 \
runtime/github-toolchain/verify-github-toolchain.sh gh-jq-sha256
```

mode は `jq`、`gh-jq`、`jq-sha256`、`gh-jq-sha256` のいずれかです。選択した mode で使う
`CI_GH_VERSION`、`CI_JQ_VERSION`、`CI_SHA256SUM_VERSION` は完全一致するバージョンを指定します。
