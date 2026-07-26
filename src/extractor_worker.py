"""
Himusic Cloud – YouTube Extractor
Läuft auf einem GitHub Actions Ubuntu-Runner.
Ablauf:
  0. Cobalt-Instanz-Pool wird zuerst versucht (siehe ADR-009) – deren eigener Server kontaktiert
     YouTube, nicht dieser Runner, das IP-Reputations-Problem entfällt für diesen Pfad komplett.
     Nur bei Fehlschlag aller Instanzen fällt der Job auf den bisherigen Weg zurück:
  1. yt-dlp lädt beste Audio-Spur als .m4a (Android-Client-Spoofing)
  2. boto3 lädt die Datei per Multipart-Upload nach Cloudflare R2
  3. requests ruft /internal/register am Cloudflare Worker auf
"""

import ipaddress
import json
import math
import os
import random
import re
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

import boto3
import requests
from botocore.config import Config


# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────

def require_env(key: str) -> str:
    val = os.environ.get(key, "").strip()
    if not val:
        gh_error(f"Pflicht-Umgebungsvariable fehlt: {key}")
        sys.exit(1)
    return val


# GitHub-Actions-Annotation (::error::) statt nur print(): Rohe Job-Logs erfordern ein Admin-
# Token zum Abrufen (403 sonst), Annotations dagegen sind über die öffentliche Checks-API
# abrufbar. Damit ist der tatsächliche Fehlertext künftig direkt einsehbar, ohne dass jemand
# Screenshots aus der GitHub-Oberfläche kopieren muss. Newlines/Prozentzeichen müssen für
# Workflow-Commands kodiert werden; auf ~3800 Zeichen gekürzt (Annotation-Längenlimit).
def gh_error(message: str) -> None:
    print(f"[ERROR] {message}", flush=True)
    escaped = message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")[:3800]
    print(f"::error::{escaped}", flush=True)


def gh_notice(message: str) -> None:
    print(f"[INFO] {message}", flush=True)
    escaped = message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")[:3800]
    print(f"::notice::{escaped}", flush=True)


def _diagnose_environment() -> None:
    """Prüft VOR dem eigentlichen Download, ob die beiden Abwehrschichten (PO-Token-Server,
    curl_cffi für --impersonate) wirklich einsatzbereit sind. Als Annotation abrufbar – so lässt
    sich unterscheiden zwischen "Schichten liefen, YouTube blockte trotzdem" (spricht für IP-
    Reputation) und "Schicht war nie aktiv" (spricht für einen Setup-/Timing-Fehler im Workflow)."""
    import socket
    try:
        with socket.create_connection(("127.0.0.1", 4416), timeout=2):
            po_status = "erreichbar"
    except OSError as exc:
        po_status = f"NICHT erreichbar ({exc})"

    try:
        import curl_cffi  # noqa: F401
        cffi_status = "installiert"
    except ImportError as exc:
        cffi_status = f"FEHLT ({exc})"

    ytdlp_version = subprocess.run(["yt-dlp", "--version"], capture_output=True, text=True, timeout=15).stdout.strip()

    gh_notice(
        f"Umgebungs-Check: yt-dlp={ytdlp_version} | PO-Token-Server={po_status} | curl_cffi={cffi_status}"
    )


# ──────────────────────────────────────────────
# Cobalt-Fallback (siehe ADR-009)
# ──────────────────────────────────────────────

# Community-Instanzen von cobalt.tools (Open-Source-Downloader). Jede Instanz kontaktiert
# YouTube mit ihren EIGENEN Cookies/ihrer eigenen IP – wir schicken nur die Video-URL raus, nie
# eigene Zugangsdaten. Live getestet am 2026-07-26 (echter Audio-Download, ID3-Tag verifiziert),
# alle vier ohne Turnstile-Captcha (also automatisierbar ohne Browser). Reihenfolge wird pro Lauf
# zufällig gemischt, damit nicht immer dieselbe Instanz die Last trägt. Community-Betreiber können
# jederzeit abschalten oder überlastet sein – deshalb mehrere statt einer einzigen, und deshalb
# bleibt yt-dlp+Cookies als Sicherheitsnetz bestehen, falls der gesamte Pool ausfällt.
COBALT_INSTANCES = [
    "https://api.cobalt.liubquanti.click",
    "https://cobaltapi.kittycat.boo",
    "https://rue-cobalt.xenon.zone",
    "https://cobaltapi.cjs.nz",
]

_YOUTUBE_URL_RE = re.compile(r"^https://(www\.|m\.)?(youtube\.com/watch\?v=|youtu\.be/)", re.IGNORECASE)

# Harte Obergrenze gegen eine fehlerhafte/kompromittierte Instanz, die endlos oder riesige Daten
# streamt (Platte des Runners volllaufen lassen) – ein einzelner Song braucht dafür nie annähernd
# so viel.
_COBALT_MAX_BYTES = 60 * 1024 * 1024  # 60 MB


def _is_safe_tunnel_url(url: str) -> bool:
    """
    SSRF-Schutz (siehe ADR-009-Review): eine boesartige oder kompromittierte Cobalt-Instanz
    koennte statt einer echten Audio-Tunnel-URL ein internes Ziel zurueckgeben (Cloud-Metadaten-
    Dienst 169.254.169.254, localhost, Intranet-Host) - der Runner/Watcher wuerde das blind
    anfragen. _YOUTUBE_URL_RE oben schuetzt nur die AUSGEHENDE Video-URL, nicht diese
    zurueckkommende. Ein Host-Allowlist (nur derselbe Host wie die API-Instanz) waere zu streng:
    Cobalt-Tunnel liegen haeufig auf einem ANDEREN Host als die API (live beobachtet:
    api.cobalt.liubquanti.click lieferte einen Tunnel auf einem voelling anderen Cobalt-Mirror-
    Host). Deshalb stattdessen: nur https, und die aufgeloeste IP darf nicht in einem privaten/
    reservierten Bereich liegen (RFC1918, loopback, link-local - deckt auch die Cloud-Metadaten-
    Adresse ab).
    """
    try:
        parsed = urlparse(url)
        if parsed.scheme != "https" or not parsed.hostname:
            return False
        for info in socket.getaddrinfo(parsed.hostname, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return False
        return True
    except (socket.gaierror, ValueError, UnicodeError):
        return False


def _ffprobe_duration(file_path: str) -> int:
    """Dauer in Sekunden per ffprobe – Cobalt liefert selbst keine Dauer in der Antwort."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file_path],
            capture_output=True, text=True, timeout=20,
        )
        return int(float(result.stdout.strip()))
    except (ValueError, subprocess.SubprocessError):
        return 0


def try_cobalt_download(youtube_url: str, output_dir: str):
    """
    Versucht den Download über den Cobalt-Instanz-Pool statt direkt über yt-dlp/YouTube.
    Gibt {"path", "title", "duration"} zurück oder None, wenn alle Instanzen scheitern
    (dann übernimmt der Aufrufer den bisherigen yt-dlp-Weg als Fallback).
    """
    if not _YOUTUBE_URL_RE.match(youtube_url):
        return None  # Sicherheitsnetz: nur echte YouTube-URLs gehen an fremde Server raus

    instances = COBALT_INSTANCES[:]
    random.shuffle(instances)

    for base_url in instances:
        try:
            resp = requests.post(
                base_url + "/",
                json={"url": youtube_url, "downloadMode": "audio", "audioFormat": "mp3"},
                headers={"Content-Type": "application/json", "Accept": "application/json"},
                timeout=20,
            )
            if not resp.ok:
                print(f"[INFO] Cobalt-Instanz {base_url} antwortete mit HTTP {resp.status_code}, probiere nächste.", flush=True)
                continue
            data = resp.json()
            # Manche Instanzen liefern bei Fehlern gueltiges JSON, das aber kein Objekt ist
            # (z.B. eine leere Liste oder null) - data.get(...) wuerde dann mit AttributeError
            # crashen, was NICHT vom except-Block unten gefangen wird und den ganzen Job statt
            # nur diese eine Instanz scheitern liesse (Fund aus Security-Review).
            if not isinstance(data, dict):
                print(f"[INFO] Cobalt-Instanz {base_url} lieferte kein JSON-Objekt, probiere nächste.", flush=True)
                continue
            if data.get("status") != "tunnel" or not data.get("url"):
                print(f"[INFO] Cobalt-Instanz {base_url} lieferte keinen Download-Tunnel (status={data.get('status')}), probiere nächste.", flush=True)
                continue
            if not _is_safe_tunnel_url(data["url"]):
                print(f"[INFO] Cobalt-Instanz {base_url} lieferte eine unsichere Tunnel-URL, probiere nächste (SSRF-Schutz).", flush=True)
                continue

            # Titel aus dem von Cobalt vorgeschlagenen Dateinamen ableiten (z.B. "Titel - Kanal.mp3"),
            # analog zur bisherigen Behandlung von YouTube-Titeln als freier Text (siehe ADR-004,
            # _esc() beim Rendern) – hier nur auf sinnvolle Länge begrenzt, kein Escaping nötig
            # (Backend rendert kein HTML, Frontend escaped ohnehin beim Anzeigen).
            raw_name = str(data.get("filename") or "cobalt_import.mp3")
            title = re.sub(r"\.mp3$", "", raw_name, flags=re.IGNORECASE).strip()[:300] or "YouTube Import"

            audio_path = os.path.join(output_dir, "cobalt_audio.mp3")
            with requests.get(data["url"], stream=True, timeout=60) as dl:
                if not dl.ok:
                    print(f"[INFO] Cobalt-Tunnel von {base_url} lieferte HTTP {dl.status_code}, probiere nächste Instanz.", flush=True)
                    continue
                written = 0
                with open(audio_path, "wb") as f:
                    for chunk in dl.iter_content(chunk_size=1024 * 256):
                        written += len(chunk)
                        if written > _COBALT_MAX_BYTES:
                            raise ValueError(f"Cobalt-Tunnel lieferte mehr als {_COBALT_MAX_BYTES // 1024 // 1024} MB, abgebrochen (Sicherheitslimit)")
                        f.write(chunk)

            # Mini-Plausibilitätscheck: echte MP3s beginnen mit "ID3" (v2-Tag) oder dem Frame-Sync
            # 0xFFFB/0xFFFA – schützt davor, eine HTML-Fehlerseite als "Song" hochzuladen.
            with open(audio_path, "rb") as f:
                header = f.read(3)
            if written < 10_000 or not (header == b"ID3" or header[:2] in (b"\xff\xfb", b"\xff\xfa")):
                print(f"[INFO] Cobalt-Instanz {base_url} lieferte keine plausible Audiodatei ({written} Bytes), probiere nächste.", flush=True)
                continue

            duration = _ffprobe_duration(audio_path)
            print(f"[INFO] Cobalt-Download über {base_url} erfolgreich: {title} ({written / 1024:.0f} KB, {duration}s)", flush=True)
            return {"path": audio_path, "title": title, "duration": duration}

        except (requests.RequestException, ValueError, OSError) as exc:
            print(f"[INFO] Cobalt-Instanz {base_url} fehlgeschlagen ({exc}), probiere nächste.", flush=True)
            continue

    print("[INFO] Alle Cobalt-Instanzen fehlgeschlagen – falle zurück auf yt-dlp+Cookies.", flush=True)
    return None


# Mehrere YouTube-Player-Clients in EINEM yt-dlp-Aufruf anbieten. YouTube blockt einzelne
# Client-Typen wechselnd und unvorhersehbar (mal "web_creator", mal "ios", ...) – ein einzelner
# fest verdrahteter Client war die Hauptursache für die zuletzt komplett fehlgeschlagenen Importe.
# yt-dlp probiert bei einer Komma-Liste intern alle durch und nutzt, was tatsächlich antwortet.
PLAYER_CLIENTS = "ios,android,web_creator,tv,mweb"


def _cookies_args(output_dir: str) -> list:
    # Cookies sind die HAUPTVERTEIDIGUNG gegen "Sign in to confirm you're not a bot": ein
    # angemeldeter Account wird von YouTube deutlich seltener geblockt als ein anonymer Request,
    # unabhängig von der Runner-IP. Der PO-Token-Provider (Docker-Container weiter unten im
    # Workflow) bleibt als zusätzliche, unabhängige Schicht aktiv, hat sich allein aber als nicht
    # ausreichend erwiesen (siehe YouTube-Import-Architektur-Memory) – ohne gültige Cookies ist mit
    # einer deutlich höheren Fehlerquote zu rechnen. cookies.txt muss im Netscape-Format vorliegen
    # (Export z.B. per Browser-Extension "Get cookies.txt LOCALLY") und regelmäßig erneuert werden,
    # da YouTube-Sessions nach einiger Zeit ablaufen.
    cookies_content = os.environ.get("YOUTUBE_COOKIES", "").strip()
    if not cookies_content:
        gh_error("YOUTUBE_COOKIES-Secret ist leer oder nicht gesetzt – ohne angemeldete Session ist die Bot-Blockrate erfahrungsgemäß sehr hoch. Secret in den Repo-Settings unter Secrets and variables > Actions setzen (frischer Cookie-Export, Netscape-Format).")
        return []
    cookies_path = os.path.join(output_dir, "cookies.txt")
    with open(cookies_path, "w") as f:
        f.write(cookies_content)
    print("[INFO] YouTube-Cookies vorhanden – werden als primäre Bot-Abwehr verwendet.", flush=True)
    return ["--cookies", cookies_path]


# --impersonate chrome: yt-dlp ahmt den kompletten TLS-Fingerprint eines echten Chrome-Browsers
# nach (nicht nur den User-Agent-Header). Pythons Standard-HTTP-Stack hat einen leicht erkennbaren
# "Bot"-Fingerabdruck auf TLS-Ebene, unabhängig von IP, Cookies oder PO-Token – ein zusätzlicher,
# unabhängiger Signal-Layer gegen die Bot-Erkennung. Braucht curl_cffi (siehe Workflow-Install).
IMPERSONATE_ARGS = ["--impersonate", "chrome"]


def get_video_info(youtube_url: str, cookies_args: list) -> dict:
    """Holt Titel und Dauer ohne Download."""
    cmd = [
        "yt-dlp",
        "--print", "%(title)s\t%(duration)s",
        "--no-download",
        "--quiet",
        "--no-warnings",
        "--extractor-args", f"youtube:player_client={PLAYER_CLIENTS}",
        *IMPERSONATE_ARGS,
        *cookies_args,
        youtube_url,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    if result.returncode != 0 or not result.stdout.strip():
        print(f"[WARN] Konnte Metadaten nicht abrufen: {result.stderr.strip()}", flush=True)
        return {"title": "YouTube Import", "duration": 0}

    parts = result.stdout.strip().split("\t")
    title = parts[0] if parts else "YouTube Import"
    try:
        duration = int(float(parts[1])) if len(parts) > 1 else 0
    except ValueError:
        duration = 0

    return {"title": title, "duration": duration}


def _run_ytdlp_download(youtube_url: str, output_template: str, cookies_args: list) -> subprocess.CompletedProcess:
    cmd = [
        "yt-dlp",
        "--no-playlist",
        "--extract-audio",
        "--audio-format", "m4a",
        "--audio-quality", "0",
        "--extractor-args", f"youtube:player_client={PLAYER_CLIENTS}",
        "--output", output_template,
        "--no-progress",
        "--quiet",
        "--no-warnings",
        *IMPERSONATE_ARGS,
        *cookies_args,
        youtube_url,
    ]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=420)


def download_audio(youtube_url: str, output_dir: str, cookies_args: list) -> str:
    """
    Lädt beste Audio-Spur als .m4a herunter. Probiert mehrere YouTube-Player-Clients
    (siehe PLAYER_CLIENTS) und nutzt Cookies, falls konfiguriert.
    Ein Fehlversuch wird einmal automatisch wiederholt (kurzer Backoff), da YouTube
    gelegentlich nur kurzzeitig/transient blockt statt dauerhaft.
    Gibt den Pfad zur heruntergeladenen Datei zurück.
    """
    output_template = os.path.join(output_dir, "%(id)s.%(ext)s")

    result = None
    for attempt in range(1, 3):
        print(f"[INFO] yt-dlp startet Download (Versuch {attempt}/2, Clients: {PLAYER_CLIENTS})...", flush=True)
        result = _run_ytdlp_download(youtube_url, output_template, cookies_args)
        if result.returncode == 0:
            break
        print(f"[WARN] Versuch {attempt} fehlgeschlagen:\nSTDOUT: {result.stdout.strip()}\nSTDERR: {result.stderr.strip()}", flush=True)
        if attempt < 2:
            time.sleep(8)

    if result.returncode != 0:
        combined = f"{result.stdout}\n{result.stderr}"
        if "Sign in to confirm" in combined or "not a bot" in combined:
            gh_error(f"yt-dlp wurde als Bot geblockt – YOUTUBE_COOKIES ist wahrscheinlich abgelaufen oder leer und muss mit einem frischen Cookie-Export erneuert werden.\nSTDOUT: {result.stdout}\nSTDERR: {result.stderr}")
        else:
            gh_error(f"yt-dlp endgültig fehlgeschlagen nach 2 Versuchen.\nSTDOUT: {result.stdout}\nSTDERR: {result.stderr}")
        sys.exit(1)

    # Datei finden
    files = sorted(Path(output_dir).glob("*.m4a"))
    if not files:
        # Fallback: irgendeine Audio-Datei
        files = sorted(Path(output_dir).glob("*.*"))
        files = [f for f in files if f.suffix.lower() in {".m4a", ".mp4", ".webm", ".ogg", ".opus"}]

    if not files:
        gh_error("Keine Audio-Datei nach Download gefunden.")
        sys.exit(1)

    audio_path = str(files[0])
    size_mb = os.path.getsize(audio_path) / 1024 / 1024
    print(f"[INFO] Download abgeschlossen: {audio_path} ({size_mb:.1f} MB)", flush=True)
    return audio_path


def upload_to_r2(
    file_path: str,
    r2_key: str,
    account_id: str,
    access_key_id: str,
    secret_access_key: str,
    bucket_name: str,
    content_type: str = "audio/mp4",
) -> None:
    """Multipart-Upload nach Cloudflare R2 via boto3 S3-API."""
    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name="auto",
        config=Config(signature_version="s3v4"),
    )

    file_size = os.path.getsize(file_path)
    chunk_size = 8 * 1024 * 1024  # 8 MB pro Part
    num_parts = math.ceil(file_size / chunk_size)

    print(f"[INFO] Upload nach R2: {r2_key} ({num_parts} Part(s), {file_size / 1024 / 1024:.1f} MB)", flush=True)

    if num_parts <= 1:
        with open(file_path, "rb") as f:
            s3.put_object(Bucket=bucket_name, Key=r2_key, Body=f, ContentType=content_type)
        print("[INFO] Single-Part-Upload abgeschlossen.", flush=True)
        return

    mpu = s3.create_multipart_upload(Bucket=bucket_name, Key=r2_key, ContentType=content_type)
    upload_id = mpu["UploadId"]
    parts = []

    try:
        with open(file_path, "rb") as f:
            for part_num in range(1, num_parts + 1):
                chunk = f.read(chunk_size)
                if not chunk:
                    break
                resp = s3.upload_part(
                    Bucket=bucket_name,
                    Key=r2_key,
                    PartNumber=part_num,
                    UploadId=upload_id,
                    Body=chunk,
                )
                parts.append({"PartNumber": part_num, "ETag": resp["ETag"]})
                print(f"[INFO]  Part {part_num}/{num_parts} hochgeladen.", flush=True)

        s3.complete_multipart_upload(
            Bucket=bucket_name,
            Key=r2_key,
            UploadId=upload_id,
            MultipartUpload={"Parts": parts},
        )
        print("[INFO] Multipart-Upload abgeschlossen.", flush=True)

    except Exception as exc:
        gh_error(f"R2-Upload-Fehler, breche ab: {exc}")
        s3.abort_multipart_upload(Bucket=bucket_name, Key=r2_key, UploadId=upload_id)
        sys.exit(1)


def register_song(
    d1_api_url: str,
    d1_api_key: str,
    title: str,
    artist: str,
    duration: int,
    r2_key: str,
) -> None:
    """Trägt den Song in die Cloudflare D1-Datenbank ein."""
    url = d1_api_url.rstrip("/") + "/internal/register"
    payload = {
        "title":    title,
        "artist":   artist,
        "duration": duration,
        "r2_key":   r2_key,
    }

    print(f"[INFO] Registriere Song in D1: {title}", flush=True)
    resp = requests.post(
        url,
        json=payload,
        headers={
            "Authorization": f"Bearer {d1_api_key}",
            "Content-Type":  "application/json",
        },
        timeout=30,
    )

    if not resp.ok:
        gh_error(f"D1-Registrierung fehlgeschlagen: {resp.status_code} {resp.text}")
        sys.exit(1)

    data = resp.json()
    print(f"[SUCCESS] Song eingetragen – ID {data.get('id')}.", flush=True)


# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────

def main() -> None:
    youtube_url          = require_env("YOUTUBE_URL")
    job_id               = require_env("JOB_ID")
    r2_account_id        = require_env("R2_ACCOUNT_ID")
    r2_access_key_id     = require_env("R2_ACCESS_KEY_ID")
    r2_secret_access_key = require_env("R2_SECRET_ACCESS_KEY")
    r2_bucket_name       = require_env("R2_BUCKET_NAME")
    r2_public_domain     = require_env("R2_PUBLIC_DOMAIN")
    d1_api_url           = require_env("D1_API_URL")
    d1_api_key           = require_env("D1_API_KEY")

    gh_notice(f"Job {job_id} gestartet: {youtube_url}")
    _diagnose_environment()

    with tempfile.TemporaryDirectory() as tmpdir:
        # 0. Cobalt-Pool zuerst versuchen (siehe ADR-009): deren eigener Server kontaktiert
        # YouTube, nicht dieser Runner – kein Cookie-Bedarf, kein IP-Reputations-Risiko für
        # diesen Pfad. Nur bei Fehlschlag aller Instanzen folgt der bisherige yt-dlp-Weg.
        cobalt_result = try_cobalt_download(youtube_url, tmpdir)
        if cobalt_result:
            audio_path  = cobalt_result["path"]
            title       = cobalt_result["title"]
            duration    = cobalt_result["duration"]
            file_ext    = "mp3"
            content_type = "audio/mpeg"
        else:
            # Cookies EINMAL schreiben, für Metadaten- und Download-Aufruf gemeinsam nutzen
            cookies_args = _cookies_args(tmpdir)

            # 1. Metadaten abrufen
            info = get_video_info(youtube_url, cookies_args)
            title    = info["title"]
            duration = info["duration"]
            print(f"[INFO] Titel: {title} | Dauer: {duration}s", flush=True)

            # 2. Audio herunterladen
            audio_path = download_audio(youtube_url, tmpdir, cookies_args)
            file_ext    = "m4a"
            content_type = "audio/mp4"

        # 3. R2-Schlüssel aufbauen (job_id sorgt für Eindeutigkeit)
        safe_job = re.sub(r"[^a-zA-Z0-9\-]", "", job_id)[:36]
        r2_key   = f"yt/{safe_job}.{file_ext}"

        # 4. Nach R2 hochladen
        upload_to_r2(
            file_path=audio_path,
            r2_key=r2_key,
            account_id=r2_account_id,
            access_key_id=r2_access_key_id,
            secret_access_key=r2_secret_access_key,
            bucket_name=r2_bucket_name,
            content_type=content_type,
        )

    # 5. In D1 registrieren (außerhalb des tmpdir – Datei bereits hochgeladen)
    register_song(
        d1_api_url=d1_api_url,
        d1_api_key=d1_api_key,
        title=title,
        artist="Unbekannt",
        duration=duration,
        r2_key=r2_key,
    )

    print(f"[DONE] Job {job_id} erfolgreich abgeschlossen.", flush=True)


if __name__ == "__main__":
    main()
