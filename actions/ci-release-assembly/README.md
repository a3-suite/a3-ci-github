# ci-release-assembly

Release build manifest と owner 検証済み補助 handoff を照合し、provider-write-free に公開 handoff を組み立てます。

## 契約

公開入力・出力は [action.yml](action.yml)、GitHub 固有の evidence shape は [evidence.schema.json](../../runtime/release-publication/evidence.schema.json) を正本とします。処理意味は `ci.script-contracts#release-assembly-scripts` に従います。

`runs.using: node24` と bundle 済み `dist/index.js` で実行します。consumer 側の Node 準備・依存 package の install、source の実行、provider write はありません。公開状態と固定参照は[preset registry](../../skills/ci-github/references/ci-github-preset-assets.reference.yml)を正本とします。

`authority-path` の既存 authority に `publication`（schema の identity）と `config_snapshot_digest` を追加します。publication の source_sha / version / target_identity は authority の同名 field と一致し、repository は Action 入力と一致する必要があります。owner authority が検証済み tag object と承認済み本文 digest を投影します。意味契約や承認を新たに発行しません。

platform matrix は authority job の `ci-platform-matrix` 出力をそのまま渡します。manifest の exact bytes は authority の `platform_manifest_sha256` と照合します。build root の子ディレクトリは `release-build-{id}` に完全一致し、各 platform は既存 build manifest の asset 一つと checksum を持ちます。

## 補助 handoff

補助 asset を選択したときだけ `supplemental-root` を渡します。owner adapter が `supplemental-manifest.json` を生成します。

- root: `schema_version: "1"`, `kind: "ci-github-supplemental-handoff"`, `owner_contract`, `source_sha`, `version`, `assets`
- per asset: `path`, `sha256`, `checksum_path`, `owner_evidence_path`, `owner_evidence_sha256`, `provenance_path`, `verification_path`
- checksum_path は asset path + `.sha256`。checksum ファイルは `digest  name\n`。
- verification_path は owner の意味検証後に生成する結合確認 envelope: `status: "success"`, `owner_contract`, `source_sha`, `asset_sha256`, `owner_evidence_sha256`, `provenance_sha256`。

owner evidence と provenance は opaque な exact bytes として digest だけを照合します。installer record の内部意味は解釈せず、owner 検証結果を再発行しません。envelope は同じ実行の owner adapter から artifact ID で取得した handoff に含める必要があります。未信頼 source による自己申告を owner 検証として扱いません。

## 出力と停止

新 directory に assets/、evidence/、manifest.json、assembly.json、handoff.json を作ります。evidence は監査用 handoff へ保持し、Release に公開する集合は assembly.assets だけです。

JSON は 1 MiB、platform manifest は 64 KiB、公開 asset は checksum を含め最大256、各 asset は2 GiB、合計8 GiBです。通常ファイルだけを受け付け、symlink・traversal・未知 manifest field・不一致・衝突・既存出力は停止します。失敗時に成功出力は出しません。出力途中の失敗は新 directory を部分状態として残し、再実行で上書きしません。

既存形式互換、project-local fallback、installer 意味検証、consumer 移行は提供しません。
