# Release assets公開ワークフロー実装ガイド

## 目的
- executableをrelease tagに対応するGitHub Release assetsへ安全に公開する。
- package registryを使わない標準経路を用意し、development実行可能資材と重複公開による無料枠消費を避ける。
- provider-neutral な公開経路の意味と契約は `ci` の release-publication preset から受け取り、GitHub Actions 固有の実装を ci-github スキルで扱う。

## 前提
- 対象プロジェクトの owner 契約により、GitHub Release assets 経路と publish 範囲が解決済みであること。
- owner 契約により、publication request を起動できる主体が publication authorization を発行できる主体と一致していること。一致しない場合は、この canonical flow を承認 gate の代替として使用せず、owner が別途選択した approval handoff へ委譲する。
- Release tag identity、承認済みrelease notes、inventory、resource identity、provider 公開適合、失敗診断、成功状態の不変条件は `release-asset-publication-contract.reference.yml` を正本とする。
- branch category、tag source、branch ancestry、version policyの意味と採否は git スキルへ委譲する。Release assets workflow は、その正本から受け取った tag/source identity の binding と object の実測だけを再検証する。
- runnerとtrusted CI controlの境界は`references/runner-trust-policy.reference.md`に従うこと。
- workflow の Action、runner/host、runtime、toolchain、container、外部ツールの版指定は`references/workflow-version-policy.reference.md`に従うこと。
- 基本経路ではtag更新・削除禁止証跡を必須にしない。provider側のtag保護とruleset管理は基本CIの責務外とする。

## フロー
1. git owner の事前承認、tag preparation、手動publication request、権限付きworkflowを分離する。
   - git スキルの release flow で release identity と本文を承認してから annotated tag を作成する。CI 固有の publication authorization metadata を Git owner の承認契約へ混ぜない。
   - tag上のrelease request workflowはevent、tag ref、source SHAだけを未信頼requestとして渡し、source checkout、build、authority判定、`contents: write`権限を持たず、公開を起動しない。
   - operator は tag request の成功後に、release request の run ID、事前承認済みの release identity と本文、publication authorization の一意な approval ID、本文 digest、承認期限を低権限の publication request へ実行単位入力として渡す。owner 契約で authorization authority と確認済みの actor に限り、GitHub が受理した認証済み `workflow_dispatch` を publication authorization と搬送の authority とする。publication request は本文と digest を照合して request artifact と notes handoff artifact を同一 run に固定する。source checkout、build、authority 判定、write 権限は持たない。
   - publication request の dispatcher が publication authorization tuple を発行する。同一 release に複数の authorization tuple を混在させない。
   - publication request の成功は authorization 入力の同一性と搬送 provenance の成功であり、タグ作成前の人間による本文承認の成功へ読み替えない。approval ID は dispatcher が割り当てる相関識別子で、publication request run ID の別名にしない。
   - default branch上のpublication callerをpublication requestの`workflow_run`で起動する。callerはrepository、workflow、event、conclusion、default branch、run ID、head SHAをfail closedで検証してからreusable publicationを呼び出す。
   - publication request が failure または cancelled の場合も caller の検証 job を skip せず失敗させ、summary には検証結果と publication 未実施を残す。
   - publication callerをtag上のrelease requestへ直接接続しない。
   - caller と reusable publication は、trigger となった publication request run を request と notes handoff の唯一の取得元とする。任意の notes handoff run ID を受け付けない。
2. 書込権限を持たないauthority preflightを実行する。
   - authority preflightは`contents: read`とし、requestのtag refとsource SHAを、gitスキルの`git.release-flow`から別入力として受領したtag、target commit、versionへ照合してrelease tag identityを検証し、tag object SHAを解決する。
   - `release-asset-publication-contract.reference.yml` の `tagIdentity` に必要な release authority context を出力し、後続jobはこのcontextからtag ref、tag object SHA、source SHA、versionを受け取る。platform集合はproject-localなtrusted CI controlから別に固定する。
   - verifierが出力したsource SHAだけを後続のbuild対象にする。
   - source identity の確定後、build 前に公開 source の provider 適合を観測する。不適合または判定不能は後続 stage へ進めず停止し、この早期観測を write 直前の再観測の代替にしない。判定規則と credential route の限界は `references/workflow-authoring-policy.reference.md` の Release 公開の provider 適合を正本とする。
3. 書込権限を持たない quality job で固定 source を検証する。
   - source gate は authority と checkout の identity だけを検証し、format、lint、test は quality job が trusted control の runner、runtime、adapter descriptor から実行する。
   - quality の failure、skip、cancel は build を開始させない。
4. 書込権限を持たないbuild / validate jobでrelease資材を作る。
   - 採用済み installer asset の組立を担当する adapter（補助資材の場合は supplemental asset adapter）は、本スキルの workflow 設計で installer スキルへ委譲して解決した契約に接続する。このガイドから直接着手した場合も adapter を決める前に同じ委譲を行い、委譲先の契約または owner 契約が未解決なら構成しない。
   - build / validate jobは`contents: read`とし、`contents: write`、release token、署名用秘密鍵を持たせない。
   - trusted CI controlと操作対象sourceのcheckout pathを分離する。
   - 操作対象sourceは検証済みrequestのsource SHAへ固定する。
   - 対応するOS / CPU architectureを1つ以上明示する。
   - trusted controlのplatform manifestを検証してGitHub-hosted runnerのmatrixへ変換し、各platformをmanifestで指定したnative OS runner上でbuildする。
   - platform manifestは`platforms`だけをroot fieldに持ち、各要素を`id`、`runner`、`target`だけで構成する。`id`と`target`は重複不可、`runner`はci-githubのplatform manifest契約が許可するGitHub-hosted runner labelに限定し、空集合、未知field、不正値はfail closedとする。
   - canonical workflowはbuild adapterへ`language-profile`、platform manifest、toolchain、現在の`platform-id`、現在の`platform-target`、authority context、platform別output directoryの順で渡す。
   - asset名から製品名、version、OS、CPU architectureを識別できるようにする。
5. build / validate job内で資材を検証する。
   - 期待するplatform集合、ファイル種別、実行可能性、version、空ファイルでないことを検証する。
   - 各assetのSHA-256 checksumを生成し、checksum一覧もRelease assetsへ含める。
   - token、署名用秘密鍵、source mapなど公開対象外のファイルを除外する。
6. 検証済みassetだけをRelease作成jobへhandoffする。
   - 操作対象source由来のhandoffは`references/runner-trust-policy.reference.md`の権限境界に従い、asset、checksum、asset manifestだけをActions artifactに含め、対象と保持期間を最小化する。asset manifestの構造は`ci`スキルの`release-build-scripts`契約を正本とする。
   - upload actionが返すActions artifact IDをRelease作成jobへ渡し、取得した一時artifactの descriptor、manifest、成果物 digest、source/version/target identity を `ci-handoff-integrity` で検証する。Actions artifact transfer API の別 digest Action は使用しない。
   - Actions artifactはjob間の権限境界を越える一時handoffに限定し、利用者向け配布先にしない。
   - 各matrix buildは`release-build-{platform-id}`を一意な一時artifact名としてuploadし、assemble jobは全`release-build-*` artifactをartifact名ごとのsubdirectoryを保って取得する。いずれかのbuild、検証、upload、downloadが失敗した場合はassembleとpublishへ進めない。
   - Release作成jobはrelease authority contextと操作対象source由来のhandoffを別入力として受け取り、trusted CI controlからexpected platform集合とasset manifestを照合し、各assetのchecksumを再計算する。build jobのscriptや実行可能assetは実行しない。
   - 承認済みrelease notesは `release-asset-publication-contract.reference.yml` の `releaseNotesInput` に従う別のhandoff入力として受け取り、`git.release-flow.body`の出所、digest、release identityの結合を検証する。本文をタグ注釈や生成結果から再構成しない。
7. Release作成jobで既存releaseとassetを確認する。
   - Release作成jobだけに`contents: write`を付与し、それ以外のjobは`contents: read`以下とする。
   - Release作成jobでは操作対象sourceをcheckoutまたは実行しない。
   - Release作成の直前にtrusted CI controlからrelease tagを再解決し、そのobject SHAがrelease authority contextのtag object SHAと一致すること、tag objectのtypeが`tag`であること、annotated tagをcommitへdereferenceした結果がrelease authority contextのsource SHAと一致することを検証する。
   - Release作成の直前にprovider適合を再観測し、不適合または判定不能の場合はwriteしない。default branchと権限状態はbuild中に変わり得るため、authorityの早期観測結果を再利用しない。
   - 書き込み前の観測は `release-asset-publication-contract.reference.yml` の `inventory` を満たす場合だけ有効とする。
   - 書き込み前の同一tag Releaseが0件であることを確認できない場合はfail closedとする。
   - 同じtagの既存releaseまたは既存assetを検出した場合はfail closedとし、自動上書きしない。
   - `gh release upload --clobber`のような`--clobber`を使用しない。
   - 部分公開のrecoveryはprovider上のresource stateを確認し、削除や差し替えを自動実行しない。
8. 検証済みassetからGitHub Releaseを作成する。
   - authority 入口で検証した approval ID、本文 digest、承認期限を authority artifact で書込jobへ渡し、Release作成の直前に変更と期限切れを再検証する。
   - gitスキルの`git.release-flow`から引き渡された承認済みrelease notesだけを、release tag、検証済みasset、checksumと同じreleaseへ関連付ける。`--generate-notes`は使用しない。
   - handoffで受領した本文を公開入力へそのまま渡し、CLI引数の境界を保持する。タグ注釈、生成機能、別の本文入力へ変換した場合は停止する。
   - 作成結果と後続操作は `release-asset-publication-contract.reference.yml` の `resourceIdentity` に従って結び付ける。
   - 観測は段階で分ける。pre-create の不在は draft を含む全ページの一覧（`inventory`）で確認し、post-create の観測は作成結果の release ID 直参照に限る。tag 走査を post-create の identity 証拠に使わない。
   - `/releases/tags/{tag}` は published release のみを返し draft を返さないため、draft の不在根拠に使わない。
   - release の `created_at` は release に使われた commit の日付であり、作成時刻の判定や冪等判定に使わない。
   - 作成直後の一覧は未反映があり得る（draft の一覧可視性は push access 依存）。一覧の一意性確認は上限回数・上限時間を明示した限定再観測とし、収束しなければ診断（HTTP status、観測 ID・件数）を付けて fail closed とする。
   - publish 段は create-result の release ID、publish receipt、readback evidence を機械可読出力（`release-remote-identity` / `publish-receipt` / `readback-evidence`）として提供し、canonical publish job がこれを露出する。欠落は fail closed とする。
   - provider 操作が失敗した場合は、`release-asset-publication-contract.reference.yml` の `providerPublicationSuitability.failureAttribution` に従って操作単位の診断を残す。必須項目と秘匿対象を本ガイドで再定義しない。
   - 作成後にRelease本文を読み戻し、承認済み本文およびhandoff digestと完全一致することを確認する。不一致または読み戻し不能はfail closedとする。
   - 作成後にrelease tagのcommit、登録asset集合、checksumを再観測し、検証済み入力との一致と同契約の`successState`を確認する。
   - Release作成の成否にかかわらずActions artifactを恒久配布先として案内しない。
9. package補助経路を分離する。
   - package登録は対象プロジェクトの owner 契約で別経路として明示された場合だけ、別のpackage workflowとして構成する。
   - Release assets workflowからpackage registryへ暗黙に二重publishしない。

## project-local実装点

実装義務はprovider registryの `registry.presets` と `actionization.standardImplementations`、bindingの利用可能性は `actionization.targets` を確認する。選択した標準bindingが充足する処理をproject-local scriptとして再実装しない。request記録、platform matrix、build、assembly、read-only観測などの接続はcanonical workflowを参照する。

標準Release入力の受領契約は `ci-script-contracts.reference.yml` の `standardReleaseInput` を参照する。対応する標準profileでは共通read-only authority Actionを使い、個別authority scriptを要求しない。入力未解決または非標準ownerだけproject-owned extensionへ接続する。公開writeは選択した標準bindingが充足する場合に専用Actionへ委譲し、非標準owner経路だけproject-owned adapterを要求する。適用profileと充足extensionはregistryを参照する。対応する入力・出力と責務は `ci-script-contracts.reference.yml`、provider writeのmappingは `release-publication-evidence.reference.yml` を参照する。未公開bindingは導入完了扱いにしない。

## 停止条件
- requestのtag refとsource SHA、`git.release-flow`のtag、target commit、version、tag object SHA、tag object typeの対応を証明できない。
- `git.release-flow`から承認済みrelease notesが引き渡されたことを証明できない、またはrelease notesを生成しようとする。
- release authority contextの必須fieldまたはActions artifact IDが不足する。
- expected platform、asset、version、checksumのいずれかが不足または不一致である。
- build / validate jobが`contents: write`、release token、署名用秘密鍵を要求する。
- Release作成jobが操作対象source、build script、実行可能assetをcheckoutまたは実行しようとする。
- Release作成の直前または作成後に観測したrelease tagのcommitが、検証済みsource SHAと一致しない。
- provider 公開適合を証明できない、または write 直前の再観測で不適合・判定不能となる。
- `release-asset-publication-contract.reference.yml` のいずれかの不変条件を満たさない。
- 同じtagの既存releaseまたは既存assetが存在する。
- development実行可能資材または暗黙のpackage補助経路を公開しようとする。

## 注意
- Release assetsの配布優先度、publish範囲、補助package経路の選択条件を本ガイドへ再定義せず、対象プロジェクトの owner 契約を参照する。
- branch category、tag source、branch ancestry、version policyの意味を本ガイドへ投影せず、gitスキルへ委譲する。tag object と dereferenced commit の identity 検証手順は、この provider 写像の責務として保持する。
- tagやassetの削除、差し替え、`--clobber`を伴うrecoveryは自動化せず、gitスキルまたはprovider権限へ委譲する。
