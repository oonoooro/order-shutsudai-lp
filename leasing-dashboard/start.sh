#!/bin/sh
# 週次リーシングダッシュボード 起動スクリプト（macOS / Linux）
#   ./start.sh                     … data/ のデータで起動
#   ./start.sh --data sample_data  … 架空サンプルで起動
#   ./start.sh --port 8090         … ポート変更
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 以上が必要です。https://nodejs.org/ からインストールしてください。" >&2
  exit 1
fi
DATA_ARGS=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--data" ]; then DATA_ARGS="--data $a"; fi
  prev="$a"
done
# 起動前にデータを検証する（問題があっても画面の「データ検証」で確認できるよう起動は続ける）
# shellcheck disable=SC2086
node scripts/validate-data.js $DATA_ARGS || echo "※ データ検証で問題が見つかりました。画面の「データ検証」タブで詳細を確認してください。"
echo ""
exec node scripts/serve.js "$@"
