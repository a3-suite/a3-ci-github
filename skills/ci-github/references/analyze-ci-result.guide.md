# CI 結果解析ガイド

## 目的
- CI 結果の解析を workflow 外で行うときの境界、入力、手順、報告観点を固定する。
- CI workflow runtime に解析補助コマンドや a3 系 CLI を混入させず、解析だけを分離して実施する。

## フロー
1. runtime 境界を確認する。
   - `references/ci-runtime-boundary.reference.md` に従い、CI workflow runtime には解析手順を組み込まない。
   - provider の workflow runtime と `.ci/scripts/**` から `a3-lint` / `a3-suite` / その他 `a3-*` コマンドを呼ばない。
2. 解析入力を確定する。
   - provider adapter から取得できる情報は artifact の参照情報までとする。
   - artifact content は workflow 外で取得済みの入力として扱う。
   - provider connector 経由の artifact 取得は workflow 外の実行アダプターへ委譲する。
3. artifact を展開する。
   - 取得済み artifact zip を workflow 外の作業領域で解凍する。
   - temp-management スキルに従う VCS 対象外の一時領域を使い、追跡対象ファイルと混在させない。プロジェクト内に置く場合は `.gitignore` で除外する。
4. 解析方法を選ぶ。
   - a3-suite が対象形式を扱える場合は a3-suite スキルの手順を参照する。
   - a3-suite の対象外なら、対象言語または対象テストランナーの標準出力を直接確認する。
5. 解析結果を整理する。
   - 失敗箇所、再現条件、影響範囲、推奨対応を分けて報告する。
   - CI workflow runtime に戻すべき修正と、workflow 外解析だけで完結する調査を分ける。
   - trusted CI assets の解決失敗は、base の lock/資産状態（初期導入・不整合・fail closed）で分類する。
   - local と CI の差分が 9 時間ずれる、または日付境界でだけ失敗する場合は、timezone 依存テストの失敗として分類する。

## 注意
- CI 解析のために workflow へ a3 系 CLI を追加しない。
- artifact の保持期限や公開範囲に注意し、必要な範囲だけを取得する。
- trusted CI assets bootstrap の policy 詳細は、選択した provider の trust policy profile に従う。
- timezone 依存テストの修正方針は test スキルの原則に戻し、CI 側の `TZ` 固定だけを根本対応にしない。
