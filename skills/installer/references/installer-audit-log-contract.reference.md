# インストーラ audit log 契約

## 理解できること
- audit log と install state の責務分離
- execution request 由来の実行主体、実行時刻、理由の記録境界
- audit log に保存してよい値と保存してはならない値

## 補足
- audit log は実行記録であり、現在状態や外部切替 handoff の正本ではない。
- install state は現在の install 状態を表し、audit log は実行の履歴を追記する。
- audit log を扱う場合、manifest は audit log path と audit log policy を持ち、実行主体、実行時刻、理由は execution request から受け取る。
- audit log を使わない project では、install state だけで現在状態を記録してよい。`external-orchestrated` では handoff state を外部切替待ち release の記録先にする。
- audit event type、payload、begin/result の一致条件、offline local artifact reference の正本は `installer-audit-event-contract.reference.yml` とする。

## 標準境界
- audit log は追記型を基本にする。
- requested by、requested at、reason を記録する場合は execution request の値を使う。
- token、secret、auth header、env value は記録しない。
- dry-run を audit log に記録するかは project policy で決める。記録する場合も、managed root、handoff state、activation state、service、install state を変更しない。
- audit log policy は `required` または `best-effort` として明示する。
- `best-effort` の場合、audit log 書き込み失敗は warning とし、install 成否は verified placement asset、strategy に応じた activation state / health check / install state、または handoff state の結果で判定する。

## 禁止項目
- token、secret、auth header、env value を記録しない。
- audit log を install state や handoff state の代わりにして active release または外部切替待ち release を判定しない。
- audit log の記録失敗を理由に、検証失敗した artifact や SBOM を配置しない。
- `best-effort` の audit log 失敗を、verified placement asset の検証成功として扱わない。

## 受け入れ条件
- audit log に secret が含まれる場合、fixture は失敗する。
- audit log が存在しなくても、install state から現在の release version、artifact checksum、manifest checksum を判定できる。
- `external-orchestrated` では audit log が存在しなくても、handoff state から外部切替待ち release version、artifact checksum、manifest checksum を判定できる。
- dry-run の audit log は project policy で任意とする。記録する場合でも、install state、handoff state、activation state、service、managed root は変更されない。
- `best-effort` audit log に追記できない場合、installer は warning を返し、install 成否を audit log 以外の検証結果で判定する。
