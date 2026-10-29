# CI 結果解析ガイド

## 目的
- GitHub Actions の CI 結果を workflow 外で解析するときに、`ci` スキルの CI 結果解析ガイドへ加える GitHub 固有の差分を定める。

## フロー
1. `ci` スキルの CI 結果解析ガイドの手順で解析する。
   - runtime 境界は `references/ci-runtime-boundary.reference.md` に従い、workflow と `.ci/scripts/**` から `a3-lint` / `a3-suite` / その他 `a3-*` コマンドを呼ばない。
2. 失敗の分類に次を加える。
   - trusted CI assets の解決失敗は、base の lock・資産状態（初期導入・不整合・fail closed）で分類する。bootstrap の詳細は [trusted CI assets bootstrap](references/runner-trust-policy.reference.md#trusted-ci-assets-bootstrap) に従う。
