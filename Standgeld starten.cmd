@echo off
setlocal enableextensions
title Standgeld Standalone
cd /d "%~dp0"

rem --- Node.js vorhanden? ---
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo FEHLER: Node.js wurde nicht gefunden.
  echo Bitte Node.js installieren: https://nodejs.org
  echo.
  pause
  exit /b 1
)

rem --- Beim allerersten Start Abhaengigkeiten installieren ---
if not exist "node_modules" (
  echo Erststart erkannt - installiere benoetigte Komponenten, bitte warten...
  call npm install
  if errorlevel 1 (
    echo.
    echo FEHLER bei der Installation. Bitte den Text oben pruefen.
    pause
    exit /b 1
  )
)

echo.
echo ================================================
echo   Standgeld-App wird gestartet...
echo   Der Browser oeffnet sich gleich automatisch.
echo   Zum Beenden einfach dieses Fenster schliessen.
echo ================================================
echo.

rem --- Browser nach kurzer Wartezeit oeffnen (Server braucht ein paar Sekunden) ---
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:3100'"

rem --- Server starten (haelt dieses Fenster offen = App laeuft) ---
node server/index.js

echo.
echo Der Server wurde beendet.
pause
