@echo off
rem 週次リーシングダッシュボード 起動スクリプト（Windows）
rem   start.bat                     … data\ のデータで起動
rem   start.bat --data sample_data  … 架空サンプルで起動
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 以上が必要です。https://nodejs.org/ からインストールしてください。
  pause
  exit /b 1
)
set "DATA_ARGS="
if "%~1"=="--data" set "DATA_ARGS=--data %~2"
node scripts\validate-data.js %DATA_ARGS%
if errorlevel 1 echo ※ データ検証で問題が見つかりました。画面の「データ検証」タブで詳細を確認してください。
echo.
node scripts\serve.js %*
