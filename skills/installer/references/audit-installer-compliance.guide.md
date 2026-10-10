# インストーラ監査ガイド

## 目的
- リリース前に、作成済み、導入判断が `required`、またはproject SSOTで要求されるインストーラ成果物を、最新の公開済み安定版の標準installerと比較し、標準へ合わせる差分と必要な固有差分を明らかにする。安全性・動作・実候補の検証証跡を裏付けとして、標準整合と公開準備を確認する。
- 監査ガイドの型は `compliance` とし、review / validate / check では不足する対象集合、契約、実装、証跡、停止条件の対応を扱う。

監査目的と実公開との境界は、ci-githubスキルの`references/ci-audit-contract.reference.yml`の`auditContract.purpose`に固定する。成功は選択した段階への適合を示す。実候補・組立証跡・検証profileの結果は、証跡監査を選択した場合の必須確認として保持する。実Release・公開後URLの取得成功は公開後確認へ分ける。

## 監査段階と確認対象

段階選択・判定・集約・結果再利用は、同監査契約の`auditContract.stages`と`evidenceApplicability.reuseEvaluation.stageAndClaimBinding`を正本とする。通常は構成監査のみ。証跡監査を指定された場合は構成監査から同じ対象の証跡監査へ進む。CIから委譲された場合も選択段階と確認対象を引き継ぐ。

| 段階 | installer側の確認対象 |
| --- | --- |
| 構成監査 | 製品宣言・manifestと配置設定、固定provider、実装と安全・停止経路、CI組立・公開経路への接続、README、必要な検証profile・契約テストの配置と対応付け、固有差分の必要性・許容条件 |
| 証跡監査 | 実候補・組立証跡・checksumの一致、対象OSでの検証profileと契約テストの結果、dry-run・隔離install・起動・状態と復旧の実証 |

以下のフローは確認項目ごとにこの対象へ写像する。構成ファイルや必要な検査導線の欠落は構成監査の不適合とし、未生成候補・実行結果の未取得は証跡監査へ分ける。証跡監査が未選択なら未実施・未依頼を明記し、構成監査へ非成功を混ぜない。同じsource/checksumでも構成の成功を実証として再利用しない。

## 選択条件
- installer script、manifest schema、manifest、execution request、組立済み installer asset、asset 組立証跡 record、installer が配置または生成する runtime script、systemd unit または service manager 定義、運用ドキュメント、テスト、fixture、audit log などの成果物を監査する。
- repository-audit の導入判断が `required`、または project SSOT が installer 成果物を要求しており、期待される成果物が存在しない状態を監査する。
- 「このインストーラは installer スキル準拠か」を確認する。

## 注意
- 非対象: installer スキル文書そのものの監査。
- 非対象: 個別アプリケーションの release 方針、OS patch、runtime install、DB restore、secret 発行の妥当性そのもの。
- サンプル入力は形を理解するための資料であり、監査証跡として扱わない。
- 監査は読み取り専用とする。準拠のための導入・更新案を提示しても、実際の変更は明示依頼後に行う。
- 既存プロジェクトに installer の SSOT がある場合も、インストーラ契約 coverage matrix の core safety invariant を緩和する根拠にはしない。

## 機械検証と意味監査
- 検査の選択と未対応項目の扱いは、ci-githubスキルの`references/verify-applied-ci-preset.guide.md`の「機械検証の選択」に従う。installerは固定providerが公開する入力検証の対応範囲を確認し、READMEの実行ファイル・URL・asset名、宣言・manifestの参照先と配置を照合する。機械検査が未対応の項目は意味監査で確認し、未実施を検査成功としない。
- アンインストール案内の存在や参照整合は対応する既存lintで検査し、削除対象の所有範囲、PATH、設定・データへの影響はmanifestと製品契約を使う意味監査で確認する。対応ルールがなければ案内の存在も手動確認し、単語やコマンドの有無だけで安全な削除手順と判定しない。
- 配置警告は project override の採否を決めない。警告の対象、必要性、既存 project SSOT の証跡を project override classification で判断する。検査不能を配置適合へ読み替えない。
- 構成監査では最新標準とdistribution layout、実装、CI workflow、README、検査導線を照合し、証跡監査では実候補・配置結果・実行証跡を照合する。各段階はその段階の適用項目で判定し、全体結果は選択段階だけから集約する。構成だけの成功を動作確認済みやリリース準備完了にしない。

## 標準整合の必須判定

- 比較基準は監査開始時の最新の公開済み安定版に固定する。Release・provider revision・manifestのidentityと採用中のrevisionを記録する。採用中の版への検証成功だけで標準整合を確認済みとしない。
- 差分分類の語彙はci-githubスキルの`references/ci-audit-subjects.reference.yml`の`latest-standard-alignment.differenceClassification`に従う。installer差分の必要性・例外成立・安全性の判断は本スキルが所有し、例外の成立条件はcoverage matrixの`projectOverrideClassification`へ照合する。許可された製品設定値や、同じ標準要件を満たす版番号だけの差を逸脱にしない。
- 標準へ移行すべき差分が残れば構成の標準整合を未達とする。比較基準や例外の必要性を確認できなければ構成を未確認とする。根拠のある固有差分は理由と適用範囲を併記し、実行検証の結果は別記する。実行結果の未取得だけで構成を未達にせず、古い版だけをcore safety invariant違反としない。

## 監査時の優先順位
- project SSOT は命名、対象 platform、adapter、release 方針など project 固有の実装詳細を判断する正本として扱う。
- 上記の物理配置以外については、installer スキルの標準経路を準拠監査の出発点として扱い、project SSOT が標準経路と異なる場合の分類はインストーラ契約 coverage matrix の project override classification に従う。
- core safety invariant の定義はインストーラ契約 coverage matrix を正本とし、project SSOT が明示していても緩和しない。
- project SSOT が installer スキルの契約より厳しいローカル条件を定める場合は、先に project override classification で必要性と証跡を確認する。採用中の条件は無断で無視せず監査基準に含め、必要性の証跡が欠ける条件は `project-specific exception` としてローカルルールの見直し対象にする。
- project SSOT が標準経路と異なる場合は、project override classification に従って分類し、分類結果と根拠を finding または audit note に含める。

## プロジェクト固有規則との競合確認

共通工程はci-githubスキルの`references/verify-applied-ci-preset.guide.md`の同名節へ委譲する。installerに適用される契約・文書・有効な指示・ローカルスキルを対象に、旧前提ツール、実行環境、入口選択、ディレクトリ名、手動操作・説明の義務が標準に競合していないか確認する。例外の必要性と許容条件は本スキルの`projectOverrideClassification`とcore safety invariantへ照合する。CIから委譲された場合は同じ比較基準と対象identityを再利用し、installerの判断と解決案を差分表へ返す。

## 権限境界の語彙
- `privileged execution context`: root、または managed root、service、runtime asset、install state、handoff state、secret、credential に影響できる service user の実行文脈を指す。
- `user-editable file`: installer 管理者以外が編集、差し替え、symlink 経由で誘導できる env / config / script / manifest を指す。
- privileged execution context で user-editable file を shell-source できる場合は、root ではなくても権限境界違反として扱う。

## project override 分類
- 分類表はインストーラ契約 coverage matrix の project override classification を正本とする。
- 本ガイドでは、分類表の条件や severity を再定義しない。

## severity 判定
- 以下は選択した段階の確認項目に適用する。未選択の証跡監査に属する実候補・実行結果の不足から、構成監査のfindingや停止理由を生成しない。
- `blocker`: core safety invariant への到達可能な違反、または runtime-script 監査側で blocker に分類される違反がある。
- `major`: 監査対象として確定した期待成果物が存在しない、または契約 surface はあるが、fixture、state、audit、rollback、source mode、検証済み入力一致、project override classification に必要な証跡が不足している。または危険になり得る設計だが blocker の到達可能性を証跡で確認できない。
- `minor`: ドキュメントの境界説明、ログ粒度、診断メッセージ、fixture 名寄せなど、準拠判定の中核 invariant を直接壊さない改善。
- `none`: project override classification が finding 不要と分類し、core safety invariant への到達可能な違反や証跡不足がない。
- installer が配置または生成する runtime script の runtime-script 契約違反は、runtime-script 監査側の blocker / major 分類を installer 監査で下げずに finding として扱う。
- project SSOT が shell-source を明示している場合でも、それだけで accepted project detail にはしない。構成監査では project override classification の許容条件と shell-source 系 fixture の検査導線を確認し、証跡監査ではその実行結果を照合する。静的に確認できる権限境界違反は構成監査のfindingとして保持する。
- checksums で検証した manifest と installer が実行する manifest が別物になり得る導線は major 以上とする。実行 manifest が未検証のまま artifact 取得、配置、service 操作、activation state 変更へ到達可能なら blocker とする。
- test timeout / hang は、timeout の主体と残存状態で分類する。test harness や fixture driver の停止で installer の副作用が確認できない場合は証跡不足または検証器不備として major、installer が lock、service 停止、partial state、検証前配置を残す場合は該当 invariant の major または blocker とする。

## action / 停止要否
- `fix-now`: 正解が一意で、project SSOT、coverage matrix、fixture baseline、asset 組立証跡契約のいずれかに照らして局所修正できる。停止不要。
- `stop`: 契約と実装のどちらを真にするか、project override が bounded かどうか、または runtime-script 監査結果の解釈を判断できない場合。停止して確認する。
- `handoff`: runtime-script スキル、ci スキル、backup スキル、secret-management スキル、project SSOT など installer 外の owner で直す必要がある場合。停止して責務者へ戻す。
- `observe`: finding ではない未確認範囲、将来確認、project detail の記録。停止不要。
- `blocker` は `stop` または `fix-now` に限る。正解が一意で局所修正できない blocker は停止する。
- `major` は `fix-now`、`stop`、`handoff` のいずれかへ分類し、証跡不足であっても `observe` に落とさない。
- `minor` は `fix-now` または `observe` とする。
- `none` は `observe` とし、finding ではなく audit note または未確認範囲として記録する。

## runtime-script 監査結果の取り込み
- 委譲時に選択段階と確認対象を渡し、runtime-script ownerの元の判断を保持する。実装・設定・検査導線に関する判断は構成監査、実動作や実行証跡不足は証跡監査へ写像する。以下の実行証跡・gate actionを未選択の証跡監査から構成監査へ混ぜない。owner結果を分離できない場合は未確認として報告し、適合や実証済みを推測しない。
- installer が runtime script、systemd unit、service manager 定義、EnvironmentFile を配置または生成する場合は、runtime-script 監査結果を service runtime 境界の証跡として取り込む。
- runtime-script 監査を実行できない場合の同等証跡は、runtime-script 監査ガイドの最低証跡セットと代替証跡条件を満たす場合だけ準拠証跡として扱う。
- 説明文、サンプル、実行者の口頭確認、証跡元を追跡できない summary は同等証跡として扱わない。
- runtime-script 監査結果を取り込む場合は、runtime-script 監査レポートの `判定`、`最大 severity`、`gate action`、`findings`、`blocker candidates`、`evidence gaps`、`open questions` をそのまま保持する。
- runtime-script 監査結果が `pass` または `pass with minor gaps` の場合だけ、service runtime boundary の確認済み証跡として扱える。
- runtime-script 監査結果が `major evidence gap`、`non-compliant`、`blocked by missing evidence` の場合は、installer 監査でも service runtime boundary の未解決事項として扱い、installer 側で severity や gate action を下げない。
- runtime-script 監査の `blocker candidate` は installer 監査でも blocker candidate として保持し、major evidence gap より下へ落とさない。
- runtime-script 監査の gate action が `provide evidence`、`fix before release`、`block release` の場合、installer 監査結果にも同じ停止理由を併記する。
- runtime-script 監査の audit action、停止要否、handoff 先は installer 監査結果でも保持し、installer 責務へ戻された事項を service runtime 境界の finding または evidence gap から切り離さない。

## 標準経路の所有境界
- 製品宣言・manifest以外の共通source、builder、adapter、共通テストを利用projectでGit管理していないか確認する。
- CI中のruntime取得は許容するが、固定revisionと最小資材集合を確認する。Agent Skillや保守テストをCIに取得しない。
- 検証profileの実行範囲とnative/hosted受入の不足を区別する。標準範囲は標準組立契約を正本とする。
- 参照: references/installer-standard-assembly-contract.reference.yml

## フロー
1. 監査対象を棚卸する。
   - 選択段階、対象identity、確認対象を記録する。以降は「監査段階と確認対象」に従って項目を分け、証跡監査の照合は選択した場合だけ行う。
   - project SSOT、release manifest、execution request、asset 組立証跡 record、coverage matrix、fixture baseline から、installer script、manifest schema、組立済み installer asset、asset checksum、manifest checksum、provenance、組立後検証結果、state / handoff state、audit log、installer が配置または生成する runtime script、systemd unit または service manager 定義、製品READMEのインストール節、運用ドキュメント、テストを棚卸する。
   - 監査対象外のファイルを明示し、スキル文書や一般サンプルを証跡に混ぜない。
2. 判定基準を固定する。
   - 提供元の公開済み安定版Releaseと採用中のprovider revisionを比較し、最新版の標準構成を比較基準に固定する。提供元の版選定と必要機能の確認はci-githubスキルの`references/distribute-ci-assets.guide.md`の「対応条件」へ委譲し、版番号を本ガイドへ保持しない。比較したRelease・revisionを記録し、最新資材を確認できない場合は未確認とする。CI監査から委譲された場合は、最新Releaseの確認結果と同一の比較基準・監査対象に結合した証跡を確認して再利用する。別の版を比較基準にしない。
   - 監査で使う installer の共通契約と適用可能な starter を特定し、比較元のパスと実ファイル checksum または未変更の revision、対象実装の状態を記録する。比較元を特定できなければ証跡不足として扱い、比較済み・最新版に適合と報告しない。
   - 共通構成・動作と対象実装の差分を確認し、製品固有値や許可 adapter の適合で準拠できるかを先に評価する。配置検証の成功だけで実装・動作への準拠を判断しない。
   - 準拠できない場合は、必須制約の必要性と標準経路では満たせない根拠を証跡へ照合し、project override classification で判定する。既存実装や project SSOT の記載だけで例外を正当化しない。正当性の検証前に例外を受け入れない。
   - project SSOT で判断する実装詳細、標準経路から外れる project override、core safety invariant で判断する準拠条件を分ける。
   - project-owned custom installer の実装形式を、インストーラ作成ガイドの選択基準に照らして確認する。
   - project override classificationに従い、必要性・許容条件の根拠不足は構成監査のfindingとする。実行結果の不足は選択した証跡監査へ保持し、構成上の例外成立と動作検証の成立を混同しない。
3. 契約 surface へ対応付ける。
   - manifest contract、execution request contract、source mode contract、asset 組立証跡契約、state machine、audit log contract、audit event contract、fixture baseline のどれを各成果物が満たすべきかを対応付ける。
   - installer が runtime script を配置または生成する場合は、runtime-script スキルの監査結果、または runtime-script 監査ガイドの最低証跡セットと代替証跡条件を満たす同等証跡を service runtime 境界の証跡として対応付ける。
   - 必須の構成や検査導線の欠落と、実候補・組立証跡・実行結果の未取得を分け、該当段階の根拠不足として扱う。未生成の実候補だけで構成不適合にしない。
4. blocker を先に確認する。
   - operator が検証した manifest / artifact と installer が実行に使う manifest / artifact が一致しているか。
   - manifest 再取得や fallback により、検証済み入力と実行入力が別物になり得る到達可能経路がないか。
   - installer が JRE、Node.js、package manager を取得・導入・更新する場合、project override として固定入力、検証、配置、権限、rollback または recovery が定義されているか。
   - production 入力に branch、`latest`、version range、SNAPSHOT、moving tag などの可変参照がないか。
   - checksum / signature 検証前に配置、削除、上書き、service 停止、activation state 変更をしていないか。
   - production host で source build や dependency resolve を実行する場合、project override として固定入力、toolchain、依存解決、出力検証、失敗時状態が定義されているか。
   - unsafe archive entry、manifest contract の launcher 安全不変条件で認められた launcher と必要な親ディレクトリ作成以外の managed root 外の書き込み、広い所有権変更、lock 不在、secret 永続化、audit log と state の混同がないか。
   - privileged execution context で、user-editable env / config、managed root 外の任意ファイル、symlink 経由の path を shell-source していないか。
   - installer が配置または生成する runtime script が、起動時に fetch、build、install、runtime 導入、未検証入力実行、secret 永続化、daemonize、独自 PID 管理、独自 restart 管理へ到達しないか。
5. invariant ごとに監査する。
   - coverage matrix の installer invariant、asset assembly evidence boundary、audit evidence boundary を軸に、入力固定、source mode、operation mode、runtime 前提、state / audit 分離、secret 非永続、activation strategy、配置検証、asset 組立証跡、設定・復旧境界、service runtime 境界、証跡完走性を確認する。
   - 構成監査ではfixture catalogのexpected outcomeとcoverage roleが検査へ対応付くかを確認する。成功証跡と違反検出証跡の実結果は証跡監査で確認する。
6. runtime overlay を確認する。
   - Java / Maven 系では固定 Maven coordinate、JRE version 照合、SNAPSHOT / moving metadata 拒否、Jar checksum、runtime script と service manager の境界を確認する。
   - Node / npm 系では固定 package version、integrity / checksum、`latest` / range 拒否、package manager version 照合、lifecycle script policy、credential 非永続を確認する。
   - installer が runtime script を配置または生成する場合は、runtime-script スキルの起動責務、手動操作、service manager handoff、PID、ログ、restart、health 境界に沿っているかを確認する。
   - runtime-script 監査で blocker / major に分類される違反または証跡不足は、installer 監査の service runtime 境界 finding として併記する。
7. READMEの標準比較を構成監査の独立工程として、次の順に実施する。検査導線を確認し、選択した証跡監査で実行結果を照合する。
   1. `references/use-standard-installer.guide.md`の「固定providerの対応確認」を実施し、採用workflowの固定revisionで成立するuse case・platform・runtime前提・URLを確定する。
   2. 同ガイドのREADME基本形と「標準構成からのセットアップ」を使い、OSごとに標準の入口・期待コマンドと現在の入口・READMEコマンドを既存の差分表へ並べる。project-localのセットアップガイドとREADMEの参照先も比較対象に含める。
   3. 差分ごとに標準へ移行できるか、維持するなら標準では満たせない要件とownerの根拠があるかを確認する。短い標準起動へ置換できる操作には具体的なREADME置換案を示す。
   4. 対応根拠、OS別比較、必要性レビューを揃えて既存の差分分類と段階別判定へ渡す。比較結果はCIへ返し、既存ガイドとの一致やpreflight成功だけで整合判定へ進まない。

   以下の確認項目を上記工程と段階別検査へ対応付ける。
   - 組立済みassetを扱う場合は、公開予定の実候補assetと組立証跡record（candidate / verification / final evidence）のchecksum対応を確認する。公開前でも取得できる実候補・証跡を使い、Releaseへの添付完了を要求しない。
   - fixture baseline に対応する成功系、失敗系、冪等再実行、rollback / handoff、dry-run、state / audit 境界のテストがあるかを確認する。
   - 必要なテストの配置・対応付けがなければ構成監査の不足とする。テストはあるが実行結果がない場合は、選択した証跡監査の証跡不足とし、構成の結果を変更しない。
   - timeout / hang は、test harness の不備、fixture driver の不備、installer 実行の停止を分け、残存 state、lock、service、managed root、audit log の副作用を確認して severity を決める。
   - 製品READMEを必須確認対象とし、`references/use-standard-installer.guide.md`の「READMEに残す内容」「READMEへ書かない内容」を適用する。構成監査は宣言・manifest・配布計画、選択した証跡監査は実候補へ照合する。
   - READMEの本文・導入導線はroot-docsスキルの`references/audit-root-docs.guide.md`を補助として適用する。対象をインストール・アンインストール節とその参照先へ限定し、段階・対象identity・確認項目とinstallerが確認した製品情報を渡す。root-docsの文書判断と、installerが所有する配布経路・コマンドの正当性を分けて保持する。実行証跡不足は該当する証跡段階へ写像し、構成の不適合へ混ぜない。
   - アンインストール案内を同セットアップガイドの「READMEに残す内容」へ照合し、欠落・削除対象の不一致・共有領域の削除を構成監査のfindingにする。構成監査で実際の削除は行わず、削除実行の証跡不足を構成の不適合へ混ぜない。
   - 宣言ファイルとインストール先を`references/define-installer.guide.md`の「製品宣言の標準配置」「配置プロファイルと標準配置」へ照合し、非標準のディレクトリ名・構造には製品要件とownerの根拠を確認する。既存配置との一致だけを標準適合の根拠にしない。
   - 同セットアップガイドの「標準構成からのセットアップ」と「固定providerの対応確認」に従い、共有入口の適用可否も比較する。OSごとに入口ファイル・役割（共有入口／対象別payload）、採用use case、標準入口への移行可否、維持理由または提供元の不足を差分表に記録する。固定providerの対応根拠、Windowsの実行環境、URLの置換結果も照合し、スキル・サンプルやpreflight成功だけで対応済みとしない。採用宣言に固定版が拒否する組合せ・URLの未確定値が残る場合は構成の不適合とし、確認未実施・根拠不足は既存の未確認分類へ渡す。短い対象別起動を記載済みでも比較を省略せず、比較不足のまま構成の標準整合をsuccess・100%・差分なしとしない。共有入口が未対応の場合はその不足を移行対象として示し、契約に適合する対象別実装自体を安全性違反としない。
   - READMEの欠落・記載不整合は構成監査のfindingとする。未実行platformは証跡監査で区別し、監査結果にインストール概要を表示するだけでREADME確認の代わりにしない。監査中はREADMEを変更しない。
   - 「標準比較の完了チェック」を満たすことを確認し、既存の差分表とowner結果をCIへ返す。修正依頼では同セットアップガイドのREADME手順へ接続し、許可範囲の改稿と構成再確認まで行う。
   - 公開予定URLはrelease identity・asset名・配布計画への一致を構成監査で確認する。URL構成が不明なら構成の未確認、選択した検証profileの結果不足なら証跡監査の不足とする。公開後のHTTP取得・実公開物の導入は公開後確認へ分ける。
8. 指摘を分類する。
   - severity 判定、action / 停止要否、project override classification を基準にする。
   - runtime-script 監査結果を取り込む場合は、runtime-script 側の result class、evidence gap、blocker candidate、audit action、停止要否、handoff 先、gate action を保持する。
   - 同じ事象が複数 invariant に触れる場合は、最も高い severity を採用し、関連 invariant を finding に併記する。
9. 監査結果を出す。
   - 本文はci-githubスキルの`references/ci-audit-subjects.reference.yml`の`latest-standard-alignment.reportFormat`に従う。以下の必須詳細は参照先または該当区分へ記載し、installer固有の報告形式を追加しない。インストール概要は判定の補足として示す。
   - 構成監査と証跡監査の結果・根拠・確認対象・未確認を分けて報告する。証跡監査が未選択なら未実施・未依頼を明記する。CIへも段階別結果を返し、実行証跡不足を構成の不適合へ混ぜさせない。
   - リリース前確認の結果として報告し、実公開成功の証明と読み替えない。実公開後に確認するURL取得・公開物導入・Hosted公開は別記し、その未実施だけで監査全体を非成功にしない。
   - 比較基準のRelease・revision・manifest、採用中のrevision、標準整合の判定、差分分類と理由、移行案・未確認事項を先頭に報告する。安全性・動作・実候補・Hostedの証拠と、監査全体の結果は裏付けとして分けて示す。CIから委譲された場合は標準整合と差分の証拠をCIへ返し、installer側の判定をCI側で代替させない。
   - 要件を満たせる最新の標準構成への移行案を優先提示する。既存の固有実装を残す場合は`references/use-standard-installer.guide.md`の「標準構成からのセットアップ」に従い、必要性と標準では満たせない要件を確認する。読み取り専用監査では変更せず、移行案と確認事項を報告する。修正依頼へ進む場合は、既存の採否が未確定なら利用者と採用方針を確認する。最新版の存在だけで採用中の版を契約違反とせず、準拠判定と更新推奨を分ける。
   - 比較元、対象状態、共通 installer への準拠状況、準拠可能性、非準拠の根拠と検証結果を示す。準拠が必要な場合は選択した starter、製品固有の適合箇所、導入・更新の具体手順、既存資産への影響、検証方法を提示する。正当な例外は許容範囲と残存リスクを示す。
   - finding は重大度、分類、result class、audit action、停止要否、handoff 先、gate action、対象 contract / invariant、証跡パスと行番号、問題、推奨案、理想案を含める。
   - confirmed finding、blocker candidate、core evidence gap、major evidence gap、residual evidence gap、open question を分ける。
   - 問題がない場合も、確認済み invariant と残る証跡不足を明示する。
   - installer 成果物が確認できる場合は、「インストール概要の表示」に従ってインストール方法とインストール先を表示する。
   - 監査レポートの最後に、ci-githubスキルの`references/ci-audit-subjects.reference.yml`の`latest-standard-alignment.finalReport`に従って「標準適合度・差分・正当性レビュー」を必ず付ける。installerの比較範囲で集計し、全実質差の正当性を本スキルの例外成立条件でレビューする。差分なし・未確認の場合も省略しない。CIから委譲された場合は比較項目と分類、差分表、ownerレビュー結果をCIへ返し、CIの末尾レポートで重複集計させない。

## 標準比較の完了チェック

次を選択した監査段階で確認し、既存レポートの差分表と根拠に残す。別の報告形式は追加しない。比較不足のまま「標準適合」「差分なし」「100%」と報告しない。

- [ ] セットアップガイドの「固定providerの対応確認」を実施し、OS別に標準入口・期待コマンドと現入口・READMEコマンドを並べた。
- [ ] セットアップガイドのREADME記載範囲へ照合し、通常ツールの列挙・コマンドの言い換え・重複説明を残していない。残す説明は具体的な追加準備、利用者の判断、削除の影響などを伝える必要があるか意味監査し、根拠はREADMEへ追加せず監査記録に残した。
- [ ] アンインストール案内をセットアップガイドへ照合し、削除対象・PATH・設定やデータへの影響を確認した。
- [ ] 宣言ファイル、managed root、releases・current・lock・state・launcherを作成ガイドの標準配置と比較した。
- [ ] 適用されるproject固有規則と標準の競合を確認し、双方の根拠・owner・解決案または解決結果を同じ差分表へ残した。
- [ ] 全差分に具体的な移行案、または維持に必要な製品要件とownerの根拠を付けた。値が未確定なら未確認値と確認先を示した。
- [ ] 構成と実行証跡を分け、公開・監査・証跡の状況は監査記録へ置いた。未依頼の証跡不足を構成の不適合へ混ぜていない。

修正依頼では、対象とした差分を修正後のREADME・製品宣言・manifestと、手順を制約する契約・文書・ローカルスキルで再確認し、既存の差分表へ解消、正当な例外、未解消、未確認を反映する。対象に未解消・未確認が残る場合は修正完了としない。読み取り専用監査の実施完了と、指摘の修正完了は分ける。これらの確認結果から監査statusへの写像は既存の分類に従う。

## 最終結果の独立レビュー

セットアップ・README修正・監査・監査後修正の最終報告前に、検証とセルフレビューを終えた対象をpost-artifact-reviewへ「独立レビュー必須」として渡す。比較基準、対象状態、今回の変更集合または監査範囲、選択段階、標準比較の完了チェック結果と根拠を固定し、標準・README・製品宣言・manifestと、適用された契約・文書・有効な指示・ローカルスキルの現物へ直接照合できる入力を渡す。競合の解決結果と根拠も含める。過去の報告や「監査済み」という結論だけを入力にしない。

主工程から一度だけ実施する。CIからの委譲ではinstallerが上記入力をCIへ返し、CIの最終レビューに含める。root-docsを含む補助工程で別の最終レビューを起動しない。監査そのものは主工程で実施し、独立レビューを監査の代替にしない。

レビューが未完了なら最終結果の完了報告・デプロイへ進まず、その事実を報告する。結果の再検証・採否はpost-artifact-reviewの委譲先に従ってメインが判断し、構成と実行証跡の判定範囲を維持する。独立レビューの完了だけで標準適合や実行確認済みとは扱わない。

## インストール概要の表示
- manifest・配布計画または実候補から確認できる「インストール方法（インストールコマンド）」と「インストール先」を表示し、予定の構成値か実証した結果かを区別する。実候補未生成だけを構成の不適合にせず、値を確認できない場合は根拠不足として示す。
- 表示値は manifest（profile / channel / placement / activation / launcherPath）、distribution layout（delivery / release）、execution request（operation mode / source mode）から取得し、推測しない。
- 取得できない値は `未確認`、未設定の項目は `未設定` と表示する。配信 URL や asset 名を確認できない場合はコマンドを推測せず、`未確認` と表示する。
- インストール方法は実行するコマンドそのものを表示する。採用したdeliveryとOSに既定コマンドを示し、非既定は対応する操作の代表例（upgrade、offline の manifest / artifact 指定）だけを示す。構成監査では対応範囲を `references/installer-use-case-contract.reference.yml` とmanifest・配布計画へ照合し、証跡監査では検証済み実候補へ照合する。予定の対応範囲と実証した範囲を区別する。
  - 共有 Unix wrapper: `curl ... | sh` とし、非既定は `INSTALLER_*` を `sh` 側へ付ける。
  - Windowsの標準経路はtarget-specific `.ps1` とする。Windows共有wrapperは検証済みowner extensionがある場合だけ、提供元と適用範囲を明示してその実コマンドを示す。
  - 既定のオンライン導入は`assets/examples/readme-installation.example.md`を参照し、採用済みの配布経路に対応する実コマンドを表示する。Unix共有wrapperとWindows対象別installerを混同しない。
  - offlineなどファイル実行が必要な操作では、取得済みtarget-specific assetの実行（`./install-*.sh` / `-File install.ps1`）とCLI引数を示す。
- インストール先は launcher、managed root、releases、current、lock、state と、権限・所有者を実パスで示す。プレースホルダは展開前の表記のまま示し、実行時に展開されることを注記する。
- 変更・失敗時の挙動（dry-run / upgrade / repair / rollback / uninstall）を簡潔に示す。
- 表示テンプレート（採用したdelivery・OS・操作に該当するblockだけを使用する。Windows共有owner extensionのコマンドは、その検証証跡から取得する）:

````markdown
### インストール方法（インストールコマンド）
- 配置プロファイル: <profile> / 配信: <delivery>

#### 既定のオンライン導入
<READMEサンプルを参照し、採用済みdelivery・OSの実コマンドを表示>

#### 共有wrapperの非既定例（Unix）
```sh
curl -fsSL --proto '=https' --proto-redir '=https' <wrapper-url> | INSTALLER_MODE=upgrade sh
curl -fsSL --proto '=https' --proto-redir '=https' <wrapper-url> | INSTALLER_SOURCE=offline INSTALLER_MANIFEST=<path> INSTALLER_ARTIFACT=<path> sh
```
#### 取得済みtarget-specific assetのoffline例（Unix）
```sh
./<installer-asset-name>.sh --mode upgrade --source offline --manifest <path> --artifact <path>
```
#### 取得済みtarget-specific assetのoffline例（Windows）
Windows PowerShell 5.1以降に対応する標準実装では、Windows標準の`powershell`を使います。

```powershell
powershell -ExecutionPolicy Bypass -File <installer-asset-name>.ps1 -Mode upgrade -Source offline -Manifest <path> -Artifact <path>
```

### インストール先
```
<launcher-path>                       # launcher（managed root 外）
<managed-root>/                       # managed root
├── releases/<version>/
├── current -> releases/<version>
├── install.lock
└── state/install-state.json
```
- launcher: <値または未設定>
- managed root: <値>
- activation: <strategy>
- 権限: <実行ユーザー / service user / 所有者>
- 注記: `~/` や `%LOCALAPPDATA%` は installer が実行時に展開する。

### 変更・失敗時の挙動
- dry-run: 検証のみ
- upgrade: 新 release を追加して current を切替
- repair: 現在 release と launcher の整合を復元
- rollback: activation / launcher / state を戻す。data restore は含まない
- uninstall: 標準 installer の対象外

### 未確認
- <未確認の URL、Windows 実機、証跡不足など>
````

## リファレンス
### インストーラ作成ガイド
- 参照: references/define-installer.guide.md

### インストーラ manifest 契約
- 参照: references/installer-manifest-contract.reference.md

### インストーラ execution request 契約
- 参照: references/installer-execution-request-contract.reference.md

### インストーラ source mode 契約
- 参照: references/installer-source-mode-contract.reference.yml

### インストーラ asset 組立証跡契約
- 参照: references/installer-asset-assembly-evidence-contract.reference.md

### インストーラ audit log 契約
- 参照: references/installer-audit-log-contract.reference.md

### インストーラ audit event 契約
- 参照: references/installer-audit-event-contract.reference.yml

### インストーラ fixture baseline
- 参照: references/installer-fixture-baseline.reference.md

### インストーラ fixture catalog
- 参照: references/installer-fixture-catalog.reference.yml

### インストーラ契約 ID catalog
- 参照: references/installer-contract-catalog.reference.yml

### インストーラ契約 coverage matrix
- 参照: references/installer-contract-coverage.reference.yml

### インストーラ状態遷移契約
- 参照: references/installer-state-machine.reference.md

### runtime-script 監査ガイド
- 参照: runtime-script スキルの監査ガイド
