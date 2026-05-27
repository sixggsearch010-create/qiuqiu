@echo off
setlocal

cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8080"
set "VITE_PORT=%~2"
if "%VITE_PORT%"=="" set "VITE_PORT=5173"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is required to run the LAN server.
    echo Please install Node.js 20.19 or newer, or Node.js 22.12 or newer, then run this script again.
    start "" "https://nodejs.org/"
    pause
    exit /b 1
)

node -e "const v=process.versions.node.split('.').map(Number); const ok=(v[0]===20&&v[1]>=19)||v[0]>20; process.exit(ok?0:1)"
if errorlevel 1 (
    echo This project requires Node.js 20.19 or newer, or Node.js 22.12 or newer.
    echo Current version:
    node --version
    pause
    exit /b 1
)

if not exist "node_modules\vite\package.json" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo Failed to install dependencies.
        pause
        exit /b 1
    )
)

echo Starting LAN server on ws://localhost:%PORT%
start "qiuqiu server" /D "%~dp0" cmd /k "node server.js %PORT%"

echo Starting Vite game client on http://localhost:%VITE_PORT%
start "qiuqiu game" /D "%~dp0" cmd /k "npm run dev -- --port %VITE_PORT%"

timeout /t 4 /nobreak >nul
start "" "http://localhost:%VITE_PORT%/小游戏.html"

echo.
echo The server and game windows stay open for LAN multiplayer.
echo Close both command windows when you are done playing.
exit /b 0
