@echo off
rem DeepSeek Harness Windows 客户端 一键启动
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [客户端] 首次运行，正在安装依赖（国内镜像）...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [客户端] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo [客户端] 正在启动 DeepSeek Harness ...
start "" "node_modules\electron\dist\electron.exe" "%~dp0"
