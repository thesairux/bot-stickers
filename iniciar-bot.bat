@echo off
REM Doble clic para prender el bot de stickers.
cd /d "%~dp0"
title Bot de stickers (no cierres esta ventana)
npm start
echo.
echo El bot se detuvo. Presiona una tecla para cerrar.
pause > nul
