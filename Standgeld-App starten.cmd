@echo off
title Standgeld App Starter
cd /d "%~dp0"

echo ============================================
echo   Standgeld-App wird gestartet...
echo ============================================
echo.

REM --- 1) Ist Node.js installiert? ---
where node >nul 2>nul
if errorlevel 1 (
  echo [FEHLER] Node.js ist auf diesem PC noch nicht installiert.
  echo.
  echo   1. Im geoeffneten Browser die "LTS"-Version installieren.
  echo   2. Danach diese Datei erneut per Doppelklick starten.
  echo.
  start "" "https://nodejs.org/de/download"
  pause
  exit /b 1
)

REM --- 1b) Neueste Version holen (falls als Git-Projekt eingerichtet) ---
where git >nul 2>nul
if not errorlevel 1 (
  if exist ".git" (
    echo Hole die neueste Version ...
    call git pull --ff-only
  )
)

REM --- 2) Programmteile installieren / aktualisieren ---
if not exist "node_modules" (
  echo [1/3] Installiere Programmteile - einmalig, kann ein paar Minuten dauern ...
  call npm install
  if errorlevel 1 (
    echo.
    echo [FEHLER] Installation fehlgeschlagen. Bitte einen Screenshot machen.
    pause
    exit /b 1
  )
  echo [2/3] Installiere den Browser fuer die Automatik ...
  call npx playwright install chromium
) else (
  echo [1/3] Aktualisiere Programmteile (falls es Neuerungen gibt) ...
  call npm install
)

REM --- 3) Server im minimierten Fenster starten ---
echo [3/3] Starte den Motor ...
start "Standgeld Server" /min cmd /c "node server\index.js"

REM Auf Server warten (max. ca. 20 Sekunden)
set /a tries=0
:wait
timeout /t 1 >nul
set /a tries+=1
powershell -NoProfile -Command "try{Invoke-RestMethod http://localhost:3100/api/health -TimeoutSec 2 | Out-Null; exit 0}catch{exit 1}"
if %errorlevel%==0 goto ready
if %tries% GEQ 20 goto failed
goto wait

:ready
echo Motor laeuft! Oeffne die App im Browser...
start "" "https://standgeld-standalone.onrender.com/batch.html"
echo.
echo Fertig - die App ist offen.
echo Der Motor laeuft im minimierten Fenster "Standgeld Server".
echo Zum Beenden einfach dieses Server-Fenster schliessen.
timeout /t 4 >nul
exit /b 0

:failed
echo.
echo FEHLER: Der Motor konnte nicht gestartet werden.
echo Bitte pruefen, ob Node.js installiert ist:  node --version
echo.
pause
exit /b 1
