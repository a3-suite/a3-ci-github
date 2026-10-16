# インストーラ fixture baseline

## 理解できること
- installer 実装で最低限用意する fixture の種類
- fixture ごとに確認する入力、期待結果、残存状態
- Java / Maven 系と Node / npm 系で追加する fixture overlay

## 目的
- installer の実装方式、対象 runtime、service manager が違っても、最低限同じ失敗条件と状態保護を確認できる fixture baseline を定義する。

## coverage matrix の扱い
- fixture ID、expected outcome、coverage role、primary invariant は、インストーラ fixture catalog を正本とする。
- 契約 invariant と confirming / violation fixture の対応は、インストーラ契約 coverage matrix を正本とする。
- 本リファレンスは fixture の入力、期待結果、残存状態を定義する。

## 原則
- fixture は production path、実 service、実 secret に依存しない。
- 各 fixture は入力、事前状態、期待結果、残存状態を明示する。
- 成功系より先に、安全性を壊す失敗系を固定する。
- Java / Maven、Node / npm の差分は共通 fixture へ overlay する。
- fixture は installer の内部実装ではなく、外部から観測できる契約を確認する。

## 共通 fixture baseline
### success install
- 入力: 固定 version、manifest checksum、artifact checksum、required runtime、managed root。
- 期待: placement target、install state、activation strategy に応じた activation state が一貫する。
- 残存状態: 既存 user config、secret、data directory が上書きされない。

### success external handoff
- 入力: `external-orchestrated` activation strategy、handoff state path、固定 version、manifest checksum、artifact checksum。
- 期待: 検証済み release が handoff state に記録され、現在 install state と稼働対象は更新されない。
- 残存状態: service restart、health check、activation state 変更を installer が実行しない。

### success result with audit log
- 入力: audit log policy を有効にした通常 install / upgrade。
- 期待: install state または handoff state と audit log が同じ manifest checksum、artifact checksum、release version を指し、audit log の `install.begin` / `install.result` は同じ operation mode と source mode を指す。
- 残存状態: audit log が存在しなくても install state から現在状態を、または handoff state から外部切替待ち release を判定できる。

### bounded project override
- 入力: 標準経路では満たせない必須制約があり、インストーラ契約 coverage matrix の project override classification に必要な証跡を持ち、core safety invariant を壊さない installer。
- 根拠検証: 必須制約の必要性と、製品固有値や許可 adapter の適合でも標準経路では満たせないことを証跡から確認する。
- 期待: 標準経路との差分を bounded override として分類し、reporting disposition に従って audit note または必要時の minor finding として扱い、即 blocker にしない。
- 残存状態: core safety invariant を満たす証跡が残る。

### common installer conformance
- 入力: 共通契約と選択した starter の構成・共通動作を維持し、製品固有値と許可 adapter だけを適合させた installer。非準拠差分はなく、例外用の requiredEvidence は持たない。
- 期待: 比較元と対象状態を特定して準拠を確認し、accepted project detail として finding なしとする。非準拠差分がないため project-specific exception に分類せず、例外の正当化証跡を要求しない。
- 残存状態: 対象成果物は変更されず、共通動作と製品固有適合の検証証跡が残る。

### avoidable project override reject
- 入力: 製品固有値や許可 adapter の適合で共通 installer に準拠できるが、既存の独自方式を維持した installer。project SSOT に例外が記載され、他の requiredEvidence が揃っていても、標準では充足不能な必須制約はない。
- 期待: 準拠可能性を先に確認し、例外の必要性が不成立として project-specific exception / major に分類する。共通 installer へ準拠する具体的な更新案と検証方法を提示する。
- 残存状態: 監査中は対象成果物を変更しない。

### project override justification gap
- 入力: 非準拠の理由を「既存実装がある」「project SSOT に書かれている」とだけ説明する installer。必須制約の必要性または標準経路では満たせない根拠が不足、あるいは証跡との照合で不成立である。
- 期待: 例外を許容せず project-specific exception / major とし、不足・不成立の根拠と準拠へ向けた次の確認・対応を示す。core safety invariant 違反が到達可能なら blocker とする。
- 残存状態: 監査中は対象成果物を変更しない。

## asset assembly evidence fixture
### assembled asset evidence recorded
- 入力: installer 外で組み立てた公開候補 asset、asset checksum、manifest checksum、payload 分離時の payload checksum、source commit / tag、CI run id または assembly id、builder identity、組立後 smoke または fixture subset の結果。
- 期待: インストーラ asset 組立証跡契約に従い、asset、manifest、payload、provenance、検証結果が同じ証跡 record で対応付く。
- 残存状態: workflow trigger、job、permissions、cache、release publish 手順を installer fixture の期待結果に含めない。
- 入力（改行差）: 同一論理の installer source と manifest を、改行コードを変えて（LF / CRLF）用意する。
- 期待（改行差）: 組立済み asset、asset checksum、manifest checksum、installer source checksum が改行コードに依存せず一致し、組立済み asset に改行コード由来の残存文字を含まない。

### assembled asset evidence gap
- 入力: 組立済み asset があるが、asset checksum、manifest checksum、provenance、検証結果のいずれかが欠落または不一致である。
- 期待: 公開候補 asset の証跡不足として failure-report に分類する。
- 残存状態: installer 実行失敗や release publish 失敗に置き換えず、証跡不足の到達経路を報告する。

## input validation fixture
### checksum mismatch
- 入力: manifest の artifact checksum と実 artifact が一致しない。
- 期待: 非ゼロ失敗。
- 残存状態: handoff state、activation state、install state、既存 release、既存 data は変更されない。

### unknown manifest field
- 入力: production manifest に schema 未定義 field を含める。
- 期待: manifest validation で失敗する。
- 残存状態: network download、service 操作、managed root 変更を行わない。

### schema range reject
- 入力: installer が対応しない manifest schema version。
- 期待: manifest validation で失敗する。
- 残存状態: network download、service 操作、managed root 変更を行わない。

### TLS disabled reject
- 入力: production execution request または manifest が TLS 検証無効化を要求する。
- 期待: input validation で失敗する。
- 残存状態: network download、service 操作、managed root 変更を行わない。

### production insecure URL reject
- 入力: production manifest の download URL が `https://` ではない。`file://` は fixture / test 以外で使われる。
- 期待: manifest validation で失敗する。
- 残存状態: network download、service 操作、managed root 変更を行わない。

### unallowed source boundary reject
- 入力: manifest の owner / repository / registry / package namespace / package coordinate が allowlist 外である。
- 期待: source boundary validation で失敗する。
- 残存状態: network download、service 操作、managed root 変更を行わない。

### fallback registry reject
- 入力: manifest または execution request が fallback URL / fallback registry への暗黙切替を要求する。
- 期待: input validation で失敗する。
- 残存状態: fallback 先へ接続せず、handoff state、activation state、install state を変更しない。

### cache without checksum reject
- 入力: cache hit した artifact または verified placement asset を checksum / signature 検証なしで使おうとする。
- 期待: verification policy 違反として失敗する。
- 残存状態: cache hit を成功根拠にせず、commit phase に進まない。

### offline source mode verified input
- 入力: offline source mode で local manifest、local artifact、manifest checksum、artifact checksum を渡す。
- 期待: network access を行わず、通常 download と同じ manifest validation、checksum / signature、archive entry 検証を通す。
- 残存状態: 検証成功前に handoff state、activation state、install state、service state を変更しない。

### online source mode verified input
- 入力: online source mode で local manifest path または manifest URL、固定 artifact URL または package coordinate、manifest checksum、artifact checksum を渡す。
- 期待: 指定された固定 source だけを使い、通常 download と同じ manifest validation、checksum / signature、archive entry 検証を通す。
- 残存状態: fallback source や local artifact path を成功根拠にせず、検証成功前に handoff state、activation state、install state、service state を変更しない。

### remote manifest re-fetch mismatch
- 入力: operator が checksum / signature で確認した manifest と、installer が実行時に remote から再取得する manifest が別内容になり得る。
- 期待: 実行 manifest の digest / signature が検証済み manifest と一致しない場合は失敗する。
- 残存状態: artifact download、placement、handoff state、activation state、install state、service 操作を行わない。

### offline manifest URL reject
- 入力: offline source mode だが manifest source が local path ではなく URL である。
- 期待: execution request validation で失敗する。
- 残存状態: manifest URL、artifact URL、fallback registry へ接続せず、handoff state、activation state、install state を変更しない。

### offline stale artifact reject
- 入力: offline source mode の local artifact が artifact checksum / signature と一致しない。
- 期待: verification policy 違反として失敗する。
- 残存状態: network fallback を行わず、commit phase に進まない。

### unsafe config syntax reject
- 入力: 設定ファイルに command substitution、`export`、複数行、`source` を含める。
- 期待: config parser validation で失敗し、shell として実行しない。
- 残存状態: secret 値の展開、handoff state、activation state、install state、service 操作を行わない。

### project-specific shell source exception
- 入力: project SSOT が shell-source を明示し、対象が installer 管理ファイルに固定され、privileged execution context では実行されず、user-editable ではなく、secret を含まず、command substitution や副作用を実行しないことを証跡で示す。
- 期待: bounded override として報告し、core safety invariant への到達がない限り blocker にしない。
- 残存状態: 例外理由、影響、残存リスク、source 対象、実行権限、secret 不在の証跡を audit result に残す。

### shell source exception evidence gap
- 入力: project SSOT が shell-source を明示するが、対象 file、実行権限、user-editable でないこと、secret 不在、command substitution や副作用の不在を証跡で確認できない。
- 期待: bounded override とせず、project-specific exception / major finding として報告する。
- 残存状態: 不足している証跡、残存リスク、operator 判断に必要な確認事項を audit result に残す。

### arbitrary env source reject
- 入力: privileged execution context で、user-editable env / config、managed root 外の任意ファイル、symlink 経由の path を shell-source できる。
- 期待: blocker として拒否または監査指摘する。
- 残存状態: secret 実行、service 操作、handoff state、activation state、install state、managed root 変更を行わない。

### unsafe archive entry
- 入力: absolute path、parent traversal、symlink escape を含む archive。
- 期待: archive validation で失敗する。
- 残存状態: managed root 外へ書き込まず、handoff state と activation state を変更しない。

### managed root too broad reject
- 入力: manifest の managed root が system root、home root、広すぎる shared directory など installer 境界として広すぎる。
- 期待: managed root validation で失敗する。
- 残存状態: owner 変更、permission 変更、service 操作、managed root 書き込みを行わない。

### placement outside managed root reject
- 入力: placement target、shared asset path、SBOM path、install state path、handoff state path のいずれかが managed root 外を指す。
- 期待: placement validation で失敗する。
- 残存状態: managed root 外へ書き込まず、handoff state、activation state、install state を変更しない。

### broad ownership change reject
- 入力: installer が managed root 外、または managed root 全体への広い再帰的 owner / permission 変更を要求する。
- 期待: permission boundary validation で失敗する。
- 残存状態: owner / permission 変更、service 操作、activation state 変更を行わない。

### SBOM checksum mismatch
- 入力: manifest に固定された SBOM checksum と取得した SBOM が一致しない。
- 期待: verified placement asset の検証失敗として commit phase に進まない。
- 残存状態: handoff state、activation state、install state、既存 release、既存 data は変更されない。

### shared asset checksum mismatch
- 入力: manifest に固定された shared asset checksum と取得した shared asset が一致しない。
- 期待: verified placement asset の検証失敗として commit phase に進まない。
- 残存状態: handoff state、activation state、install state、既存 release、既存 data は変更されない。

### required installer version reject
- 入力: manifest の required installer version を満たさない installer。
- 期待: manifest validation で失敗する。
- 残存状態: network download、service 操作、managed root 変更を行わない。

### runtime installer field reject
- 入力: 共通 manifest に JRE、Node.js、package manager の download URL、checksum、install option を含める。
- 期待: manifest validation で失敗する。
- 残存状態: runtime 取得・導入・更新、network download、service 操作、managed root 変更を行わない。

### manifest operation mode reject
- 入力: manifest に `install`、`upgrade`、`repair`、`dry-run` などの operation mode を含める。
- 期待: manifest validation で失敗する。
- 残存状態: execution request の mode と混ぜず、network download、service 操作、managed root 変更を行わない。

### manifest out-of-scope operation reject
- 入力: manifest に vulnerability scan の合否判定、OS patch 実行、DB restore、secret 発行を要求する field を含める。
- 期待: manifest validation で失敗する。
- 残存状態: installer 外の運用を実行せず、handoff state、activation state、install state を変更しない。

### manifest source build reject
- 入力: production manifest が source archive からの build、dependency resolve、runtime build output の生成を要求する。
- 期待: manifest validation で失敗する。source archive を配布物として扱う場合は build を伴わない fixture に分離する。
- 残存状態: build artifact、dependency cache、runtime build output を managed root に残さない。

### manifest lifecycle hook implicit execution reject
- 入力: production manifest が lifecycle script / hook の暗黙実行を要求し、明示 policy と検証範囲を持たない。
- 期待: manifest validation で失敗する。
- 残存状態: hook を実行せず、stage、handoff state、activation state、install state へ進まない。

### production install state path missing
- 入力: production manifest に install state path がない。
- 期待: manifest validation で失敗する。
- 残存状態: network download、service 操作、managed root 変更を行わない。

### activation strategy missing
- 入力: production manifest に activation strategy がない。
- 期待: manifest validation で失敗する。
- 残存状態: network download、service 操作、managed root 変更を行わない。

### activation strategy unknown
- 入力: production manifest の activation strategy が許可値以外。
- 期待: manifest validation で失敗する。
- 残存状態: network download、service 操作、managed root 変更を行わない。

### external handoff state path missing
- 入力: activation strategy が `external-orchestrated` だが handoff state path がない。
- 期待: manifest validation で失敗する。
- 残存状態: install state に未反映 release を代替記録せず、service 操作と activation state 変更を行わない。

### source archive no build
- 入力: source archive を production 配布物として扱う manifest。
- 期待: archive 自体の checksum / signature と archive entry を検証し、本番 host で build や dependency resolve を実行しない。
- 残存状態: build artifact、dependency cache、runtime build output を managed root に残さない。

## execution request fixture
### operation mode missing
- 入力: execution request に operation mode がなく、組立時に固定した既定値もない。
- 期待: execution request validation で失敗する。
- 残存状態: network download、handoff state 記録、activation state 変更、service 操作を行わない。

### source mode missing
- 入力: execution request に source mode がなく、組立時に固定した既定値もない。
- 期待: execution request validation で失敗する。
- 残存状態: network download、local artifact 読み取り、handoff state 記録、activation state 変更、service 操作を行わない。

### source mode unknown
- 入力: execution request の source mode が許可値ではない。
- 期待: execution request validation で失敗する。
- 残存状態: network download、local artifact 読み取り、handoff state 記録、activation state 変更、service 操作を行わない。

### offline local artifact path missing
- 入力: offline source mode だが local artifact path がない。
- 期待: execution request validation で失敗する。
- 残存状態: network fallback、handoff state 記録、activation state 変更、service 操作を行わない。

### local artifact path secret reject
- 入力: local artifact path に token、secret、auth header、env value が含まれる。
- 期待: execution request validation で失敗する。
- 残存状態: local artifact 読み取り、audit log への raw path 記録、handoff state 記録、activation state 変更、service 操作はいずれも行わない。

### online local artifact path reject
- 入力: online source mode だが local artifact path が指定されている。
- 期待: execution request validation で失敗する。
- 残存状態: local artifact を成功根拠にせず、network download、handoff state 記録、activation state 変更、service 操作を行わない。

### manifest checksum mismatch in request
- 入力: execution request の manifest checksum と実行対象 manifest が一致しない。
- 期待: execution request validation で失敗する。
- 残存状態: 取得済み artifact、handoff state、activation state、install state を変更しない。

### execution request override reject
- 入力: execution request が artifact URL、artifact checksum、runtime requirement、managed root、placement を上書きしようとする。
- 期待: execution request validation で失敗する。
- 残存状態: manifest の配布物情報を置き換えず、network download、service 操作、managed root 変更を行わない。

### execution request source mode override reject
- 入力: execution request が source mode や local artifact path を使って manifest の artifact URL、artifact checksum、runtime requirement、placement を置き換えようとする。
- 期待: execution request validation で失敗する。
- 残存状態: local artifact や network fallback を成功根拠にせず、handoff state、activation state、install state を変更しない。

### dry-run flag conflict
- 入力: `operationMode` が `dry-run` 以外で dry-run flag が true、または `operationMode` が `dry-run` で dry-run flag が false。
- 期待: execution request validation で失敗する。
- 残存状態: placement target、handoff state、activation state、install state、service state を変更しない。

## runtime / preflight fixture
### runtime missing
- 入力: Maven / npm など external runtime を要求する use case で required runtime を満たさない環境。
- 期待: download、stage、handoff state または activation state 変更前に失敗する。
- 残存状態: artifact 配置、service 停止、handoff state 記録、activation state 変更を行わない。

### lock conflict
- 入力: 同一 managed root の lock が取得済み。
- 期待: 並行実行として失敗する。
- 残存状態: download、service 操作、handoff state 記録、activation state 変更を行わない。

### secret persistence check
- 入力: token または secret を実行時注入する。
- 期待: manifest、execution request、install state、handoff state、audit log、sample、runtime env に secret 値が残らない。
- 残存状態: secret 値を含む一時ファイルを managed root に残さない。

### test timeout evidence gap
- 入力: fixture または test harness が timeout / hang し、installer の完了結果と残存状態を確認できない。
- 期待: 即実装非準拠とはせず、検証器不備または証跡不足として failure report を出す。
- 残存状態: lock、service state、handoff state、activation state、install state、managed root、audit log の確認可否を報告し、副作用が確認できる場合は該当 invariant の finding へ再分類する。

## switch / rollback fixture
### idempotent reinstall
- 入力: installed state と同じ manifest checksum / artifact checksum。
- 期待: 成功扱いにする。
- 残存状態: handoff state、activation state、install state の意味を変えず、不要な restart を行わない。

### conflicting same version
- 入力: 同じ release version だが checksum が異なる manifest または artifact。
- 期待: 明示 option なしでは失敗する。
- 残存状態: 既存 release、handoff state、activation state を維持する。

### health rollback
- 入力: installer が health / rollback を担当する strategy で、switch 後の restart または health check が失敗する。
- 期待: 前 release があれば activation state を戻し、初回導入なら failed activation state を残さない。
- 残存状態: data restore は自動実行せず、install state は成功扱いにしない。

### rollback plan resource separation
- 入力: switch、health、record の前に、変更済み resource ごとの rollback plan を確定する installer。
- 期待: activation state、service manager state、process state、shared asset、install state または handoff state、audit result について、戻す resource、戻さない resource、復元順序、rollback failed の報告条件が分かれている。
- 残存状態: data restore を標準 rollback に含めず、install state を成功扱いにせず、audit log を現在状態の代替にしない。

### active pointer switch
- 入力: `active-pointer` activation strategy と前 active release pointer。
- 期待: switch phase で active release pointer を新 release へ切り替える。
- 残存状態: health 失敗時は前 active release pointer へ戻し、install state を成功扱いにしない。

### in-place reflect rollback
- 入力: `in-place` activation strategy と反映前 target path 状態。
- 期待: switch phase で検証済み staging を target path へ反映する。
- 残存状態: health 失敗時は反映前 target path 状態へ戻し、戻せない場合は rollback failed として install state を成功扱いにしない。

### external orchestrated handoff
- 入力: `external-orchestrated` activation strategy と handoff state path。
- 期待: switch phase で verified release を handoff state に記録し、service restart、health check、現在 install state 更新を実行しない。
- 残存状態: 稼働対象への切替、health、rollback、現在 install state の確定は外部 orchestration に委ねる。

### health retry rollback
- 入力: installer が health / rollback を担当する strategy で、health check が retry 上限まで失敗する。
- 期待: retry policy に従って失敗を確定し、前 release があれば activation state を戻す。
- 残存状態: data restore は自動実行せず、install state は成功扱いにしない。

### rollback failed
- 入力: installer が rollback を担当する strategy で、health failure 後の activation state 復元または前 release 起動が失敗する。
- 期待: activation state の状態不明または復元失敗を明示し、install state を成功扱いにしない。
- 残存状態: data restore は自動実行せず、operator 判断へ渡す。

## state / audit fixture
### install state includes installer version
- 入力: 通常 install / upgrade が成功する。
- 期待: install state に release version、artifact checksum、manifest checksum、installed at、previous release、installer version が記録される。
- 残存状態: audit log が存在しなくても install state から現在状態を判定できる。

### handoff state includes installer version
- 入力: `external-orchestrated` activation strategy の install / upgrade が handoff まで成功する。
- 期待: handoff state に release version、artifact checksum、manifest checksum、handoff recorded at、previous release、installer version が記録される。
- 残存状態: audit log が存在しなくても handoff state から外部切替待ち release を判定できる。

### provenance recorded
- 入力: manifest に source commit、tag、CI run id がある。
- 期待: install state、handoff state、または project SSOT が定める記録先に provenance が残る。
- 残存状態: provenance 署名や attestation の合否判定を installer 内で新規実行しない。

### audit log excludes secrets
- 入力: audit log に requested by、reason、failure reason を記録する。
- 期待: token、secret、auth header、env value が audit log に含まれない。
- 残存状態: audit log が存在しても secret 値を復元できない。

### audit log records source mode
- 入力: online source mode と offline source mode の実行をそれぞれ行う。
- 期待: audit log の `install.begin` / `install.result` に operation mode と source mode が記録され、offline source mode では secret-free local artifact reference だけが残る。
- 残存状態: local artifact path の raw value を audit log に残さない。

### audit begin result mismatch reject
- 入力: audit log の `install.begin` と `install.result` で operation mode、source mode、manifest checksum、artifact checksum、release version のいずれかが一致しない。
- 期待: audit log consistency fixture で失敗する。
- 残存状態: audit log を install state または handoff state の代替正本として扱わない。

### audit result without begin reject
- 入力: 成功証跡として扱う `install.result` が存在するが、対応する `install.begin` がない。
- 期待: audit log consistency fixture で失敗する。
- 残存状態: `install.result` だけで install 成功または handoff 成功を判定しない。

### audit log used as state source reject
- 入力: installer が audit log だけを見て active release または外部切替待ち release を判定しようとする。
- 期待: state source boundary 違反として失敗する。
- 残存状態: 現在状態は install state、外部切替待ちは handoff state から判定される。

### required audit log write failure
- 入力: audit log policy が `required` で、commit 前の `install.begin` 追記に失敗する。
- 期待: install を失敗させる。
- 残存状態: handoff state、activation state、install state を変更しない。

### best-effort audit log warning
- 入力: audit log policy が `best-effort` で `install.begin` または `install.result` 追記に失敗する。
- 期待: install 結果は verified placement、handoff state、activation state、strategy に応じた health、install state で判定し、audit log 失敗を warning として扱う。
- 残存状態: token、secret、auth header、env value を warning に含めない。

### post-commit audit result failure
- 入力: activation strategy に応じた switch、必要な health check、`switch` での handoff state 書き込みまたは `record` での install state 書き込みは成功し、post-commit の `install.result` 追記だけが失敗する。
- 期待: verified install または verified handoff 自体を巻き戻さず、audit log failure として報告する。
- 残存状態: handoff state、activation state、install state、service は成功状態を維持する。

### config schema compatibility check
- 入力: config schema reference と config schema version を project adapter で解決し、required key、deprecated key の互換性を確認する。
- 期待: required key 不足や非互換 schema を検出した場合は handoff state または activation state 変更前に失敗する。
- 残存状態: ユーザー設定を自動 merge しない。

### roll forward policy check
- 入力: rollback 不可の変更が manifest または project SSOT で示されている。
- 期待: roll forward または manual recovery の条件が未定義なら実行前に失敗する。
- 残存状態: artifact rollback と data restore を同じ自動処理に混ぜない。

### dry-run no write
- 入力: `dry-run` execution request。
- 期待: 通常実行と同じ manifest validation、runtime check、archive validation を行い、状態遷移契約の副作用可否に従う。
- 残存状態: placement target、handoff state、activation state、install state、service state を変更しない。audit log は project policy で許可された場合だけ dry-run result を記録する。

### dry-run flag omitted
- 入力: dry-run flag を省略し、operation mode だけを指定した execution request。
- 期待: operation mode を正本として dry-run かを判定する。
- 残存状態: operation mode が `dry-run` の場合は dry-run no write と同じ状態を維持する。

### service manager boundary reject
- 入力: service manager と runtime script の両方で環境変数、PID、ログ、restart を定義しようとする installer。
- 期待: service manager boundary 違反として失敗する。
- 残存状態: service manager に重複定義を残さない。

### runtime script handoff
- 入力: service manager 生成前に、環境変数、PID、ログ、restart の正本を runtime script へ集約する。
- 期待: service manager は runtime script を呼ぶ薄い管理層だけを持つ。
- 残存状態: service manager と runtime script の間に同じ責務を重複定義しない。

### runtime script audit pass
- 入力: installer が配置または生成する runtime script、systemd unit または service manager 定義、EnvironmentFile、health / diagnose / version 証跡に対する runtime-script 監査結果。
- 期待: runtime-script 監査結果が pass で、service runtime boundary の確認済み証跡として扱える。
- 残存状態: installer 監査結果に runtime-script 監査の対象、確認済み invariant、証跡パスを残す。

### runtime script evidence gap
- 入力: runtime-script 監査結果が major evidence gap または blocked by missing evidence、または同等証跡が最低証跡セットを満たさない。
- 期待: service runtime boundary の証跡不足として failure report を出し、準拠扱いにしない。
- 残存状態: 不足証跡、core / major / residual の分類、追加で必要な証跡、gate action を installer 監査結果に残す。

### runtime script blocker candidate
- 入力: runtime-script 監査で blocker candidate が残り、到達性を否定する証跡が不足している。
- 期待: service runtime boundary の blocker candidate として failure report を出し、major evidence gap より下へ落とさない。
- 残存状態: 到達性を否定できない構造、不足証跡、確定に必要な追加証跡を installer 監査結果に残す。

### runtime script forbidden runtime operation reject
- 入力: installer が配置または生成する runtime script が起動時に fetch、build、install、runtime 導入、未検証入力実行、secret 永続化へ到達できる。
- 期待: service runtime boundary 違反として拒否または blocker finding に分類する。
- 残存状態: artifact、state、service、secret、managed root を変更せず、到達経路を監査結果に残す。

### runtime script service supervision reject
- 入力: installer が配置または生成する runtime script と service manager 定義が daemonize、独自 PID 管理、独自 restart 管理、false success、停止不能へ到達できる。
- 期待: service supervision 境界違反として拒否または blocker finding に分類する。
- 残存状態: service manager へ破綻した unit / wrapper を残さず、監視破壊の到達経路を監査結果に残す。

## use case / target platform fixture
### fixed github release native asset
- 入力: 固定 release tag、target platform id、platform-specific asset name、artifact checksum を持つ manifest。
- 期待: target platform id と asset identity の一致を確認し、self-contained native asset では external runtime prerequisite を要求しない。
- 失敗条件: moving tag、target platform 不一致、checksum 不一致を拒否する。

### target platform missing
- 入力: production manifest に target platform id がない。
- 期待: manifest validation で失敗する。
- 残存状態: artifact download、配置、handoff state 記録、activation state 変更を行わない。

### target platform unknown
- 入力: target platform id が use case 契約の標準候補にない。
- 期待: manifest validation で失敗する。
- 残存状態: artifact download、配置、handoff state 記録、activation state 変更を行わない。

## Java / Maven overlay fixture
### fixed maven coordinate
- 入力: Maven repository URL、`groupId`、`artifactId`、固定 `version`、Jar checksum。
- 期待: Jar を activation strategy に応じた placement target へ配置または反映する。
- 失敗条件: `SNAPSHOT`、version range、moving metadata を production 入力で拒否する。

### maven source boundary reject
- 入力: Maven repository URL、owner / repository、`groupId`、`artifactId` が allowlist 外である。
- 期待: source boundary validation で失敗する。
- 残存状態: Jar download、handoff state 記録、activation state 変更を行わない。

### maven moving metadata reject
- 入力: `SNAPSHOT`、version range、moving repository metadata を production 入力に含める。
- 期待: manifest validation で失敗する。
- 残存状態: Maven metadata を解決せず、Jar download、handoff state 記録、activation state 変更を行わない。

### java version insufficient
- 入力: manifest の required Java major version を満たさない環境。
- 期待: Jar 配置、handoff state 記録、activation state 変更前に失敗する。
- 残存状態: JRE を取得・導入・更新しない。

## Node / npm overlay fixture
### fixed npm artifact
- 入力: npm registry URL、package name、固定 version、tarball checksum または integrity。
- 期待: staging で integrity / checksum と expected files を確認してから activation strategy に応じた placement target へ配置または反映する。
- 失敗条件: `latest`、tag、version range、moving branch を production 入力で拒否する。

### frozen dependency install
- 入力: lockfile と固定 package manager version。
- 期待: staging で frozen install を実行し、lockfile 不一致を失敗扱いにする。
- 残存状態: runtime 環境へ read token や `.npmrc` を残さない。

### package manager version mismatch
- 入力: manifest が要求する package manager version と実行環境の package manager version が一致しない。
- 期待: dependency install、handoff state 記録、activation state 変更前に失敗する。
- 残存状態: package manager を取得・更新せず、runtime 環境へ read token や `.npmrc` を残さない。

### npm credential non-persistence
- 入力: private registry 取得に read token を使う。
- 期待: token は実行時注入だけで使い、`.npmrc`、runtime env、install state、handoff state、audit log に残さない。
- 残存状態: token 値を含む一時ファイルを managed root に残さない。

### npm credential persistence reject
- 入力: private registry 取得で使った read token を `.npmrc`、runtime env、install state、handoff state、audit log のいずれかへ残そうとする。
- 期待: credential persistence 違反として失敗する。
- 残存状態: token 値を含む一時ファイルを managed root に残さない。

### lifecycle hook policy
- 入力: `postinstall` など lifecycle script を含む package。
- 期待: 既定では拒否し、許可する場合は manifest の lifecycle hook policy で検証範囲を明示する。
- 残存状態: script 実行が許可されていない場合は stage 前に失敗する。

## shared wrapper fixture
### fixed shared wrapper asset
- 入力: 固定 HTTPS URL で配信する共有 POSIX sh wrapper、プラットフォーム別 platform installer、wrapper checksum、platform installer checksum。
- 期待: wrapper が platform を検出し、検証済み platform installer を checksum 検証後に実行する。
- 残存状態: 検証失敗時に platform installer を実行せず、managed root、handoff state、activation state、install state を変更しない。

### delivery url reject
- 入力: wrapper 配信 URL が HTTPS でない、可変参照、または未許可 host である。
- 期待: 配信契約違反として失敗する。
- 残存状態: wrapper を実行せず、download、配置、state 変更を行わない。

### unknown platform reject
- 入力: 共有 wrapper が標準候補にない OS / architecture で実行される。
- 期待: 対応 platform なしとして失敗する。
- 残存状態: platform installer の download、実行、state 変更を行わない。

### posix sh compatibility
- 入力: POSIX sh（dash など）で共有 wrapper を pipe 実行する。
- 期待: bash 専用構文に依存せず、platform 検出と payload 実行まで完了する。
- 残存状態: payload の検証・失敗時状態は platform installer の契約に従う。

### pipe truncation no side effect
- 入力: pipe 配信された wrapper が完了前に切断される（truncated script）。
- 期待: 検証前の段階で停止し、platform installer を実行しない。
- 残存状態: 一時ファイルだけを残し、managed root、handoff state、activation state、install state を変更しない。

## placement profile fixture
### per-user profile default
- 入力: `placement.profile` を省略した per-user CLI の manifest（`~/.local/share/<vendor>/<app>/<channel>`、launcher `~/.local/bin/<app>`）。
- 期待: per-user-cli として扱い、home-relative パスを実行時に展開し、launcher を current 配下のバイナリへ向ける。
- 残存状態: 検証前に managed root と launcher を変更しない。

### system-wide profile selected
- 入力: project SSOT が `placement.profile: system-wide` を選択し、`/opt/<vendor>/<app>/<channel>` と `/usr/local/bin/<app>` を指定する。
- 期待: system-wide の許可 base で検証し、launcher を managed root 外に設置する。
- 残存状態: 権限不足や base 不一致の場合は起動しない。

### launcher outside managed root
- 入力: launcher を managed root 外のプロファイル別 base に置く。
- 期待: launcher の managed root 外配置を許可し、switch 後に旧 launcher を復元可能な状態で保持する。
- 残存状態: launcher のリンク先が current 配下のバイナリを指す。

### launcher base reject
- 入力: launcher がプロファイル別の許可 base 外（例: `~/.local/lib/<app>`）にある。
- 期待: 配置契約違反として失敗する。
- 残存状態: launcher と managed root を変更しない。

### launcher collision reject
- 入力: launcher の位置に installer 管理外のエントリが存在する（Unix は任意 target への symlink、Windows は内容不一致の copy、または通常ファイル）。
- 期待: 上書きせず失敗し、既存エントリを保持する。
- 残存状態: 既存エントリは変更されず、install state は作成されない（preflight の managed root と lock は cleanup で解放する）。
- 補足: starter 標準は Unix symlink / Windows copy を対象とし、Windows shim は project override として標準 fixture の対象外とする。

### launcher parent traversal reject
- 入力: launcher path に空要素、`.`、`..` を含む（例: `~/.local/bin/../../../<binary>`）。
- 期待: 組立時と runtime の両方で配置契約違反として失敗する。
- 残存状態: launcher と managed root を変更しない。

### system-wide launcher accept
- 入力: `placement.profile: system-wide` の絶対パス launcher `/usr/local/bin/<binary>`。
- 期待: 許可 base の判定を通過し、組立を完了する。
- 残存状態: launcher path が組立済み installer の runtime 値として埋め込まれる。

## 判定単位
- fixture の合否は exit code だけで判定しない。
- handoff state、activation state、install state、audit log、service state、既存 data、secret 残存の有無を合わせて判定する。
- network mock や local artifact を使う場合も、checksum / signature 検証を省略しない。
