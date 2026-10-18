# 製品と対応スキルを同じReleaseで提供するガイド

## 目的

製品と同じ固定sourceの公開スキルを同じReleaseで提供し、READMEの取得・配備・削除案内まで整合させる。

## 同梱の選択

`references/release-skills-contract.reference.yml`のselectionに従い、公開スキルの有無と製品ownerの選択を確認する。結果は既存の監査レポートへ記録し、選択だけのために新しい設定ファイルを増やさない。

| 公開スキル | 同梱の選択 | CI・READMEの扱い |
| --- | --- | --- |
| なし | 同梱しない | `__unset__`。ZIPとスキル導入案内を要求しない。 |
| あり | 同梱する | 公開宣言を指定し、同じReleaseのZIPとセット導入を案内する。 |
| あり | 同梱しない | `__unset__`。理由を監査レポートへ残し、ZIPの導入案内を掲載しない。 |
| あり | 未確認 | 選択を製品ownerへ確認する。未同梱・監査完了として扱わない。 |

## セットアップ

以下は同梱する場合だけ実施する。

1. 製品repositoryで管理するスキルから、同梱するものを選ぶ。配置場所は任意で、`.agents/skills/`や入れ子のディレクトリも選べる。移動・複製は不要。外部ownerのスキルを複製しない。
2. `assets/examples/release-skills.example.json`を基に公開宣言JSONを作る。標準配置は`.ci/release-skills.json`（`references/ci-runtime-boundary.reference.md`の配置基準）で、別のrepository相対pathも指定できる。`skills[]`へ選択した各rootの`path`を列挙し、repository直下は`.`で指定する。ZIP直下の名前は各`SKILL.md`の`name`から決まり、配置ディレクトリ名には依存しない。同名のスキルは同時選択できない。`include`には公開するファイルまたはディレクトリだけを指定し、必須の参照・実行資材を`requiredFiles`へ記録する。存在しないサンプルのパスは転記しない。
3. Release publication callerの生成時に、planの`--set`で`<release-skills-config-path>`へ宣言JSONのrepository相対pathをJSON文字列として渡す（例：`".ci/release-skills.json"`）。同梱しない場合は`"__unset__"`を渡す。生成済みcallerを手編集しない。installerの選択とは独立して設定する。採用する固定providerのworkflowとActionがこの入力へ対応することを、同じReleaseの配布manifestと固定SHA先で確認する。
4. `references/release-skills-contract.reference.yml`に従い、固定製品sourceからの収録内容、禁止資材の除外、必須fileの充足、ZIPと証跡を確認する。除外規則はruntimeのpolicy JSONを参照し、このガイドへ複製しない。公開scriptsや必要な実行資材は残し、コンパイル残骸の除外で必要資材が欠けた場合は配置・宣言を直す。
5. 同じ製品Releaseへ`<repository-name>-skills.zip`とその`.sha256`を公開する。生成はOS別matrixで繰り返さず、assembleで一度だけ行う。installerを同梱する場合も、各ownerの証跡を個別に保持して同じhandoffへ集約する。別のReleaseは作らない。
6. 製品READMEのインストール節に、製品とセットで使うAgent Skillの必須導入案内を追加する。ci-release-installerスキルのREADMEインストール節の記載例を使い、ZIP名・固定Releaseを実際の提供内容へ置換する。スキル本文に固定versionを埋め込まず、版対応はReleaseとCI証跡で保持する。

## 取得・配備・削除の案内

- 製品と同じ固定ReleaseのZIPとchecksumを取得し、ZIPのSHA-256を検証してから新しい作業ディレクトリへ展開する。branchやlatestの内容を同じ版として扱わない。
- ZIP直下には公開スキルのrootだけが並ぶ。展開した各スキルrootを、利用者環境の適切なスキルフォルダへ配置する。専用の配備CLIは前提にしない。
- 同名の既存スキルに差分がある場合は更新対象・影響を確認する。管理外スキルや共有rootを削除せず、製品installerからの自動配備は行わない。
- 削除は今回配備したスキルrootだけを対象にする。外部skill root全体や他製品のスキル、製品本体の設定・データは削除対象にしない。
- 製品READMEの案内は`references/release-skills-contract.reference.yml`の`adoption.readme`に従い、ZIPのリンクを含める。詳細なCI構造、検証ログ、通常ツールの前提一覧は展開しない。

## 監査

構成監査ではまず「同梱の選択」を確認し、CI設定とREADMEへの一致を検査する。同梱する場合は選択rootとSKILL.mdのname、宣言、requiredFiles、収録規則、固定provider対応、READMEの同じ製品Releaseへの案内を確認する。製品と対応スキルをセットで使う場合、READMEのスキル導入を任意扱いにしない。installerなし・スキルなしの配布選択は別々に判断し、対応スキルを提供しない製品へ案内を要求しない。

証跡監査では、収録一覧・ファイルのsizeとSHA-256、declaration/source/version、ZIP checksum、各ownerの証跡、転送後のhandoffと公開後readbackを確認する。必要file欠落、改変、公開名衝突、版やSHAの不一致は公開停止対象とする。ローカル成功だけでHostedや公開後readbackを確認済みにしない。
