# SharePoint でダッシュボードを共有する手順

管理者への依頼や Power Apps を使わずに、ダッシュボードの内容を SharePoint の URL で共有する手順です。Microsoft 365 Copilot と組み合わせて使います。

## パッケージ

`leasing-dashboard-sharepoint.zip`（`npm run package` で作成）に、必要なものをまとめています。実データは入っていません。

| フォルダ | 中身 |
|---|---|
| `README_FIRST.txt` | 最初に読む手順の要約 |
| `1_sharepoint/` | SharePoint に置く Excel の見本（架空データ）。実際に置くのは毎週書き出す `leasing_dashboard.xlsx` |
| `2_dashboard/` | ダッシュボード本体（更新担当者の PC で `index.html` を開く）、自己診断、手順書、架空のサンプルデータ |
| `3_copilot/` | Copilot に貼る・添付する指示文と手順書（`.txt`） |

ZIP は PC に展開して使います。SharePoint 上で `index.html` をクリックしても画面は開かず、ダウンロードされます。複数の更新担当者で共有する場合は、展開したフォルダを更新担当者だけが見られる SharePoint のフォルダに置き、OneDrive で同期して PC 上で開いてください。

## しくみ

```
更新担当者の PC                                SharePoint                        閲覧者
┌───────────────────────────┐             ┌──────────────────────┐         ┌─────────────────────┐
│ index.html（このダッシュボード） │  アップロード │ leasing_dashboard.xlsx │  URL    │ Excel for the web で表示 │
│  ① 週報 Excel をドロップ        │ ─────────▶ │ （毎週同じ名前で置き換え）│ ──────▶ │ 見出しの ▼ で絞り込み     │
│  ② 「SharePoint用Excelを保存」  │  （置換）    │ SharePoint ページ      │         │ Copilot に質問          │
└───────────────────────────┘             └──────────────────────┘         └─────────────────────┘
```

- 週報の解析・集計・チェックは、これまでどおり更新担当者の PC のブラウザ内で行います（外部には送信しません）。
- SharePoint には、集計結果の Excel（`leasing_dashboard.xlsx`）だけを置きます。週報の原本は置きません。
- 毎週、同じフォルダに同じファイル名で置き換えるので、**URL は変わりません**。古い週の内容はバージョン履歴に残ります。

### このダッシュボードの画面（HTML）を、そのまま SharePoint の URL で開けない理由

| 方法 | 結果 | 必要なもの |
|---|---|---|
| `index.html` をドキュメント ライブラリに置いて開く | 開かずにダウンロードされる（SharePoint Online は HTML を既定で「厳格」に扱うため） | — |
| `.aspx` に名前を変えて置く | サイト所有者などが名前を変えた場合だけ開ける。カスタム スクリプトが許可されていないサイトでは使えない | サイト所有者権限、カスタム スクリプトの許可（管理者。許可しても 24 時間で「ブロック」に戻る） |
| SharePoint Framework（SPFx）の Web パーツにする | 同じ画面を SharePoint ページに組み込める | アプリ カタログへの登録（管理者） |
| Power Apps で作り直す | 同様の画面を作れる | Power Apps の利用 |

管理者への依頼と Power Apps が使えないため、**Excel レポートを SharePoint で共有する方法**にしています。

## Excel レポートの内容

| シート | 内容 |
|---|---|
| サマリー | 対象週、全体の戸数・稼働率・申込反映後稼働率と前週比、今週の住戸の動きの件数、集計の状態（確定／暫定） |
| 物件一覧 | 物件ごとの戸数・稼働率（バー表示）・空室率と前週差・申込・解約予定・データ確度（色分け）・アラート。マスターにあってデータのない物件も「この週のデータなし」で残す |
| 空室率 | 空室率の高い順。前週差と「上昇」の印 |
| 長期空室 | どの物件のどの住戸が何日空いているか（長い順、90 日以上に「長期」） |
| 申込・解約 | 今週の新規申込・申込取消・新規解約の住戸と日付、判定根拠 |
| 条件変更 | 住戸ごとの募集賃料・AD・FR などの変更前と変更後 |
| 工事 | リノベ・原状回復中の住戸、開始日・完了予定日・残り日数・状況（完了予定超過を赤） |
| アラート | 9 区分のアラートと「判定不可」 |
| 対応事項 | Action Points（ある場合だけ） |
| データ検証 | ファイルごとの処理結果・データ確度・要確認理由 |
| データのない物件 | マスターにあって、その週のデータがない物件（ある場合だけ） |

- どのシートも、1 行目が見出し（固定）で、見出しの ▼ から絞り込み・並べ替えができます。
- 物件マスターに TMK・担当者などの列があれば、各シートの物件名の右に同じ列が入ります（担当者のイニシャルで絞り込めます）。
- 「データなし」は値が取得できなかったもので、0 ではありません。比率は小数第 1 位、金額は万円です（ダッシュボードと同じ）。
- 表示中の基準週について、**絞り込みに関係なく全物件**を書き出します。

## 準備（最初の 1 回）

### 1. SharePoint にフォルダを作る

1. 共有したい SharePoint サイトの「ドキュメント」を開きます。
2. 「新規」→「フォルダー」で `リーシングダッシュボード` などのフォルダを作ります。
3. 権限: 更新担当者は「編集」、閲覧者は「表示」にします（フォルダの「アクセス許可の管理」）。

### 2. 最初の Excel を作ってアップロードする

1. 更新担当者の PC で `index.html` を Edge または Chrome で開き、その週の週報 Excel と `property_master.csv` をドロップします。
2. 画面右上の **「SharePoint用Excelを保存」** を押します。ダウンロード フォルダに `leasing_dashboard.xlsx` が保存されます。
3. 1. のフォルダを開き、「アップロード」→「ファイル」で `leasing_dashboard.xlsx` を選びます。
4. アップロードしたファイルの「…」→「リンクのコピー」で URL を控えます。**この URL を閲覧者に共有します。**

### 3. SharePoint ページを作る（任意）

サイトのページから見られるようにする場合です。

1. サイトの「新規」→「ページ」で、空白のページを作ります。タイトルは「週次リーシングダッシュボード」など。
2. 「＋」→ **「ファイルとメディア」**（ファイル ビューアー）Web パーツを追加し、`leasing_dashboard.xlsx` を選びます。ページには Excel の最初のシート（サマリー）が表示されます。
3. 「＋」→ **「ボタン」** Web パーツを追加し、ラベルを「全シートを開く（絞り込み）」、リンクを 2. で控えた URL にします。
4. 必要なら「テキスト」Web パーツで、使い方（「データなし」は 0 ではない、など）を書きます。
5. 「発行」を押します。

ファイルを置き換えても同じファイルを指しているので、ページを作り直す必要はありません。

## 毎週の更新（更新担当者）

1. `index.html` を開き、その週の週報 Excel をドロップします（マスターを変えた週は `property_master.csv` も）。
2. 「データ検証」タブで、読取失敗・未紐付けのファイルがないか確認します。
3. 「SharePoint用Excelを保存」を押します。
4. SharePoint のフォルダで「アップロード」→ `leasing_dashboard.xlsx` を選び、同じ名前のファイルがあると表示されたら **「置換」** を選びます。
   - 名前を変えたり、別のフォルダに置いたりすると URL が変わります。
   - 前の週の内容は、ファイルの「…」→「バージョン履歴」で見られます。
5. （推奨）「データ検証」タブの「dashboard_data.json を保存」で保存したファイルを、更新担当者だけが見られるフォルダに置いておきます。別の PC で更新するときに `data/` に置くか画面にドロップすると、前週比較を続けられます。

Node.js がある PC では、コマンドでも書き出せます（`data/` の内容から作成。入力ファイルは変更しません）。

```
npm run excel                        # output/leasing_dashboard.xlsx に書き出す
node scripts/export-excel.js --period 20261019   # 基準週を指定
```

## 閲覧者の使い方

1. 共有された URL を開きます（Excel for the web で開きます）。
2. 下のシート見出しで、見たい表を選びます。
3. 見出しの ▼ で絞り込みます（例: 「担当者」で自分のイニシャルだけ、「TMK」で特定の TMK だけ）。
   - 他の人の表示を変えないよう、「表示」タブの **「シート ビュー」→「新規」** で自分用の表示を作ってから絞り込んでください（シート ビューは SharePoint / OneDrive 上のファイルで使えます）。
   - 閲覧のみの権限で絞り込みがどう動くかは、組織の設定によって異なる可能性があります。最初に一度、閲覧者の権限で試してください。
4. 「データなし」は値が取得できなかったもので、0 ではありません。「暫定」と書かれた週は、一部のファイルが読めていない集計です。

## Microsoft 365 Copilot の使い方

### 1. Excel の内容を Copilot に質問する（SharePoint のエージェント）

SharePoint のエージェントは `.xlsx` を参照できます。

1. SharePoint のフォルダで `leasing_dashboard.xlsx` を選び、右上の Copilot（エージェント）アイコンから「エージェントを作成」を選びます。
2. 「編集」→「動作」などの指示欄に、`copilot/sharepoint_agent_instructions.txt` の内容を貼り付けます（「データなし」を 0 として扱わない、などのルール）。
3. 名前を「リーシングダッシュボード Q&A」などにして保存し、閲覧者に共有します。

質問の例:

```
今週、新しく申込が入った住戸と、新しく解約になった住戸を物件ごとに一覧にして。
空室率が前週より上がった物件を、上がった幅の大きい順に教えて。
担当者が HO の物件で、90 日以上空いている住戸は？
リノベ・原状回復中の住戸と完了予定日を、完了予定が近い順に。完了予定を過ぎたものは強調して。
```

ファイルを置き換えると、エージェントは新しい内容をもとに答えます（反映まで時間がかかる場合があります）。

### 2. 週次コメントの下書きを作る（Copilot Chat）

Copilot Chat に `leasing_dashboard.xlsx` を添付して、次のように指示します。

```
添付の週次リーシングダッシュボードから、今週の報告コメントを 5 行以内で書いてください。
- 対象週は「サマリー」シートの「対象週」。
- 「データなし」は 0 ではありません。合計や比較に使わないでください。
- 「暫定」の場合は、そのことを書いてください。
- 書かれていない数値を推測しないでください。根拠のシート名を最後に書いてください。
```

### 3. Excel レポートの内容を変える（Copilot でコードを変更）

列やシートを増やしたい場合は、`report-xlsx.js` を変更します。手順は `COPILOT_GUIDE.md` と同じです（Copilot に `report-xlsx.js` と `AGENTS.md` を添付して指示し、回答を貼り付けて `selftest.html` で確認）。

```
Excel レポートの「長期空室」シートに「募集開始日」の列を追加してください。値がない場合は「データなし」と表示してください。
（添付: report-xlsx.js、AGENTS.md）
```

## うまくいかないとき

- **画面が反応しない・「画面のプログラムを読み込めていません」と出る:** ZIP の中から直接開いているか、`index.html` だけを別の場所にコピーしています。ZIP を右クリック →「すべて展開」し、展開したフォルダ（`2_dashboard`）の `index.html` を開いてください。
- **「まだ表示できるデータがありません」と出る:** 週報 Excel がまだ読み込まれていません。画面の「今の読み込み状況」を確認し、週報 Excel（.xlsx / .xlsm）をドロップしてください。物件マスターだけを先にドロップした場合は保持しているので、続けて週報をドロップすれば紐付けされます。
- **「古い Excel 形式（.xls）」と出る:** Excel で開き、「名前を付けて保存」で `.xlsx` 形式にしてからドロップしてください。
- **ボタンを押しても保存されない:** ブラウザのダウンロードがブロックされていないか確認してください。`selftest.html` で「Excel出力」が OK になるかも確認してください。
- **アップロードで「置換」が出ない:** ファイル名が違います。`leasing_dashboard.xlsx` のままアップロードしてください（ブラウザが `leasing_dashboard (1).xlsx` のように名前を変えた場合は、元の名前に直してからアップロードします）。
- **ページの表示が古い:** ページを再読み込みしてください。ファイルの「バージョン履歴」で最新版がアップロードされているか確認できます。
- **Excel を直接編集してしまった:** 翌週の置換で上書きされます。この Excel は毎週作り直すものなので、メモは別のファイルに書いてください。

## 参考（Microsoft の公開情報）

- HTML ファイルの扱い（厳格／許容）: [Migrating from the permissive browser file handling to the default strict browser file handling](https://learn.microsoft.com/en-us/sharepoint/dev/solution-guidance/security-permissivesetting)、[Migration Assessment Scan Browser File Handling](https://learn.microsoft.com/en-us/sharepointmigration/migration-assessment-scan-browser-file-handling)
- カスタム スクリプト（24 時間で「ブロック」に戻る）: [Allow or prevent custom scripts in SharePoint sites](https://learn.microsoft.com/en-us/sharepoint/allow-or-prevent-custom-script)
- ファイルとメディア（ファイル ビューアー）Web パーツ: [Use the File and Media web part](https://support.microsoft.com/en-us/office/use-the-file-and-media-web-part-e53a9602-e7b3-4fff-9126-de2f18d1900c)
- シート ビュー: [Create and manage Sheet Views in Excel](https://support.microsoft.com/en-us/office/create-and-manage-sheet-views-in-excel-0eea3dc5-d7d1-44c5-a953-25ebfbd6c1a6)
- SharePoint のエージェント（対応ファイル形式に XLSX を含む）: [Frequently asked questions about agents in SharePoint](https://support.microsoft.com/en-us/sharepoint/copilot-in-sharepoint/frequently-asked-questions-about-copilot-in-sharepoint)、[Interact with agents in SharePoint](https://support.microsoft.com/en-us/sharepoint/copilot-in-sharepoint/interact-with-agents-in-sharepoint)
