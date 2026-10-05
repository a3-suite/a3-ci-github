# ci-platform-matrix

`ci-platform-matrix`は、信頼済みcheckout内のplatform manifestを検証し、GitHub Actionsの
strategyへ渡せる`{"include":[...]}`形式のJSONを返します。workflowのjob、runner選択、
permissions、matrix適用は所有しません。

## 入出力

`manifest-path`へplatform manifestを指定します。品質platformを選ぶ場合は任意の`selection-path`を指定します。`matrix`は全manifestのまま維持し、品質jobは`quality-matrix`、summaryは`expected-platforms`を使用します。入力制約と各outputの生成条件は
[`action.yml`](action.yml)を正本とします。

```yaml
- uses: a3-suite/a3-ci-github/actions/ci-platform-matrix@<40-char-commit-sha>
  id: platform-matrix
  with:
    manifest-path: .ci/release/platforms.yml
```
