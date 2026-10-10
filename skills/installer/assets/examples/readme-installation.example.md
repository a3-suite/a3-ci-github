# READMEのインストール・アンインストール節サンプル

`<...>`を実際の製品情報へ置き換えて転用する。この例は、固定providerがUnix共有入口とWindows PowerShell 5.1以降へ対応することを確認できた場合に使う。対応確認は`references/use-standard-installer.guide.md`の「固定providerの対応確認」に従い、未対応の入口・実行環境を対応済みとして転記しない。未提供のOSは掲載しない。

削除例は`per-user-cli`・`standalone`の標準配置を対象とする。パスは製品manifestのlauncher・managed rootへ合わせ、製品専用の領域だけを削除する。別配置の設定・データがある場合は、残るかどうかを製品情報に合わせて明記する。

前提の記載は`references/use-standard-installer.guide.md`の「READMEに残す内容」に従う。追加準備が不要なら前提の段落自体を削除し、通常使えるツールの説明を補わない。これらの転用説明は製品READMEへ掲載しない。

---

## インストール

対応環境：<対応OS・CPU>。

<別途導入・設定が必要な場合だけ、その準備を記載。不要ならこの段落を削除>

### Linux・macOS

```sh
curl -fsSL --proto '=https' --proto-redir '=https' '<固定Releaseの共有wrapper HTTPS URL>' | sh
```

### Windows

Windows PowerShell 5.1以降で実行します。

```powershell
powershell -ExecutionPolicy Bypass -c "irm '<固定Releaseの対象別PowerShell installer HTTPS URL>' | iex"
```

### 起動確認

配置先：<OS別のmanaged root>。起動ファイル：<OS別のlauncherのパス>。

必要に応じて`<launcherのディレクトリ>`をPATHへ追加し、次を実行してください。

```text
<製品の起動確認コマンド>
```

期待する結果：<出力または動作>。

## アンインストール

実行中のCLIとインストーラを終了し、次を実行してください。インストール先の全バージョンと管理情報を削除します。残したいファイルがある場合は事前に退避してください。

### Linux

```sh
rm -f "$HOME/.local/bin/<binary>"
rm -r "$HOME/.local/share/<vendor>/<app>/standalone"
```

### macOS

```sh
rm -f "$HOME/.local/bin/<binary>"
rm -r "$HOME/Library/Application Support/<vendor>/<app>/standalone"
```

### Windows

```powershell
Remove-Item -LiteralPath "$env:LOCALAPPDATA\Programs\<vendor>\<app>\bin\<binary>.exe"
Remove-Item -LiteralPath "$env:LOCALAPPDATA\<vendor>\<app>\standalone" -Recurse -Force
```

追加した製品専用のPATH項目があれば削除してください。共有の`~/.local/bin`は残してください。
