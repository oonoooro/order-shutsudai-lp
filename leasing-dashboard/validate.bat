@echo off
rem データ検証スクリプト（Windows）
chcp 65001 >nul
cd /d "%~dp0"
node scripts\validate-data.js %*
exit /b %errorlevel%
