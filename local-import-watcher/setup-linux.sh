#!/bin/bash
# Einmaliges Setup fuer Linux-Server (z.B. Oracle Cloud Free-Tier-VM).
# Installiert yt-dlp, ffmpeg (statischer Build, keine Repo-Abhaengigkeiten) und Node.js.
set -e
cd "$(dirname "$0")"

echo "Lade yt-dlp herunter..."
sudo curl -sL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

echo "Lade ffmpeg herunter (statischer Build, kann 1-2 Minuten dauern)..."
curl -sL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" -o /tmp/ffmpeg.tar.xz
mkdir -p /tmp/ffmpeg_extract
tar xf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg_extract --strip-components=1
sudo cp /tmp/ffmpeg_extract/ffmpeg /usr/local/bin/ffmpeg
sudo chmod a+rx /usr/local/bin/ffmpeg
rm -rf /tmp/ffmpeg.tar.xz /tmp/ffmpeg_extract

echo "Installiere Node.js 20..."
sudo dnf module install -y nodejs:20 -y 2>/dev/null || sudo dnf install -y nodejs

echo ""
echo "Fertig! Versionen:"
yt-dlp --version
ffmpeg -version | head -1
node --version

echo ""
echo "Naechster Schritt: sudo ./install-service.sh   (richtet den Dauerbetrieb ein)"
