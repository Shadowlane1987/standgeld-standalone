@echo off
chcp 65001 >nul
title Standgeld-App - Einrichtung
cd /d "%~dp0"

echo ==========================================================
echo   STANDGELD-APP - EINRICHTUNG (einmalig)
echo ==========================================================
echo.
echo Dieses Fenster installiert alles Noetige direkt auf DIESEM
echo Laptop. Es laeuft danach komplett lokal - ohne Cloud.
echo Bitte einfach warten, bis "FERTIG" erscheint.
echo.

REM --- 1) Node.js pruefen / installieren ---
where node >nul 2>nul
if %errorlevel%==0 goto node_ok

echo [1/4] Node.js wird installiert ...
where winget >nul 2>nul
if %errorlevel%==0 (
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
) else (
  echo.
  echo   Automatische Installation nicht moeglich - kein "winget" vorhanden.
  echo   Bitte im geoeffneten Browser die "LTS"-Version installieren
  echo   und danach diese Datei erneut per Doppelklick starten.
  echo.
  start "" "https://nodejs.org/de/download"
  pause
  exit /b 1
)

REM PATH fuer diese Sitzung um den Standard-Node-Pfad ergaenzen
set "PATH=%ProgramFiles%\nodejs;%PATH%"

where node >nul 2>nul
if %errorlevel% NEQ 0 (
  echo.
  echo   Node.js wurde installiert, aber noch nicht gefunden.
  echo   Bitte diese Datei einfach NOCHMAL per Doppelklick starten.
  echo.
  pause
  exit /b 1
)

:node_ok
for /f "delims=" %%v in ('node --version') do echo Node.js gefunden: %%v
echo.

REM --- 2) Programmteile installieren ---
echo [2/4] Installiere Programmteile - kann einige Minuten dauern ...
call npm install
if errorlevel 1 (
  echo.
  echo   [FEHLER] Installation der Programmteile fehlgeschlagen.
  echo   Bitte einen Screenshot machen und melden.
  echo.
  pause
  exit /b 1
)

REM --- 3) Automatik-Browser (Chromium) fuer die App ---
echo [3/5] Installiere Automatik-Browser (Chromium) ...
call npx playwright install chromium

REM --- 4) Google Chrome installieren (best-effort, falls noch nicht da) ---
echo [4/5] Pruefe / installiere Google Chrome ...
where winget >nul 2>nul
if %errorlevel%==0 (
  winget install -e --id Google.Chrome --accept-source-agreements --accept-package-agreements
) else (
  echo   Kein "winget" vorhanden - Google Chrome bitte bei Bedarf manuell installieren.
)

REM --- 5) Konfiguration anlegen, falls nicht vorhanden ---
echo [5/5] Konfiguration pruefen ...
if not exist ".env" (
  if exist ".env.example" copy ".env.example" ".env" >nul
)

echo.
echo ==========================================================
echo   FERTIG! Alles ist eingerichtet. Die App wird gestartet.
echo ==========================================================
echo.

REM App direkt starten, damit nichts mehr von Hand noetig ist
if exist "Standgeld-App starten.cmd" (
  call "Standgeld-App starten.cmd"
) else (
  echo   Startdatei nicht gefunden - bitte Server manuell starten: node server\index.js
  pause
)
exit /b 0
