@echo off
REM Einmaliges Setup: laedt yt-dlp.exe + ffmpeg.exe in diesen Ordner.
cd /d "%~dp0"

echo Lade yt-dlp.exe herunter...
curl -sL -o yt-dlp.exe "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"

echo Lade ffmpeg herunter (kann 1-2 Minuten dauern)...
curl -sL -o ffmpeg_temp.zip "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"

echo Entpacke ffmpeg...
powershell -Command "Expand-Archive -Path 'ffmpeg_temp.zip' -DestinationPath 'ffmpeg_extract' -Force"
for /d %%D in (ffmpeg_extract\ffmpeg-*) do copy "%%D\bin\ffmpeg.exe" . >nul
del ffmpeg_temp.zip
rmdir /s /q ffmpeg_extract

echo.
echo Fertig! yt-dlp.exe und ffmpeg.exe liegen jetzt in diesem Ordner.
echo Starte den Watcher mit: start.bat
pause
