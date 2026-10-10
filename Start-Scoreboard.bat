@echo off
REM ============================================================
REM  Tournament Scoreboard - easy starter (double-click this file)
REM  Starts the local server and opens the dashboard in your browser.
REM  Usage: double-click, or: Start-Scoreboard.bat --demo --port 3200
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

REM --- 2. Dependencies check -------------------------------------------
if not exist "node_modules\express\package.json" (
  echo  First start: installing dependencies, this takes a minute...
  echo.
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo  [ERROR] "npm install" failed. Check your Node.js installation.
    echo.
    pause
    exit /b 1
  )
)

REM --- 3. Build check ---------------------------------------------------
REM The app runs out of dist\, so a source fix that was never built stays
REM invisible however often the server is restarted. Ask whether anything the
REM build reads is newer than the last bundle, and rebuild when it is.
node "%~dp0scripts\needs-build.mjs"
if not errorlevel 1 (
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
  echo  The server stopped with an error (see above).
  echo.
  pause
)
