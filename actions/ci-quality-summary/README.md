# ci-quality-summary

`ci-quality-summary` は quality result の JSON を GitHub Actions の step summary へ追記し、集約 status と証跡 digest を返します。workflow の job、権限、runner、language adapter、publish 処理は所有しません。

## 入力

| input | 必須 | 内容 |
| --- | --- | --- |
| `summary-json` | yes | `jobs` または `tests` のいずれかが空でない quality result JSON |
| `summary-path` | no | 出力先。空値は `GITHUB_STEP_SUMMARY` |
| `evidence-path` | no | 今回の描画 bytes を保存する証跡ファイル。既定値は `.ci/ci-quality-summary.evidence.md` |

各 row は `unit`、`execution`、`evidence` に加え、正規化済みの `result`／`collection`、またはGitHub jobの `rawResult`／boolean `applicable` のどちらか一方を持ちます。正規化済み `result` は `success`、`failed`、`blocked`、`判定不能`、`未実施`、`対象外` のいずれかで、`success` 以外は `reason` が必要です。raw resultは `success`、`failure`、`cancelled`、`skipped` をAction内で正規化し、未知値は`判定不能`として保持します。`applicable: false` はcallerが明示した対象外だけに使用し、理由を`reason`へ指定します。実行すべきrowが実行されなかった場合は`未実施`として扱います。

## 出力

| output | 内容 |
| --- | --- |
| `status` | `success`、`failed`、`blocked`、`unresolved` の集約結果 |
| `digest` | 描画した summary の `sha256:<64桁hex>` |
| `evidence-path` | summary を追記したファイルの path |

status は `failed`、`判定不能`、収集状態が `完了` でない row、`blocked` / `未実施`、`success` の順で集約します。`対象外` の row はこの評価から除外します。全 row が `対象外` の場合は不正入力です。`failed`、`blocked`、`unresolved` は Action を失敗終了させます。不正入力、出力先未指定、summary または evidence の書き込み失敗も失敗終了です。`summary-path` と `evidence-path` は同じ実体を指定できません。`digest` は `evidence-path` の内容に対する digest です。

## 使用例

```yaml
- name: Write quality summary
  id: quality-summary
  uses: a3-suite/a3-ci-github/actions/ci-quality-summary@<40-char-commit-sha>
  with:
    summary-json: ${{ steps.results.outputs.quality-results }}
```

Action の実行時に `skills/` や `ci-github` スキルのファイルを要求しません。公開 API は同梱の `action.yml` を正本とします。
`summary-json` と evidence には secret を含めないでください。

## 検証

```sh
npm test
npm run lint
npm run build
```
