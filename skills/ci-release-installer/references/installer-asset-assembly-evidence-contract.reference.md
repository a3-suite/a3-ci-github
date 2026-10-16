# インストーラ asset 組立証跡契約

契約ID: `installer.asset-assembly-evidence-contract`

## 理解できること
- CI など installer 外で組み立てた installer asset に残す証跡
- installer 側が要求する asset identity、checksum、manifest、provenance、検証結果の境界
- CI workflow、release publish、配布 gate と混同しない責務分離

## 目的
- 組立済み installer asset を、利用者が取得する公開候補として扱う前に、検証済み入力と実行対象 asset の一致を証明できる証跡を固定する。

## 責務
- installer 側は、組立済み asset の identity、manifest checksum、asset checksum、payload checksum、provenance、組立後検証結果の証跡契約を定義する。組立前の source / manifest 検証結果を、組立後検証結果として扱わない。
- CI workflow の trigger、job 分割、runner trust、permissions、cache、release publish 手順、release gate の実行タイミングは ci スキルの責務として扱う。
- 証跡は installer の実行成功を代替しない。証跡は、配布される asset が検証対象と同一であることを示す。
- 組立証跡（candidate / verification / final evidence）は公開 asset と対応付けて保持する。保持先は CI artifact または Release 添付とし、具体手段は ci スキルの責務として扱う。
- 証跡は project 内で実行できる builder / fixture と同じ入力契約から生成または検証できるようにする。
- installer source と manifest は UTF-8 テキストとし、starter の builder（`build-installer.py`、`build-shared-wrapper.py`）は LF へ正規化してから snapshot、checksum、組立を行う。checkout の改行コードは入力同一性の差として扱わない。
- 検証済み payload（shared wrapper に埋め込む platform installer など）は opaque な入力として扱い、正規化せず exact checksum だけを拘束する。どの入力を正規化するかのバイト規則は starter の builder 実装を正本とし、本契約では再定義しない。
- 入力の正規化規則を変更した場合は builder identity の version を上げ、変更前の identity で作られた candidate を finalize しない。

## 証跡 record
組立済み asset の証跡 record は、次の項目を持つ。

| 項目 | 意味 |
| --- | --- |
| asset name | 利用者が取得する installer wrapper または payload archive の名前 |
| asset checksum | 利用者が取得する asset の checksum |
| payload checksum | wrapper と payload archive を分ける場合の payload checksum |
| manifest checksum | asset が参照または内包する manifest の checksum |
| source commit / tag | asset の生成元 revision |
| CI run id or assembly id | asset を組み立てた実行単位の識別子 |
| builder identity | project 内でも実行できる builder の識別子または version |
| verification result | 組立済み asset の checksum、source revision、manifest checksum、installer source checksum に結び付いた smoke または fixture subset の結果 |

checksum が対象とするバイトは次のとおりとする。

- asset checksum: 組立済み asset のバイト。
- payload checksum: wrapper と payload archive を分ける場合の payload のバイト。
- manifest checksum: 正規化後 manifest のバイト。
- installer source checksum: 正規化後 installer source snapshot の内容（相対 path、実行ビットの正規化値、ファイル内容）。

## 組立結果ディレクトリ
- 組立結果は project または CI が指定する一時出力ディレクトリへ書き出し、コミットしない（`release.generatedOutputCommitted: false`）。
- 標準ファイル構成:
  - `<installer-asset-name>`: 組立済み installer / wrapper
  - `<installer-asset-name>.sha256`: 上記の checksum
  - `manifest-<target-platform-id>.json`: target-specific の platform manifest
  - `installer-asset-candidate.json`: assemble 時の候補証跡
  - `.installer-source.zip`: finalize の再検証用 source snapshot（正規化後の installer source を保持）
  - `installer-verification-evidence.json`: finalize が入力の検証証跡をコピーしたもの
  - `installer-asset-evidence.json` と `.sha256`: finalize で確定する最終証跡
- shared wrapper では platform installer を別出力で先に組み立て、wrapper 出力には wrapper と上記証跡を置く。
- ライフサイクルは assemble → project 検証 → finalize の順とし、finalize は候補と検証証跡を照合して最終証跡を確定する。
- 同梱の target-specific / shared wrapper builder では、project 検証の証跡ファイルを組立結果ディレクトリの外に生成し、`finalize --verification-evidence` へ渡す。出力側の検証証跡と最終証跡は finalize が作成するため、事前に配置しない。これらの証跡ファイルが既にある場合は上書きせず停止する。

## 境界
- asset 組立証跡は、release publish の可否、GitHub Release の作成、tag 作成、workflow の成否判定を定義しない。
- smoke または fixture subset の選択は、installer fixture baseline と coverage matrix に接続する。
- 組立処理は候補 asset と checksum を先に生成し、project owner がその exact asset を検証した後にだけ最終証跡 record を確定する。
- 証跡 record に secret、token、認証 header、runner 固有の一時 path を残さない。
- 組立済み asset と証跡 record の checksum が一致しない場合、配布対象として扱わない。
- project override で別の証跡形式を使う場合も、asset checksum、manifest checksum、provenance、verification result を欠落させない。

## 受け入れ条件
- 組立済み asset、manifest、payload、provenance、検証結果が同じ証跡 record で対応付けられている。
- 証跡recordのchecksumがhandoffに含まれ、組立後から公開前まで一致している。
- project 内テストで使う builder / fixture と CI など installer 外の組立処理が、同じ入力契約を共有している。
- verification result が組立済み asset の checksum、source revision、manifest checksum、installer source checksum と一致している。
- 同一論理の installer source と manifest は、checkout や runner の改行コードに依存せず同じ asset checksum、manifest checksum、installer source checksum になる。
- 証跡不足は installer 実行失敗ではなく、公開候補 asset の証跡不足として報告される。
- workflow trigger、job、permissions、cache、release publish 手順を installer 側の契約として再定義していない。

## 共有 wrapper の証跡
- 共有 wrapper を配信する場合、証跡 record は wrapper asset の checksum と、各 platform installer asset の checksum を同じ record で対応付ける。
- wrapper の verification result は、wrapper checksum、source revision、platform installer checksums に結び付ける。
- platform installer は検証済み payload として扱い、wrapper 実行前に checksum を検証する。

## fixture baseline の扱い
- asset 組立証跡に対する fixture の入力、期待結果、残存状態は、インストーラ fixture baseline を正本とする。
- coverage matrix は、本契約と fixture の対応を正本として管理する。
