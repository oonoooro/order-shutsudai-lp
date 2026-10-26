# Copilot でダッシュボードを編集するときの手順

Microsoft 365 Copilot や GitHub Copilot に指示して、このダッシュボードを変更するための手順と指示文の例です。Copilot が守るべきルールは `AGENTS.md` にまとめています。

## 1. Copilot に渡すもの

- **GitHub Copilot（VS Code など）:** リポジトリを開くと `.github/copilot-instructions.md` が自動で読まれます。最初の指示で「AGENTS.md を読んでから作業して」と伝えると確実です。
- **Microsoft 365 Copilot（チャット）:** 次のファイルを添付するか、OneDrive / SharePoint 上のファイルを指定してください。
  1. `AGENTS.md`（必須。ルールとファイルの役割）
  2. 変更したい内容に当たるファイル（`AGENTS.md` の「よくある変更の場所」を参照）
  3. 必要に応じて `README.md`

  回答に変更後のコードが示されたら、該当ファイルに反映します（「変更後のファイル全体を出力して」と指示すると反映しやすくなります）。そのあと PC で `npm test` を実行し、すべて成功することを確認してください。

## 2. 指示文の例

```
AGENTS.md のルールに従って、config.js を変更してください。
長期空室とみなす日数を 90 日から 60 日に変えてください。変更した箇所を説明してください。
```

```
AGENTS.md のルールに従って、app.js の物件一覧（LIST_COLUMNS）に「申込戸数」の列を追加してください。
表示は他の戸数の列と同じ書式にし、null は「データなし」と表示してください。tests/ に必要なテストを追加してください。
```

```
AGENTS.md のルールに従って、物件マスターの「AM担当」列（イニシャルで管理）でも絞り込めるようにしてください。
個人名の可能性がある列のため、config.js の privacy.allowedMasterColumns に 'AM担当' を追加する方法で行ってください。
```

```
AGENTS.md のルールに従って、週報の様式 A の見出し「募集賃料」が「現募集賃料」と書かれている場合にも読めるように、ingest.js を変更してください。
tests/fixtures/make_weekly_xlsx.py に架空のフィクスチャを追加してテストしてください。
```

## 3. 変更を確認する

```sh
npm test               # 自動テスト（すべて成功すること）
npm run test:browser   # 画面を変えた場合（Playwright がある環境）
./start.sh             # 画面で確認
```

テストが失敗した場合は、エラーの内容を Copilot に貼り付けて「AGENTS.md のルールに従って修正して」と指示してください。
