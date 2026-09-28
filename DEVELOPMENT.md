# Development

## 読む順序

1. `README.md`
2. `sdd/dsl/requirements/requirement-manifest.sdd.yml`
3. `sdd/dsl/designs/scopes/repository/logical-structure.sdd.yml`
4. `sdd/dsl/designs/global/physical-structure.sdd.yml`
5. `docs/maintenance/test-strategy.md`
6. 対象の公開契約と実装

## SSOT

- repository Release version: `VERSION`
- 要求・観測可能な契約・設計境界: `sdd/`
- Action の公開 I/O: `actions/<action-name>/action.yml`
- canonical workflow source: `workflows/`
- 配置・検証処理: `runtime/`
- Agent Skill の起動条件と操作導線: `skills/ci-github/`
- このリポジトリ自身のCI: `.github/workflows/`

スキル文書へ workflow、Action、runtime の実装を複製しません。`workflows/` と `.github/workflows/` を相互の代替として扱いません。

## Action catalog

```sh
node runtime/repository/update-action-index.mjs --write
node runtime/repository/update-action-index.mjs --check
```

## 基本検証

```sh
node --test tests/action-index-gate.test.mjs
node --test tests/action-dist-gate.test.mjs
node --test runtime/github-toolchain/tests/verify-github-toolchain.test.mjs
node --test runtime/rust-release/tests/rust-release-scripts.test.mjs
node runtime/contract-subject-coverage.mjs --check
```

各 JavaScript / TypeScript Action の依存復元、test、lint、dist 同一性は対象 Action の `package.json` と `runtime/repository/check-action-dist.mjs` に従います。統合、ローカルE2E、Hosted E2Eの境界と追加コマンドは[テスト戦略](docs/maintenance/test-strategy.md)を参照してください。

## 移行の制約

canonical workflow と Action registry の Action binding は、source cutover により本リポジトリの固定 SHA を参照します。旧リポジトリの公開資産は既存 consumer 向けに維持し、同じ契約を本リポジトリと旧リポジトリで独立更新しません。残る切替状態は `docs/maintenance/migration-baseline.md` を参照してください。
