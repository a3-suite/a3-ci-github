# ci-gh-provisioner

指定した exact version の GitHub CLI (`gh`) を公式 Release から検証付きで供給します。

`gh-version` に指定した GitHub CLI を cli/cli の GitHub Release から取得し、同じ release の
`gh_<version>_checksums.txt` と照合したうえで、checksum 照合後にだけアーカイブから `bin/gh` を抽出して
job の `PATH` に追加します。対応する runner は Linux X64/ARM64 です。macOS と Windows は別設計とし、
供給の契約に含めません。

取得、checksum、抽出、配置の失敗は `gh-provision-failed` で停止し、未検証の実行ファイルを `PATH` へ
追加しません。実行 version の確認は別の verifier Action が担当します。

入力の正本は [action.yml](action.yml) です。
