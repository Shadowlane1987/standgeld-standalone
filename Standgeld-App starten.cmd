@echo off
title Standgeld App Starter
cd /d "%~dp0"

echo ============================================
echo   Standgeld-App wird gestartet...
echo ============================================
echo.

REM Server im minimierten Fenster starten (dieses Fenster = laufender Server)
start "Standgeld Server" /min cmd /c "node server\index.js"

REM Auf Server warten (max. ca. 15 Sekunden)
set /a tries=0
:wait
timeout /t 1 >nul
set /a tries+=1
powershell -NoProfile -Command "try{Invoke-RestMethod http://localhost:3100/api/health -TimeoutSec 2 | Out-Null; exit 0}catch{exit 1}"
if %errorlevel%==0 goto ready
if %tries% GEQ 15 goto failed
goto wait

:ready
echo Server laeuft! Oeffne die App im Browser...
start "" "http://localhost:3100/batch.html"
echo.
echo Fertig - die App ist offen.
echo Der Server laeuft im minimierten Fenster "Standgeld Server".
echo Zum Beenden einfach dieses Server-Fenster schliessen.
timeout /t 4 >nul
exit /b 0

:failed
echo.
echo FEHLER: Server konnte nicht gestartet werden.
echo Bitte pruefen, ob Node.js installiert ist:  node --version
echo.
pause
exit /b 1
