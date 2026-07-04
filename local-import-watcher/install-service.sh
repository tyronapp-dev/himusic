#!/bin/bash
# Richtet den Watcher als systemd-Dienst ein: startet automatisch beim Boot,
# startet automatisch neu bei Absturz, laeuft weiter auch wenn die SSH-Verbindung endet.
set -e
cd "$(dirname "$0")"

sudo cp himusic-watcher.service /etc/systemd/system/himusic-watcher.service
sudo systemctl daemon-reload
sudo systemctl enable himusic-watcher
sudo systemctl restart himusic-watcher

echo ""
echo "Dienst eingerichtet. Status:"
sudo systemctl status himusic-watcher --no-pager -l | head -15

echo ""
echo "Nuetzliche Befehle:"
echo "  Log ansehen:        sudo journalctl -u himusic-watcher -f"
echo "  Neu starten:        sudo systemctl restart himusic-watcher"
echo "  Stoppen:            sudo systemctl stop himusic-watcher"
