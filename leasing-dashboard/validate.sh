#!/bin/sh
# データ検証スクリプト（入力ファイルは読み取りのみ）
#   ./validate.sh                     … data/ を検証
#   ./validate.sh --data sample_data  … 別フォルダを検証
#   ./validate.sh --json              … 結果を JSON で出力
cd "$(dirname "$0")" || exit 1
exec node scripts/validate-data.js "$@"
