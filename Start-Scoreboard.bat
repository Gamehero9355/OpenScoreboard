@echo off
REM ============================================================
REM  Tournament Scoreboard - easy starter (double-click this file)
REM  Starts the local server and opens the dashboard in your browser.
REM  Usage: double-click, or: Start-Scoreboard.bat --demo --port 3200
REM
REM  This file is committed with CRLF endings and marked "-text" in
REM  .gitattributes: cmd.exe is handed the bytes that are committed, and a
REM  GitHub ZIP download performs no end-of-line conversion on the way.
REM
REM  Literal parentheses are avoided inside the blocks below: cmd
REM  reads a ")" in echo/REM text inside a block as the end of the block,
REM  which either eats the character or aborts the whole batch.
REM ============================================================
title Tournament Scoreboard
cd /d "%~dp0"

REM --- 1. Node.js check ------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERROR] Node.js was not found.
  echo  Please install Node.js 22.5 or newer from https://nodejs.org/
  echo  Then double-click this file again.
  echo.
  pause
  exit /b 1
)

REM The build tools and the server want a recent Node. On an older release the
REM first failure surfaces deep inside npm, the bundler or the build check,
REM where the cause is not visible -- so compare the version here and say it.
set "NODE_MAJOR=99"
set "NODE_MINOR=0"
for /f "tokens=1,2 delims=v." %%a in ('node --version') do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
)
if not defined NODE_MAJOR set "NODE_MAJOR=99"
if not defined NODE_MINOR set "NODE_MINOR=0"
set "NODE_OLD="
if %NODE_MAJOR% LSS 22 set "NODE_OLD=1"
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 5 set "NODE_OLD=1"
if defined NODE_OLD (
  echo.
  echo  [WARNING] Node.js 22.5 or newer is recommended. This PC has:
  node --version
  echo  The scoreboard tries to continue. If the build or the server fails,
  echo  update Node.js from https://nodejs.org/ and run this file again.
  echo.
)

REM --- 2. Dependencies check -------------------------------------------
REM express is needed to run, vite and typescript to build. Checking only
REM express let an install without the build tools -- "npm install --omit=dev",
REM or an interrupted first start -- through to a build that could not work.
set "NEED_INSTALL="
if not exist "node_modules\express\package.json" set "NEED_INSTALL=1"
if not exist "node_modules\vite\package.json" set "NEED_INSTALL=1"
if not exist "node_modules\typescript\package.json" set "NEED_INSTALL=1"
if defined NEED_INSTALL (
  echo  First start: installing dependencies, this takes a minute...
  echo.
  REM --no-audit and --no-fund: the audit summary is about the build tooling
  REM -- Electron, electron-builder and Vitest -- never about the scoreboard.
  REM The server runs on express, qrcode and ws, and "npm audit --omit=dev"
  REM is clean, but on a first start the summary reads like a failed install.
  REM --loglevel=error keeps that tooling's deprecation notices out of the way
  REM as well; real errors and a failed install are still printed.
  call npm.cmd install --no-fund --no-audit --loglevel=error
  if errorlevel 1 (
    echo.
    echo  [ERROR] "npm install" failed. Check your Node.js installation and
    echo  your internet connection; the first start needs it once. Then run
    echo  this file again.
    echo.
    pause
    exit /b 1
  )
)

REM --- 3. Build check ---------------------------------------------------
REM The app runs out of dist\, so a source fix that was never built stays
REM invisible however often the server is restarted. Ask whether anything the
REM build reads is newer than the last bundle, and rebuild when it is.
REM Exit code 0 means up to date; anything else -- stale, no build yet, or the
REM check itself failing -- means rebuild, so a broken check can never leave
REM the launcher starting a server whose dist\ is missing.
node "%~dp0scripts\needs-build.mjs"
if errorlevel 1 (
  echo  Building the app, this takes a few seconds...
  echo.
  call npm.cmd run build
  if errorlevel 1 (
    echo.
    echo  [ERROR] "npm run build" failed. Run "npm run typecheck" for details.
    echo.
    pause
    exit /b 1
  )
)

REM --- 4. Start ----------------------------------------------------------
echo.
echo  Starting Tournament Scoreboard...
echo  The dashboard opens automatically. Keep this window open while playing.
echo  Press Ctrl+C to stop the server.
echo.
node "dist\server\backend\index.js" --open %*

REM --- 5. Keep window open on crash so the error can be read ------------
if errorlevel 1 (
  echo.
  echo  The server stopped with an error. The messages above say why.
  echo.
  pause
)
