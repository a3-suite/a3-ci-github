# CI workflow 作成ポリシー

> この文書は GitHub Actions provider profile である。provider-neutral な workflow 責務は `ci` の CIプリセット契約で定義し、GitHub 固有の配置と静的検証を本スキルへ写像する。

## 理解できること
- workflow の命名、実装境界、静的検証
- workflow に残す処理と外部化する処理の境界

## 命名
- workflow file は `.github/workflows/` 配下の `lower-kebab-case.yml` とする。
- file名は`<workflow-stem>[-<trust-boundary>].yml`とする。用途別 preset の stem と trigger adapter の命名は、選択した実装スキルのカタログに従う。
- file stem と workflow `name:` を一致させる。
- branch category、trigger detail、package kind、実装言語を名前の主軸にしない。trust boundaryを表すevent detailだけはsuffixとしてよい。
- runner trust boundary を分ける場合だけ、`references/runner-trust-policy.reference.md` の境界名を suffix に使う。
- `manual`と`docs`はtrust boundaryではなくworkflow-stemの補助語とする。`trusted-pr`はtrust boundary名に使わない。
- job id は `needs`、ruleset、required check から安定参照できる短い機械名にする。
- job `name:` は単一 job なら workflow 名、複数 job なら `<workflow-name> / <job-role>` とする。
- platform 別の matrix job 名は `<workflow-name> / <platform-id>` とし、platform id は platform manifest の id を使う。
- platform 結果の集約 job 名は `<workflow-name> / summary` に固定し、required check は集約 job を参照する。
- required check から参照する名前は workflow rename と独立して安定させる。

用途別の workflow asset は `preset-catalog.reference.md` を正本とする。本policyでは provider 固有の workflow file 名を標準例として再定義しない。権限を持つ publish / deploy は通常 CI から分離する。

## 実装境界
- workflow は順序、条件、権限、入出力のオーケストレーションに限定する。
- inline 処理が空行を除いて10行を超える場合は、外部化の必須条件または不適合ではなく、意味レビューの起点とする。行数だけで外部化を決めない。
- 意味レビューでは、責務分離、再利用性、単体検証、秘密情報・副作用の隔離、project 間 drift の抑制による便益と、Action / script、公開 interface、固定 SHA、release、依存、信頼境界、更新経路が増える保守コストを比較する。
- 外部化による便益が保守コストを上回り、owner、入出力、停止条件が明確になる場合だけ外部化する。外部化を選択した場合、project 固有処理は `.ci/scripts/`、複数 project で再利用する処理は Action を選ぶ。
- 外部 Action や project-local code より前に実行する trust / identity gate、または一度だけ使う単純な provider glue は、inline の方が境界と実行順を明確に保てる場合は workflow に残してよい。
- 行数基準を満たすための圧縮、薄い wrapper、または複雑さを別資産へ移すだけの分割を行わない。
- Action は許可済み発行元に限定し、版指定は `references/workflow-version-policy.reference.md` に従う。
- 新規Action採用時は権限と保守状況を記録する。
- CI runtime の依存境界は `ci-runtime-boundary.reference.md` に従う。

## concurrency
- 通常 CI は pull request の run だけを `cancel-in-progress: true` で置換する。post-merge（保護 branch push）、merge group、定期実行は置換対象にしない。
- 置換しない通常 CI の run は group を run 単位に分離し、後続 run が先行 run を置換しないようにする。
- 通常 CI の group は workflow と PR 番号などの論理対象で構成し、commit SHA を含めない。
- publish / deploy は `cancel-in-progress: false` と `queue: max` を併用し、provider の queue 上限内では実行中・待機中の run を置換しない。上限超過で provider が待機 run をキャンセルした場合は、その run を未実施として扱い成功へ読み替えない。
- publish の group は workflow、repository、および対象を持つ場合は target identity を含め、commit SHA と run ID を含めない。
- `queue: max` と `cancel-in-progress: true` は併用しない。
- `queue` を提供しない provider 版では、待機 run を置換しない契約を満たせないため publish を開始しない。

## Release 公開の provider 適合
- GitHub の Release 作成・更新 API は、対象 commit（既存 tag では tag が指す commit）が default branch に対して `.github/workflows/` 配下を追加または変更する場合、認証 token に workflow 変更権限を要求する。権限がない場合の応答は 404、認証経路によっては 403 `Resource not accessible by integration` となる。
- Actions の `GITHUB_TOKEN` には workflow 変更権限を付与できない。`permissions` の追加では解消しないため、公開 source の選択または credential route の選択として扱う。
- 適合判定は provider の diff 比較条件の細部（比較方向、merge-base、rename の扱い、切り詰め）へ依存させず、公開対象 commit と判定時点の default branch で `.github/workflows/` 配下の entry（path と object identity）が一致することを確認する保守的判定とする。一致は provider が必要条件とする意味ではなく、この profile が採用する安全側の判定である。
- 適合判定は source identity の確定後（build 前）に一度行い、write 直前に default branch と権限状態を再観測する。build 中の変更を理由に早期結果を恒久証拠へ読み替えない。
- credential route が workflow 変更権限を宣言しているだけでは適合と扱わない。権限の実効性を確認できない場合は fail closed とし、強い credential への自動 fallback を行わない。
- 不適合または判定不能の場合は publish を停止し、tag、source SHA、default branch SHA、差分 entry を診断として owner へ返す。CI が tag や公開 source を自動で作り直さない。
- 公開の provider 操作（release 作成、asset upload、finalize、観測）が失敗した場合は、`release-asset-publication-contract.reference.yml` の `providerPublicationSuitability.failureAttribution` に従って GitHub API の操作単位で診断を残す。必須項目と秘匿対象は同 section を正本とし、この profile では再定義しない。

## 静的検証
- 実在する workflow を repository root の `actionlint` で検証する。
- 一部または非標準配置だけを検証する場合は、実在する workflow path を明示する。未一致 glob に依存しない。

```bash
actionlint
actionlint {project-root}/.github/workflows/ci.yml
```

- GitHub公式仕様と `actionlint` が不一致の場合だけ、version、公式根拠、完全一致で除外する診断を検証結果へ記録し、他の診断は失敗とする。
- 検証結果がない場合は検証済みと扱わない。reviewではreviewerが実行するか未確認範囲とし、auditでは必要に応じて実在pathを指定して実行する。
- `actionlint`が利用不能なら、未導入であることとprojectで承認された代替検証を報告する。
- actionlint の project 固有設定（診断抑止など）は `.github/actionlint.yaml` に置き、ci-github の静的検証フェーズが owner となる project-owned content とする。registry の `provider.staticValidation[].configPaths` に宣言し、preflight はその path を認識して未分類候補にしない（内容は検証しない）。設定は任意で、内容の正本化・固定はしない。
- actionlint 設定の診断抑止は tool version に依存して陳腐化し得るため、内容の保守は project の責務とし、ci-github は owner と配置だけを管理する。
- `actionlint` は構文、式、context参照の検証であり、trust、権限、trigger、publish安全性の保証には使わない。

## 関連
- `design-ci-workflow.guide.md`
- `review-ci-workflow.guide.md`
- `references/runner-trust-policy.reference.md`
- `references/workflow-version-policy.reference.md`
