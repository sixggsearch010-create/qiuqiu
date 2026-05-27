@echo off
setlocal

cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8080"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is required to run the LAN server.
    echo Please install Node.js 16 or newer, then run this script again.
    start "" "https://nodejs.org/"
    pause
    exit /b 1
)

if not exist "node_modules\ws\package.json" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo Failed to install dependencies.
        pause
        exit /b 1
    )
)

for /f "delims=" %%F in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath (Get-Location) -Filter *.html | Select-Object -First 1 -ExpandProperty FullName"') do set "GAME_HTML=%%F"

if not defined GAME_HTML (
    echo No HTML game file was found in this folder.
    pause
    exit /b 1
)

echo Starting LAN server on ws://localhost:%PORT%
start "qiuqiu server" /D "%~dp0" cmd /k "node server.js %PORT%"

timeout /t 2 /nobreak >nul
start "" "%GAME_HTML%"

echo.
echo The server window stays open for LAN multiplayer.
echo Close the server window when you are done playing.
exit /b 0
