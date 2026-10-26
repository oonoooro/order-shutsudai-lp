# AI アシスタント（Microsoft 365 Copilot など）向けの編集ガイド

このフォルダは、不動産ポートフォリオの週次リーシングダッシュボードです。静的な HTML / CSS / JavaScript だけで動き、ビルドや外部ライブラリはありません。編集するときは、この文書のルールを必ず守ってください。

## 守るべきルール（変更しないこと）

1. **外部通信・外部ライブラリを使わない。** CDN、解析 SDK、外部 API、`fetch` での外部 URL への送信を追加しない。`index.html` の Content-Security-Policy を緩めない。
2. **数値を推測しない。** 欠損は `null` のままにし、0 に置き換えない。表示は `null` →「データなし」、0 →「0」。合計対象がすべて `null` なら合計も `null`。
3. **個人情報を出さない。** 入居者・申込者・契約者・保証会社・仲介担当・年収・メールアドレス・電話番号・個人名を表示・出力しない。列の除外は `config.js` の `privacy` で管理する。
4. **入力ファイルを書き換えない。** 週報 Excel・物件マスター・`dashboard_data.json` は読み取りのみ。出力は新しいファイルとして書く。
5. **物件名は物件マスターを正とする。** 結合キーは Project #。
6. **文字列を HTML として挿入しない。** `innerHTML` などは使わず、`app.js` の `h()`（`textContent` で入れる）を使う。
7. **ファイル名や設定に特定週の日付を書かない。** 対象週は `report_metadata.source_period` から決まる。
8. **変更したら必ず確認し、すべて成功させる。** Node.js がない PC では `selftest.html` をブラウザで開き、すべて OK になることを確認する。Node.js がある場合は `npm test`（画面を変えた場合は `npm run test:browser` も）。

## ファイルの役割

| ファイル | 役割 | よくある変更 |
|---|---|---|
| `config.js` | 表示単位・閾値・稼働率帯・列名の別名・プライバシー・週報解析の設定 | 閾値（長期空室の日数など）、金額単位、列名の別名、絞り込みに使うマスターの列の許可 |
| `index.html` | 画面の骨組み（タブ・フィルター・ドロップ受付） | タブや固定のフィルターの追加 |
| `styles.css` | 見た目（色はファイル先頭の CSS 変数。ライト/ダーク両方） | 色・余白・文字サイズ |
| `app.js` | 画面の描画と操作（タブごとに `renderSummary` / `renderUnits` / `renderList` / `renderAlerts` / `renderDetail` / `renderValidation`） | 表の列、カード、グラフ、文言 |
| `core.js` | 読込・検証・集計・アラート判定・書式（DOM に依存しない） | 計算方法、アラート条件、検証ルール |
| `xlsx.js` | Excel の読込（ZIP と XML を自前で処理） | 通常は変更不要 |
| `ingest.js` | 週報 Excel の様式判定（A〜D）と抽出・標準化 | 新しい様式の追加、見出しの別名の追加 |
| `report-xlsx.js` | SharePoint で共有する Excel レポート（シートごとの表）の作成。`buildReport` | シート・列の追加、列の幅 |
| `xlsx-writer.js` | Excel の書き出し（ZIP と XML を自前で作成。書式・絞り込み・データバー） | 通常は変更不要 |
| `scripts/` | ローカルサーバー・データ検証・週報解析のコマンド | — |
| `tests/` | 自動テスト（データはすべて架空）。`tests/browser/selftest.js` は `selftest.html` で動く自己診断 | 変更に合わせてテストを追加 |
| `selftest.html` | Node.js なしで実行できる自己診断ページ | 確認項目の追加は `tests/browser/selftest.js` |
| `sample_data_schema.json` | 入力データの項目定義 | 項目を増やしたら更新 |

## 変更の手順

1. 変更したい内容が、上の表のどのファイルに当たるかを決める。設定で済むものは `config.js` だけを変える。
2. 既存の書き方（関数の構成、日本語のコメント、`h()` による要素作成）に合わせて変更する。
3. 計算や判定を変えた場合は `tests/browser/selftest.js` に架空データの確認項目を追加する（Node.js がある場合は `tests/` にもテストを追加する）。実在の物件名・社名・人名をテストやサンプルに書かない。
4. `selftest.html` をブラウザで開き、すべて OK になることを確認する（Node.js がある場合は `npm test` も）。
5. `README.md` の該当箇所を更新する。

## よくある変更の場所

- **長期空室の基準日数・稼働率低下の閾値:** `config.js` の `alerts.longVacancyDays`・`alerts.occupancyDropThreshold`
- **稼働率帯の区切り:** `config.js` の `occupancyBands`
- **金額を円表示にする:** `config.js` の `display.moneyUnit` を `'yen'`
- **物件マスターの列で絞り込む:** マスター CSV に列を足すだけで、絞り込みが自動で増える。個人名の可能性がある列は `config.js` の `privacy.allowedMasterColumns` に列名を書いた場合だけ表示する（「担当者」はイニシャルで運用しているため許可済み。氏名の列は許可しない）。
- **物件一覧の列:** `app.js` の `LIST_COLUMNS`
- **KPI カード:** `app.js` の `renderSummary`
- **アラートの区分・条件:** `core.js` の `ALERT_CATEGORIES` と `computeAlerts`
- **SharePoint 用 Excel のシート・列:** `report-xlsx.js` の `buildReport`。セルは部品（`num`・`rate`・`money`・`text`・`none`）で作り、値がないときは「データなし」にする（0 にしない）。ファイル名は `config.js` の `excelReportFileName`（日付を入れない。毎週同じ名前で置き換えて URL を保つ）
- **週報の見出しの表記ゆれ:** `ingest.js` の各様式（`parseA` / `parseB` / `parseC` / `parseD`）の `findHeader` に別名を追加
- **新しい週報の様式:** `ingest.js` の `detectFormat` に判定を追加し、`parseX` を作る。架空のフィクスチャを `tests/fixtures/make_weekly_xlsx.py` に追加してテストする（Python と Node.js が必要。ない場合は様式の見本を添えて開発者に依頼する）。

## 回答の出し方（Copilot 向け）

- 変更は「どのファイルの、どの関数（またはどの設定）を、どう変えるか」を先に説明する。
- 変更後のコードは、関数単位（または設定のブロック単位）で、置き換える範囲の最初と最後の行がわかるように出す。ファイル全体の出力を求められた場合だけ全体を出す。
- ファイルの文字コードは UTF-8 のまま保存するよう利用者に伝える。
- 変更後は `selftest.html` を開いて確認するよう利用者に伝える。
