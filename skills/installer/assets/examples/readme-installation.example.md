# READMEのインストール節サンプル

`<...>`を実際の製品情報へ置き換えて転用する。この例は、固定providerがUnix共有入口とWindows PowerShell 5.1以降へ対応することを確認できた場合に使う。対応確認は`references/use-standard-installer.guide.md`の「固定providerの対応確認」に従い、未対応の入口・実行環境を対応済みとして転記しない。未提供のOSは掲載しない。

---

## インストール

インストーラが配布物を取得・検証し、配置します。アーカイブの手動展開は不要です。

対応環境：<対応OS・CPU>。前提：<必要なツールと権限>。

### Linux・macOS

共通のインストーラがOS・CPUを判定し、対応する配布物を取得・検証してインストールします。

```sh
curl -fsSL --proto '=https' --proto-redir '=https' '<固定Releaseの共有wrapper HTTPS URL>' | sh
```

### Windows

Windows PowerShell 5.1以降に対応しています。コマンドプロンプトまたはPowerShellで実行します。インストーラが製品のZIPを取得・検証・展開します。

```powershell
powershell -ExecutionPolicy Bypass -c "irm '<固定Releaseの対象別PowerShell installer HTTPS URL>' | iex"
```

### 起動確認

必要に応じて`<launcherのディレクトリ>`をPATHへ追加し、次を実行してください。

```text
<製品の起動確認コマンド>
```

期待する結果：<出力または動作>。
