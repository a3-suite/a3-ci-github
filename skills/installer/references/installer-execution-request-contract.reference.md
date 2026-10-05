# インストーラ execution request 契約

## 理解できること
- installer を1回実行するときに指定する実行入力の責務
- manifest contract と execution request contract の分離境界
- operation mode、source mode、dry-run、manifest checksum、instance id の扱い

## 補足
- execution request は実行単位の入力であり、release manifest の内容を置き換えない。
- release version、artifact URL、artifact checksum、runtime requirement は manifest contract を正本とする。
- execution request は検証済み manifest の場所と checksum、実行 mode、対象 instance などを束ねる。
- execution request の checksum を記録する場合も、manifest checksum と artifact checksum は別に保持する。
- source mode ごとの manifest source、artifact source、network 可否、fallback 禁止の正本は `installer-source-mode-contract.reference.yml` とする。

## 標準境界
- `install`、`upgrade`、`repair`、`dry-run` は明示 mode とする。
- 固定済み manifest URL と checksum を埋め込んだ単体スクリプトでは、組立時に固定した `install` / `online` を引数なし実行の execution request として扱ってよい。引数で別 mode を指定した場合はその指定を優先し、選択結果を実行前に確定する。
- 既存状態から mode を推測する場合でも、実行前に選択された mode を audit log へ残す。
- dry-run は通常実行と同じ manifest 検証、runtime 検証、archive 検証を通し、managed root、handoff state、activation state、service、install state を変更しない。
- dry-run の一時領域への fetch / verify と audit log 追記可否は、インストーラ状態遷移契約の副作用可否に従う。
- source mode は operation mode と分ける。許可値、manifest / artifact の取得元、network と fallback、local artifact path の条件は source mode 契約に従う。
- execution request は manifest の artifact URL、artifact checksum、runtime requirement、placement を上書きしない。
- manifest checksum が request と一致しない場合、installer は配置、handoff state 記録、activation state 変更、service restart を行わない。
- operator や reason を記録する場合も、token、secret、auth header、env value は保存しない。
- dry-run flag を省略した場合は operation mode を正本として扱う。
- 固定 HTTPS URL から pipe 実行する共有 wrapper では、非既定の operation mode / source mode を環境変数（`INSTALLER_MODE`、`INSTALLER_SOURCE`、`INSTALLER_MANIFEST`、`INSTALLER_ARTIFACT`）で選択してよい。選択結果は実行前に確定する。
- operation mode と dry-run flag が矛盾する場合は、execution request validation で失敗する。

## 必須項目
| 区分 | 項目 | 意味 |
| --- | --- | --- |
| manifest | manifest path or URL | 実行対象の manifest |
| manifest | manifest checksum | 実行対象 manifest の checksum |
| execution | operation mode | `install` / `upgrade` / `repair` / `dry-run` などの明示 mode |
| execution | source mode | 取得方法の選択。許可値と条件は source mode 契約に従う |

## 任意項目
| 区分 | 項目 | 意味 |
| --- | --- | --- |
| execution | dry-run flag | 互換目的で mode と別に書き込み抑止を持つ場合の明示 flag |
| execution | local artifact path | source mode 契約で許可された場合の local artifact |
| execution | instance id | 複数 instance を扱う場合の対象識別子 |
| audit | requested by | 実行主体。secret や token は含めない |
| audit | requested at | 実行要求の作成時刻 |
| audit | reason | 実行理由。secret や token は含めない |

## 禁止項目
- artifact URL、artifact checksum、runtime requirement、managed root を execution request で上書きしない。
- checksum mismatch を `force` 系 option で無視しない。
- TLS 検証無効化、未許可 download URL、fallback registry を execution request で許可しない。
- token、secret、auth header、env value を execution request に含めない。
- operation mode と dry-run flag の矛盾を許容しない。

## 受け入れ条件
- 引数または組立時に固定した既定値から operation mode を確定できない場合、installer は実行を開始しない。
- 引数または組立時に固定した既定値から source mode を確定できない場合、または source mode 契約に違反する場合、installer は実行を開始しない。
- manifest checksum が一致しない場合、installer は取得済み artifact、handoff state、activation state を変更しない。
- dry-run では install state、handoff state、activation state、service、managed root を変更しない。
- dry-run flag が省略された場合、installer は operation mode だけで dry-run かを判定する。
- `operationMode` が `dry-run` 以外で dry-run flag が true の場合、または `operationMode` が `dry-run` で dry-run flag が false の場合、installer は失敗する。
- execution request が manifest の配布物情報を上書きしようとした場合、installer は失敗する。
