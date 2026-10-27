# SharePoint でダッシュボードを共有する手順

管理者への依頼や Power Apps を使わずに、ダッシュボードの内容を SharePoint の URL で共有する手順です。Microsoft 365 Copilot と組み合わせて使います。

社内ファイルは SharePoint にだけ置く運用を前提にしています。週報・物件マスター・履歴・書き出した Excel は、すべて SharePoint のフォルダに置き、PC の「ダウンロード」フォルダやブラウザ内には残しません。

## しくみ

```
SharePoint（ドキュメント ライブラリ）                         閲覧者
リーシングダッシュボード/
├── 公開/  leasing_dashboard.xlsx  ◀─────────────┐        URL で Excel を表示
│                                                │        見出しの ▼ で絞り込み
└── 作業/（更新担当者だけ）                       │ ③ 保存（置換）
    ├── ツール/  index.html ほか ── ① 開く ──▶ ブラウザ（Edge）
    ├── 週報/    その週の週報 Excel ─ ② ドロップ ─▶   ・週報の解析と集計
    ├── マスター/ property_master.csv ─ ② ドロップ ─▶   ・外部へは送信しない
    └── 履歴/    dashboard_data.json ◀─ ④ 保存 ─┘
              （② で一緒にドロップすると前週比較に使う）

※ 作業フォルダは「OneDrive へのショートカット」（または「同期」）で PC のエクスプローラーに表示し、そこから開く・保存する
```

- 週報の解析・集計・チェックは、更新担当者のブラウザの中で行います（外部には送信しません）。
- 保存ボタンを押すと保存先を選ぶ画面が出るので、SharePoint のフォルダ（同期したフォルダ）を選びます。「ダウンロード」フォルダを経由しません（Edge / Chrome）。
- 取込結果はブラウザ内に保存しません（`config.js` の `storage.keepInBrowser: false`）。前週比較に使う履歴は `作業/履歴/dashboard_data.json` に保存し、翌週は週報と一緒にドロップします。
- `公開/leasing_dashboard.xlsx` は毎週同じ名前で置き換えるので、**URL は変わりません**。古い週の内容はバージョン履歴に残ります。
- 同期したフォルダのファイルは、開いたときに PC に一時的に保存されます（OneDrive のファイル オンデマンド）。保存先は SharePoint のままですが、同期の利用が社内ルールで認められているかは、念のため確認してください。

### パッケージ

`leasing-dashboard-sharepoint.zip`（`npm run package` で作成）に、必要なものをまとめています。社内データは入っていません（見本は架空データです）。

| フォルダ | 中身 |
|---|---|
| `README_FIRST.txt` | 最初に読む手順の要約 |
| `1_sharepoint/` | `公開` フォルダに置く Excel の見本（架空データ）。見た目の確認用 |
| `2_dashboard/` | ダッシュボード本体。`作業/ツール` フォルダに中身をアップロードする |
| `3_copilot/` | Copilot に貼る・添付する指示文と手順書（`.txt`） |

SharePoint 上で `index.html` をクリックしても画面は開かず、ダウンロードされます。必ず同期したフォルダから開いてください。

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
2. 「新規」→「フォルダー」で `リーシングダッシュボード` を作り、その中に `公開` と `作業` を作ります。`作業` の中に `ツール`・`週報`・`マスター`・`履歴` を作ります（週報がすでに別の SharePoint フォルダにある場合は、`週報` は作らずそのフォルダを使います）。
3. 権限: `公開` は閲覧者に「表示」、更新担当者に「編集」。`作業` は更新担当者だけに「編集」を付け、閲覧者には付けません（フォルダの「アクセス許可の管理」）。
4. `作業/マスター` に `property_master.csv` をアップロードします。

### 2. ツールを SharePoint に置く

1. `leasing-dashboard-sharepoint.zip` を右クリック →「すべて展開」します（中身はツールと架空データだけで、社内データは含みません）。
2. SharePoint の `作業/ツール` を開き、「アップロード」→「フォルダー」で、展開した `2_dashboard` の**中身**（`index.html` などが入ったフォルダ）を選びます。`index.html` と同じ場所に `app.js`・`config.js` などが並んでいれば OK です。
3. PC に残った ZIP と展開したフォルダは削除します。

### 3. 作業フォルダを PC から開けるようにする

1. SharePoint で `リーシングダッシュボード` フォルダを選び、「OneDrive へのショートカットの追加」を選びます（使えない場合は、ライブラリの「同期」）。
2. エクスプローラーの OneDrive（会社名）の下に `リーシングダッシュボード` が表示されることを確認します。
3. `作業/ツール/selftest.html` を Edge で開き、「すべて OK」になることを確認します。
4. `作業/ツール/index.html` を右クリック →「プログラムから開く」→ Edge で開きます。ブックマークしておくと、翌週から簡単に開けます。

### 4. 最初の Excel を作る

1. `index.html` の画面に、`作業/週報` の週報 Excel と `作業/マスター/property_master.csv` をまとめてドラッグ＆ドロップします。
2. 画面右上の **「SharePoint用Excelを保存」** を押し、保存先に `リーシングダッシュボード/公開` を選びます（ファイル名は `leasing_dashboard.xlsx` のまま）。
3. **「履歴を保存」** を押し、保存先に `作業/履歴` を選びます（`dashboard_data.json`）。
4. SharePoint で `公開/leasing_dashboard.xlsx` の「…」→「リンクのコピー」で URL を控えます。**この URL を閲覧者に共有します。**

### 5. SharePoint ページを作る（任意）

サイトのページから見られるようにする場合です。

1. サイトの「新規」→「ページ」で、空白のページを作ります。タイトルは「週次リーシングダッシュボード」など。
2. 「＋」→ **「ファイルとメディア」**（ファイル ビューアー）Web パーツを追加し、`公開/leasing_dashboard.xlsx` を選びます。ページには Excel の最初のシート（サマリー）が表示されます。
3. 「＋」→ **「ボタン」** Web パーツを追加し、ラベルを「全シートを開く（絞り込み）」、リンクを 4. で控えた URL にします。
4. 必要なら「テキスト」Web パーツで、使い方（「データなし」は 0 ではない、など）を書きます。
5. 「発行」を押します。

ファイルを置き換えても同じファイルを指しているので、ページを作り直す必要はありません。

## 毎週の更新（更新担当者）

1. 週報を `作業/週報` に入れます（マスターを変えた週は `作業/マスター/property_master.csv` も更新）。
2. `作業/ツール/index.html` を Edge で開き、次の 3 つをまとめてドロップします。
   - その週の週報 Excel
   - `作業/マスター/property_master.csv`
   - `作業/履歴/dashboard_data.json`（前週比較に使う。画面に「前回までのデータとして引き継ぎました」と出ます）
3. 「データ検証」タブで、読取失敗・未紐付けのファイルがないか確認します。
4. 「SharePoint用Excelを保存」→ `公開` を選び、`leasing_dashboard.xlsx` を置き換えます。
5. 「履歴を保存」→ `作業/履歴` を選び、`dashboard_data.json` を置き換えます。
6. ブラウザを閉じます（取込結果はブラウザに残りません）。

- 名前を変えたり、別のフォルダに保存したりすると、閲覧者の URL が変わります。
- 前の週の内容は、ファイルの「…」→「バージョン履歴」で見られます。
- 保存先を選ぶ画面が出ないブラウザ（Firefox など）では、「ダウンロード」フォルダに保存されます。Edge か Chrome を使ってください。

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

- **画面が反応しない・「画面のプログラムを読み込めていません」と出る:** `index.html` と同じフォルダに `app.js`・`config.js` などがありません。ZIP の中から直接開いた、`index.html` だけを別の場所にコピーした、などが原因です。`2_dashboard` の中身をまとめて `作業/ツール` にアップロードし、同期したフォルダから開いてください。
- **前週比較が「前週データなし」になる:** `作業/履歴/dashboard_data.json` を週報と一緒にドロップしていません。
- **「まだ表示できるデータがありません」と出る:** 週報 Excel がまだ読み込まれていません。画面の「今の読み込み状況」を確認し、週報 Excel（.xlsx / .xlsm）をドロップしてください。物件マスターだけを先にドロップした場合は保持しているので、続けて週報をドロップすれば紐付けされます。
- **「古い Excel 形式（.xls）」と出る:** Excel で開き、「名前を付けて保存」で `.xlsx` 形式にしてからドロップしてください。
- **ボタンを押しても保存されない:** 保存先を選ぶ画面で「キャンセル」した場合は何も保存しません。Firefox などではダウンロードとして保存されるので、ブロックされていないか確認してください。`selftest.html` で「Excel出力」が OK になるかも確認してください。
- **閲覧者の URL で古い内容が出る:** 保存したファイル名か保存先が違います。`公開` フォルダに `leasing_dashboard.xlsx` の名前のまま保存してください（`leasing_dashboard (1).xlsx` のように名前が変わると別のファイルになります）。OneDrive の同期が終わっているかも確認してください。
- **ページの表示が古い:** ページを再読み込みしてください。ファイルの「バージョン履歴」で最新版がアップロードされているか確認できます。
- **Excel を直接編集してしまった:** 翌週の置換で上書きされます。この Excel は毎週作り直すものなので、メモは別のファイルに書いてください。

## 参考（Microsoft の公開情報）

- HTML ファイルの扱い（厳格／許容）: [Migrating from the permissive browser file handling to the default strict browser file handling](https://learn.microsoft.com/en-us/sharepoint/dev/solution-guidance/security-permissivesetting)、[Migration Assessment Scan Browser File Handling](https://learn.microsoft.com/en-us/sharepointmigration/migration-assessment-scan-browser-file-handling)
- カスタム スクリプト（24 時間で「ブロック」に戻る）: [Allow or prevent custom scripts in SharePoint sites](https://learn.microsoft.com/en-us/sharepoint/allow-or-prevent-custom-script)
- ファイルとメディア（ファイル ビューアー）Web パーツ: [Use the File and Media web part](https://support.microsoft.com/en-us/office/use-the-file-and-media-web-part-e53a9602-e7b3-4fff-9126-de2f18d1900c)
- シート ビュー: [Create and manage Sheet Views in Excel](https://support.microsoft.com/en-us/office/create-and-manage-sheet-views-in-excel-0eea3dc5-d7d1-44c5-a953-25ebfbd6c1a6)
- SharePoint のフォルダを PC から使う（同期・ショートカット・ファイル オンデマンド）: [Sync SharePoint files and folders](https://support.microsoft.com/en-us/onedrive/sync/sharepoint-training/sync-sharepoint-files-and-folders)、[Save disk space with OneDrive Files On-Demand for Windows](https://support.microsoft.com/en-us/office/sync-files-with-onedrive-files-on-demand-1ab17c60-af03-4c63-a24c-bb1e131f76c9)
- 保存先を選ぶ画面（showSaveFilePicker。Edge / Chrome 86 以降、Firefox・Safari は非対応）: [MDN: Window.showSaveFilePicker()](https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker)、[Can I use](https://caniuse.com/mdn-api_window_showsavefilepicker)
- SharePoint のエージェント（対応ファイル形式に XLSX を含む）: [Frequently asked questions about agents in SharePoint](https://support.microsoft.com/en-us/sharepoint/copilot-in-sharepoint/frequently-asked-questions-about-copilot-in-sharepoint)、[Interact with agents in SharePoint](https://support.microsoft.com/en-us/sharepoint/copilot-in-sharepoint/interact-with-agents-in-sharepoint)
