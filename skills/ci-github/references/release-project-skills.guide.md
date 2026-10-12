# 製品と対応スキルを同じReleaseで提供するガイド

## 目的

製品と同じ固定sourceの公開スキルを同じReleaseで提供し、READMEの取得・配備・削除案内まで整合させる。

## セットアップ

1. 公開スキルを製品repositoryの`skills/<skill-name>/`へ置く。`SKILL.md`のnameはroot名へ揃える。開発用`.agents/skills/`は対象にしない。外部ownerのスキルを複製しない。
2. `assets/examples/release-skills.example.json`を基に`skills/release.json`を作る。`include`には公開するファイルまたはディレクトリだけを指定し、必須の参照・実行資材を`requiredFiles`へ記録する。存在しないサンプルのパスは転記しない。
3. Release publication callerの`release_skills_config_path`を`skills/release.json`にする。同梱しない場合は`__unset__`を使う。installerの選択とは独立して設定する。採用する固定providerのworkflowとActionがこの入力へ対応することを、同じReleaseの配布manifestと固定SHA先で確認する。
4. `references/release-skills-contract.reference.yml`に従い、固定製品sourceからの収録内容、禁止資材の除外、必須fileの充足、ZIPと証跡を確認する。除外規則はruntimeのpolicy JSONを参照し、このガイドへ複製しない。公開scriptsや必要な実行資材は残し、コンパイル残骸の除外で必要資材が欠けた場合は配置・宣言を直す。
5. 同じ製品Releaseへ`<repository-name>-skills.zip`とその`.sha256`を公開する。生成はOS別matrixで繰り返さず、assembleで一度だけ行う。installerを同梱する場合も、各ownerの証跡を個別に保持して同じhandoffへ集約する。別のReleaseは作らない。
6. 製品READMEのインストール節に、任意のAgent Skill導入案内を追加する。installerの`assets/examples/readme-installation.example.md`の該当節を使い、ZIP名・固定Release・案内先を実際の提供内容へ置換する。スキル本文に固定versionを埋め込まず、版対応はReleaseとCI証跡で保持する。

## 取得・配備・削除の案内

- 製品と同じ固定ReleaseのZIPとchecksumを取得し、ZIPのSHA-256を検証してから新しい作業ディレクトリへ展開する。branchやlatestの内容を同じ版として扱わない。
- ZIP直下には公開スキルのrootだけが並ぶ。展開先をsource rootとして、利用者が指定した外部skill rootへの配備を`project-skill-deploy`へ委譲する。利用環境で同CLIを利用できることを確認し、dry-run、明示許可後の反映、再検査まで行う。CLIを利用できない場合は提供済みの導入手順へ案内し、存在しないコマンドをREADMEへ書かない。
- 同名の既存スキルに差分がある場合は更新対象・影響を確認する。管理外スキルや共有rootを削除せず、製品installerからの自動配備は行わない。
- 削除は今回配備したスキルrootだけを対象にする。外部skill root全体や他製品のスキル、製品本体の設定・データは削除対象にしない。
- 製品READMEにはZIPのリンクと実際に利用できる配備手順へのリンク、スキル専用rootだけを削除する短い案内を残す。詳細なCI構造、検証ログ、通常ツールの前提一覧は展開しない。

## 監査

構成監査では宣言、requiredFiles、収録規則、固定provider対応、READMEの同じ製品Releaseへの案内を確認する。installerなし・スキルなしの選択も別々に判断し、同梱しない製品へ案内を要求しない。

証跡監査では、収録一覧・ファイルのsizeとSHA-256、declaration/source/version、ZIP checksum、各ownerの証跡、転送後のhandoffと公開後readbackを確認する。必要file欠落、改変、公開名衝突、版やSHAの不一致は公開停止対象とする。ローカル成功だけでHostedや公開後readbackを確認済みにしない。
