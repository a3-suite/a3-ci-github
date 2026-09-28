# CI 実行効率ポリシー

## 理解できること
- 品質保証を維持したまま重複実行を抑止する条件
- publish 実行を置換せず直列化する条件
- 判定不能時に検証を省略しない条件

## 目的
- 品質保証を無料枠削減より優先し、後続実行で完全に置換できる通常 CI だけを抑止する。
- 設計、レビュー、監査で使う実行最適化判断を一元化する。

## 不変条件
- required check は最新commit SHAに対する必要な検証を完了しなければならない。
- 判定不能、権限不足、対象不一致では省略せず、従来の検証経路へ戻す。
- 差分判定や project-local owner 契約の事前結果は、必要な build、test、成果物検証を弱める根拠にしない。
- 公開処理では、事前結果にかかわらず公開直前の binding と非上書き検証を省略しない。

## 重複実行のキャンセル
- 実行中 run の置換は、同じPRの先行通常 CI で、後続実行が先行実行を置き換えられる場合だけ許可する。post-merge の通常 CI は置換対象にしない。provider 固有の設定名は provider 固有スキルへ写像する。
- concurrency groupはworkflowとPR番号などの論理対象で構成し、commit SHAを含めない。置換を行わない経路は group を run 単位に分離し、後続 run が先行 run を置換しないようにする。
- release、publish、deploy、recovery、手動運用は置換可能とみなさず、自動キャンセルの対象外とする。
- publish は置換を無効にした target 単位の直列化キューで、provider 上限内の実行中・待機中 run を置換せず順番に実行する。キュー設定の具体的な構文は provider 固有スキルへ委譲する。
- provider queue上限を超えるrunは保持を保証できないため、上限超過を「非キャンセル」と表現しない。上限超過で置換された run は job を実行しないため workflow summary では観測できず、provider の run status（cancelled）を観測経路とする。
- キャンセル後も最新commit SHAのrequired checkが全検証を完了する構成を維持する。

## project-local 事前判定
- 対象プロジェクトの owner 契約が、入力 identity と結合した read-only の事前判定を提供する場合だけ利用できる。
- 事前判定の意味、provider 固有の観測方法、停止条件は CI で定義しない。
- 判定不能または入力との結合を証明できない場合は従来の build / validate へ進む。
- 事前判定を使用しても、公開直前の binding、非上書き検証、公開後観測は省略しない。

## platform 別検証のスコープ
- 全 suite を全 platform で重複実行しない。platform 独立の検証は代表 platform で1回実行し、platform 固有の検証だけを追加する。
- platform ごとの対象外は、適用条件と理由コードを伴う明示的な判定とし、暗黙の skip にしない。
- 抑止しても required check の期待 record 集合を減らさない。期待 record は実行前に確定し、欠落を success に読み替えない。

## 適用判定
- 抑止対象が後続実行で完全に置換されるか確認する。
- 省略判断の入力が trusted かつ一意か確認する。
- 判定不能時の fallback が品質検証を維持するか確認する。
- required check と公開直前の安全確認が残ることを確認する。
