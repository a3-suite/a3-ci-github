# インストーラ状態遷移契約

## 理解できること
- installer の標準状態と各状態で許可される操作
- operation mode ごとの状態遷移差分
- 失敗箇所ごとに残してよい handoff state、activation state、install state、service、data / secret の状態

## 目的
- installer の各段階で許可される入力、書き込み、副作用、失敗時残存状態を定義し、実装・レビュー・fixture の判断基準を揃える。

## 原則
- 前段の検証が完了するまで、後段の副作用を起こさない。
- handoff state、activation state、install state、service restart は commit phase の扱いとし、download / verify 失敗では変更しない。
- rollback は artifact と activation state の戻しを基本とし、data restore は別契約にする。
- rollback は失敗 phase と変更済み resource から導出した rollback plan として扱い、activation、service、process、shared asset、state、data restore を1つの処理に混ぜない。
- audit log は実行履歴、install state は現在状態として分ける。
- `external-orchestrated` の検証済み release 引き渡しは handoff state とし、現在状態の install state とは分ける。
- dry-run は同じ検証経路を通し、managed root、handoff state、activation state、service、install state の永続変更を抑止する。

## 状態一覧
| 状態 | 目的 | 許可される主な操作 | 失敗時に残してよい状態 |
| --- | --- | --- | --- |
| request-accepted | execution request を受け取り、manifest checksum、operation mode、source mode を固定する | request parse、manifest checksum 照合、source mode / local artifact path 検証 | 何も変更しない |
| preflight | runtime、権限、lock、managed root、service user を確認する | lock 取得、読み取り検査、runtime version 照合 | lock の解放記録だけ |
| fetch | 固定入力に基づき artifact や verified placement asset を取得または読み出す | 許可済み host / registry から VCS 対象外の一時領域へ download、または offline source mode の local artifact 読み取り | 一時ファイルまたは読み取り失敗記録だけ |
| verify | checksum、signature、schema、archive entry を検証する | manifest validation、checksum / signature 検証、archive listing | 検証失敗した一時ファイルだけ |
| stage | 検証済み資材を release staging へ展開する | staging directory 作成、permission 正規化、expected files 確認 | staging directory だけ |
| pre-commit | activation strategy に応じた commit 前の最終確認を行う | audit log required の `install.begin` 追記、service stop 判断 | staging directory と audit log 試行結果 |
| switch | activation strategy に応じて検証済み release を反映または引き渡す | active release pointer switch、in-place reflect、external handoff state 記録 | 前 activation state、handoff state、または rollback 対象を識別できる状態 |
| health | 起動確認を行う | health command / URL check、retry | failed release staging と rollback 記録 |
| record | activation strategy に応じて現在 install state と audit log result を記録する | `active-pointer` / `in-place` の install state 書き込み、audit log `install.result` 追記 | 成功した handoff state、activation state、install state、または audit log warning |
| cleanup | terminal result 前の共通後処理を行う | lock 解放、VCS 対象外の不要一時ファイル cleanup、失敗理由出力 | 契約で許可された一時状態だけ |
| complete | 成功状態を確定する | 結果返却 | 成功 state |
| failed | 非ゼロ失敗を返す | 結果返却 | cleanup 後に残してよい状態だけ |

## 遷移ルール
- `request-accepted` から `preflight` へ進む前に、manifest checksum、operation mode、source mode、offline source mode の local artifact path を固定する。
- `preflight` で runtime 不足、lock conflict、managed root 不正、権限不足を検出した場合は `cleanup` を通って `failed` へ進む。
- `fetch` は fixed URL、registry、package coordinate、version、または fixed local artifact path だけを使い、fallback 先へ暗黙に切り替えない。
- `verify` を通過するまで、placement target、handoff state、activation state、install state、service state を変更しない。
- `stage` は managed root 内の staging area に限定し、managed root 外の所有権や権限を変更しない。
- `pre-commit` で required audit log の `install.begin` 追記に失敗した場合は `cleanup` を通って `failed` へ進み、handoff state、activation state、install state を変更しない。
- installer が health を担当する strategy で `switch` 後に `health` が失敗した場合は、activation strategy の rollback 方針に従う。前 release があれば戻し、初回導入なら failed activation state を残さない。
- rollback が失敗した場合は activation state の状態不明または復元失敗を明示し、install state を成功扱いにせず operator 判断へ渡す。
- `switch` の handoff state 書き込み、または `record` の install state 書き込みに失敗した場合は成功扱いにしない。
- `record` の post-commit audit log `install.result` 追記に失敗した場合、verified install または verified handoff 自体を巻き戻さず audit log failure として報告する。
- `complete` または `failed` に入る前に `cleanup` を通し、lock を解放する。

## rollback plan
- rollback plan は、失敗時に「何を戻すか」だけでなく「何を戻さないか」と「戻せなかった場合に何を報告するか」を固定する。
- rollback plan は `switch`、`health`、`record` など commit phase の前に、変更する可能性がある resource と復元方法を対応付けておく。
- finalize / cleanup は rollback plan を順に実行するだけにし、実行時に新しい rollback 判断を増やさない。
- rollback plan に含める resource は、少なくとも activation state、service manager state、process state、verified placement asset、shared asset、install state / handoff state、audit result を分ける。
- data restore は標準 rollback plan に含めず、project SSOT または backup / restore 契約が明示した場合だけ別 plan として扱う。
- rollback plan の実行順は、試行 release の停止、activation state 復元、service manager 復元、必要な場合の前 release 起動、state / audit の失敗記録、temporary cleanup の順を基本にする。
- shared asset は artifact と同じ activation state ではない。前 release が共有資産を必要とする場合は、backup から戻す、検証済み資産を維持する、または operator 判断へ渡す条件を plan に明示する。
- install state / handoff state の書き込み失敗は成功扱いにせず、activation state を復元できる場合だけ rollback plan で戻す。復元できない場合は状態不明または復元失敗として報告する。

| resource | rollback plan の責務 | 標準でやらないこと |
| --- | --- | --- |
| activation state | active pointer、in-place target、handoff state の復元または未確定化を行う | data restore と同時に扱わない |
| service manager state | unit file、enable 状態、reload / restart の戻しを扱う | runtime script の PID / restart 意味を再定義しない |
| process state | 試行 release を止め、必要なら前 release を起動する | 起動成功を install state 成功の代替にしない |
| verified placement asset | 検証済み staging / release file の残存可否を決める | checksum 未検証資材を稼働対象へ戻さない |
| shared asset | backup から戻すか、検証済み資産を維持するか、operator 判断へ渡す | 前 release との互換性を未確認のまま成功扱いにしない |
| install state / handoff state | 成功 state を書かない、または復元失敗を報告する | audit log を現在状態の代替にしない |
| audit result | failure、rollback failed、audit warning を記録する | audit result 失敗だけを理由に verified install を巻き戻さない |
| data / secret | 変更しない。必要なら別契約の restore plan へ委譲する | installer 標準 rollback に DB restore や secret 再発行を含めない |

## activation strategy 別の switch
| activation strategy | switch phase の責務 | health / rollback の扱い |
| --- | --- | --- |
| active-pointer | active release pointer を新 release へ切り替える | health 失敗時は前 active release pointer へ戻す |
| in-place | 検証済み staging を in-place target path へ反映し、active release pointer switch は行わない | health 失敗時は反映前の target path 状態へ戻す。戻せない場合は rollback failed とする |
| external-orchestrated | installer は稼働対象を変更せず、外部切替用の verified release を handoff state に記録する | installer は service restart、health、rollback、現在 install state 更新を実行せず、外部 orchestration が稼働切替後に現在状態を確定する |

## operation mode 別の扱い
### install
- 既存 activation state がない前提で処理する。
- health 失敗時は failed activation state を残さない。

### upgrade
- 既存 activation state と previous release を記録する。
- health 失敗時は previous release へ戻す。

### repair
- 同一 manifest checksum / artifact checksum の再配置を許可してよい。
- 異なる checksum の同一 version は明示 option なしでは拒否する。
- `repair` は対象 release の再配置・再検証だけを許可し、activation strategy が許す副作用だけを実行する。
- `external-orchestrated` の `repair` は handoff artifact または handoff state の修復に限定し、現在 install state、activation state、service を更新しない。

### dry-run
- request parse、manifest validation、runtime check、managed root check、permission check、fetch、verify を通常実行と同じ基準で行ってよい。
- placement target、handoff state、activation state、service、install state を変更しない。
- audit log 追記は project policy で許可された場合だけ行い、記録しても dry-run result に限定する。

## operation mode 副作用可否
| operation mode | network read | temp write | managed root write | handoff write | activation write | service operation | install state write | audit log write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| install | 可 | 可 | strategy に従う | `external-orchestrated` のみ可 | `active-pointer` / `in-place` のみ可 | `active-pointer` / `in-place` のみ可 | `active-pointer` / `in-place` のみ可 | policy に従う |
| upgrade | 可 | 可 | strategy に従う | `external-orchestrated` のみ可 | `active-pointer` / `in-place` のみ可 | `active-pointer` / `in-place` のみ可 | `active-pointer` / `in-place` のみ可 | policy に従う |
| repair | 可 | 可 | strategy と repair 対象に従う | `external-orchestrated` の handoff 修復でのみ可 | `active-pointer` / `in-place` の現在 release 修復でのみ可 | `active-pointer` / `in-place` の現在 release 修復でのみ可 | `active-pointer` / `in-place` の現在 release 修復でのみ可 | policy に従う |
| dry-run | 可 | 可 | 不可 | 不可 | 不可 | 不可 | 不可 | project policy で許可された場合のみ |

- `repair` でも activation strategy 別の switch 境界を越えない。`external-orchestrated` の未反映 release を修復する場合は handoff state だけを対象にし、現在 install state の成功状態へ昇格させない。

## service operation 境界
- service manager は runtime script を呼ぶ薄い管理層として扱う。
- installer が runtime script を配置または生成する場合、その script は runtime-script スキルの起動責務と service manager handoff 境界に従う。
- service operation では環境変数、PID、ログ、restart の意味を runtime script と重複定義しない。
- service operation は state machine の switch / health に必要な最小操作へ限定する。

## 失敗時状態
| 失敗箇所 | handoff state | activation state | install state | service | data / secret | 備考 |
| --- | --- | --- | --- | --- | --- | --- |
| request parse | 変更しない | 変更しない | 変更しない | 変更しない | 変更しない | execution request を信用しない |
| runtime missing | 変更しない | 変更しない | 変更しない | 変更しない | 変更しない | 標準経路では runtime を導入しない |
| lock conflict | 変更しない | 変更しない | 変更しない | 変更しない | 変更しない | retry は運用判断 |
| fetch / local artifact read failed | 変更しない | 変更しない | 変更しない | 変更しない | 変更しない | 一時ファイルまたは読み取り失敗記録だけ cleanup 対象 |
| checksum / signature mismatch | 変更しない | 変更しない | 変更しない | 変更しない | 変更しない | force で無視しない |
| unsafe archive entry | 変更しない | 変更しない | 変更しない | 変更しない | 変更しない | managed root 外へ書かない |
| stage failed | 変更しない | 変更しない | 変更しない | 変更しない | 変更しない | staging cleanup 対象 |
| required audit log begin failed | 変更しない | 変更しない | 変更しない | 変更しない | 変更しない | required policy のみ |
| switch failed | 変更しないまたは復元 | 前 activation state を維持または復元 | 変更しない | 起動状態を明示 | 変更しない | state を成功扱いにしない |
| health failed | 変更しない | 前 activation state へ戻す | 成功扱いにしない | 前 release 起動または停止を明示 | data restore しない | 初回導入は failed activation state を残さない |
| rollback failed | 変更しない | 状態不明または復元失敗を明示 | 成功扱いにしない | 状態を報告 | data restore しない | operator 判断へ渡す |
| install state / handoff state write failed | 成功扱いにしない | 成功扱いにしない | 変更しない | 状態を報告 | 変更しない | operator 判断へ渡す |
| post-commit audit result failed | verified handoff では成功状態を維持 | verified install では成功 activation state を維持し、verified handoff では変更しない | verified install では成功 state を維持し、verified handoff では変更しない | verified install では成功状態を維持し、verified handoff では変更しない | 変更しない | `install.result` の audit log failure を報告 |

## レビュー観点
- 検証前に handoff state、activation state、install state、service state を変更していない。
- rollback が data restore を暗黙に含んでいない。
- rollback plan が変更済み resource、復元順序、戻さない resource、rollback failed の報告条件を明示している。
- dry-run が検証を省略する表示専用 mode になっていない。
- no-op / unchanged 判定が launcher の欠落・不一致を成功扱いにしていない。
- audit log required と best-effort の失敗扱いが分かれている。
- install state、handoff state、audit log に token、secret、auth header、env value が残らない。
