# ci-platform-matrix

`ci-platform-matrix`は、信頼済みcheckout内のplatform manifestを検証し、GitHub Actionsの
strategyへ渡せる`{"include":[...]}`形式のJSONを返します。workflowのjob、runner選択、
permissions、matrix適用は所有しません。

## 入出力

`manifest-path`へplatform manifestを指定します。品質platformを選ぶ場合は任意の`selection-path`を指定します。`matrix`は全manifestのまま維持し、品質jobは`quality-matrix`、summaryは`expected-platforms`を使用します。入力制約と各outputの生成条件は
[`action.yml`](action.yml)を正本とします。

`sharedStandardChecks`の宣言はmatrixへ投影するだけで、検査の省略を許可するtrust判断はcallerが所有します。標準platform workflowは信頼済みbaseの宣言だけを使用し、head/bootstrapの宣言では全検査を維持します。OS間の実効設定・対象が同等であることの確認は利用projectの責務です。

`runner-policy`はcallerが確認した設定の信頼状態から選びます。初回導入や信頼未確認の呼び出しは既定値のままにし、base/controlの設定を検証した固定callerだけが`trusted`を指定します。PR headのmanifestでこの判断を変更しません。consumerは採用するHosted labelの提供状況とarchitectureを確認し、実行不能やplatform欠落を成功に読み替えません。

```yaml
- uses: a3-suite/a3-ci-github/actions/ci-platform-matrix@<40-char-commit-sha>
  id: platform-matrix
  with:
    manifest-path: .ci/release/platforms.yml
```
