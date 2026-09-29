# ci-jq-provisioner

指定した exact version の jq を公式 Release から検証付きで供給します。

`jq-version` に指定した jq を公式 GitHub Release から取得し、
同じ release の `sha256sum.txt` と照合して job の `PATH` に追加します。
対応する runner は Linux X64/ARM64、macOS X64/ARM64、Windows X64 です。
取得、checksum、配置の失敗は `jq-provision-failed` で停止します。
実行 version の確認は別の verifier Action が担当します。

入力の正本は [action.yml](action.yml) です。
