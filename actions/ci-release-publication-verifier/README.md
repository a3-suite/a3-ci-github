# ci-release-publication-verifier

GitHub Release の不在を観測し、owner write が返した receipt / readback を独立した read-only 観測と照合します。

## 契約と前提

公開 I/O は [action.yml](action.yml)、JSON shape は [evidence.schema.json](../../runtime/release-publication/evidence.schema.json) を正本とします。意味は `ci.release-asset-publication-contract` に従います。`runs.using: node24` と bundle 済み `dist/index.js` を提供し、consumer に Node 準備を要求しません。公開状態と固定参照は[preset registry](../../skills/ci-github/references/ci-github-preset-assets.reference.yml)を正本とします。

workflow は選択済み credential を `GH_TOKEN` 環境変数で注入します。Action は credential の選択・保存・fallback を行わず、GET だけを実行します。token に write 能力があってもこの Action は write しません。draft を含む不在を証明するため GitHub が返す repository permissions.push が true であることを要求します。published-only/read-only token では不在を推測せず停止します。対象 provider は github.com のみです。

## 接続順

1. authority が identity と承認済み本文 digest を確定し、assembly が handoff を生成。
2. `observe-before` が handoff と tag を検証し、全 Release inventory で不在を証明。新 observation-path に証跡を書き、exact byte digest を返す。
3. owner write adapter が observation を受け取り、**write 直前に provider suitability・tag・不在を再観測**し、非上書き create / upload / finalize を実行。
4. owner が create-result の ID に結合した receipt.json と readback.json を生成。
5. `verify-after` が receipt の pre_observation_sha256 を元の観測 bytes と照合し、immutable ID の直参照、tag object / source、本文 digest、asset bytes、draft:false、全 inventory の一意性を独立に確認。owner readback と内容一致した場合だけ公開成功出力を返す。

write adapter は required extension のままです。早期観測は write 直前の再観測や suitability の代替ではありません。競合、create の失敗、部分公開、復旧判断は owner が保持します。自動削除・上書き・再公開はありません。

## inventory / readback

一覧は100件/page、最大100 page。終端 page を確認できない場合や ID 重複は unknown として停止。作成直後の inventory のみ最大3回・1秒間隔で再観測し、別 ID / 複数 Release は即停止。Release ID は tag lookup から推測しません。created_at は判断に使いません。

asset は API の immutable asset ID から取得し、実バイトの SHA-256 と size を照合します。API token を送信する先は api.github.com のみ。asset redirect は HTTPS の release-assets.githubusercontent.com だけを許可し、credential を転送しません。

JSON schema は未知 field を拒否します。観測不能・権限不明・欠落・不一致では成功出力を出しません。API failure は操作、method、秘匿済み endpoint、HTTP status、request ID、秘匿済み reason を診断し、token・response bulk・signed URL は出力しません。

## 検証範囲

ローカル契約テストでは synthetic transport による正常系と停止条件を確認します。実 GitHub の権限・可視性・eventual consistency の Hosted 検証、正式 release 公開、consumer 移行は別受入です。
