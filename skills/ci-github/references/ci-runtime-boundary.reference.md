# CI runtime 境界

## 理解できること
- CI workflow runtime と workflow 外解析の境界
- a3 系 CLI の扱い
- CI に組み込む検証の置き換え方
- project が管理する CI 資材の配置先

## 本文
### 目的
- CI workflow runtime の実行時依存を増やさず、再現性と保守性を維持する。
- ローカル保守・解析・回帰確認の補助コマンドを CI runtime に混入させない。

### CI workflow runtime
- CI workflow runtime は、Agent Skills がインストール済み、選択可能、または参照可能であることを前提にしない。
- provider の workflow runtime と project-local CI script から `a3-lint` / `a3-suite` / その他 `a3-*` コマンドを直接実行しない。
- a3 系 CLI は CI の実行時依存にしない。
- a3 系 CLI が必要に見える検証は、標準 Action / reusable workflow を優先し、対象言語の標準ツールで成立するか確認する。project-local script は標準では成立しない project 固有の差分に限定する。
- 共通資材を導入先へ不要にコピー・Git管理させない。CI 内で固定版・完全性を確認して取得する資材は、Git管理する project 固有sourceと区別する。CI workflow runtime からスキル保管場所を参照しない。

### workflow 外解析
- CI 結果の解析は workflow provider 外で実施できる。
- provider adapter は artifact の参照情報を外部解析へ渡し、artifact content の取得方法を共通 CI 契約へ持ち込まない。
- artifact content は workflow 外で取得済みの入力として扱う。
- workflow 外でアーティファクトを解析する場合は、a3-suite スキルを参照してよい。
- workflow 外解析の手順を CI workflow runtime には組み込まない。

### project が管理する CI 資材の配置
- project が管理する CI 専用資材は `.ci/` 配下へ置く。新しく追加する資材も、用途と所有者から同じ基準で判定する。
- `.ci/` 配下の個別の配置先（platform 定義、lock、Action 固定参照、独自 adapter、CI 専用 script、同梱スキル宣言など）は、各資材の正本に従う。
- 次の資材は `.ci/` へ移さない。標準と異なる配置を選ぶ場合は、理由と owner を project SSOT に残す。
  - provider やツールが固定の位置を要求する資材（`.github/workflows/`、言語ツールが既定で探索する設定など）
  - CI 以外でも使う資材（スキル本体、製品が実行時に読む設定など）
  - 実行時に取得・生成する一時資材（runner の一時領域に置く）

### ローカル保守・回帰確認
- ローカル保守、スキル検証、回帰確認では a3 系 CLI を使用してよい。
- ローカルでの使用可否は、対象スキルまたは対象リポジトリの検証手順に従う。

### 関連
- `references/analyze-ci-result.guide.md`
- `references/ci-script-catalog.reference.md`
