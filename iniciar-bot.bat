@echo off
REM Doble clic para prender el bot de stickers.
chcp 65001 > nul
cd /d "%~dp0"
title Bot de stickers - no cierres esta ventana

where node > nul 2>&1
if errorlevel 1 (
  echo No encuentro Node.js. Si lo acabas de instalar, reinicia el computador y prueba de nuevo.
  echo Presiona una tecla para cerrar.
  pause > nul
  exit /b 1
)

if not exist node_modules (
  echo Instalando dependencias por primera vez...
  call npm install
)

node src\index.js

echo.
echo El bot se detuvo. Si arriba hay un error, sacale una foto.
echo Presiona una tecla para cerrar.
pause > nul
