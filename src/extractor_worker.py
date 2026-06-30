"""
Himusic Cloud – YouTube Extractor
Läuft auf einem GitHub Actions Ubuntu-Runner.
Ablauf:
  1. yt-dlp lädt beste Audio-Spur als .m4a (Android-Client-Spoofing)
  2. boto3 lädt die Datei per Multipart-Upload nach Cloudflare R2
  3. requests ruft /internal/register am Cloudflare Worker auf
"""

import json
import math
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import boto3
import requests
from botocore.config import Config


# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────

def require_env(key: str) -> str:
    val = os.environ.get(key, "").strip()
    if not val:
        print(f"[ERROR] Pflicht-Umgebungsvariable fehlt: {key}", flush=True)
        sys.exit(1)
    return val


def get_video_info(youtube_url: str) -> dict:
    """Holt Titel und Dauer ohne Download."""
    cmd = [
        "yt-dlp",
        "--print", "%(title)s\t%(duration)s",
        "--no-download",
        "--quiet",
        "--no-warnings",
        "--extractor-args", "youtube:player_client=web_creator",
        youtube_url,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
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


def download_audio(youtube_url: str, output_dir: str) -> str:
    """
    Lädt beste Audio-Spur als .m4a herunter.
    Nutzt iOS-Client – funktioniert auf CI-Servern ohne Cookies.
    Gibt den Pfad zur heruntergeladenen Datei zurück.
    """
    output_template = os.path.join(output_dir, "%(id)s.%(ext)s")

    # Cookies-Datei aus Umgebungsvariable schreiben (optional)
    cookies_args = []
    cookies_content = os.environ.get("YOUTUBE_COOKIES", "").strip()
    if cookies_content:
        cookies_path = os.path.join(output_dir, "cookies.txt")
        with open(cookies_path, "w") as f:
            f.write(cookies_content)
        cookies_args = ["--cookies", cookies_path]
        print("[INFO] YouTube-Cookies werden verwendet.", flush=True)

    cmd = [
        "yt-dlp",
        "--no-playlist",
        "--extract-audio",
        "--audio-format", "m4a",
        "--audio-quality", "0",
        # web_creator Client – funktioniert oft ohne Cookies auf CI-Servern
        "--extractor-args", "youtube:player_client=web_creator",
        "--output", output_template,
        "--no-progress",
        "--quiet",
        "--no-warnings",
        *cookies_args,
        youtube_url,
    ]

    print("[INFO] yt-dlp startet Download...", flush=True)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

    if result.returncode != 0:
        print(f"[ERROR] yt-dlp fehlgeschlagen:\n{result.stderr}", flush=True)
        sys.exit(1)

    # Datei finden
    files = sorted(Path(output_dir).glob("*.m4a"))
    if not files:
        # Fallback: irgendeine Audio-Datei
        files = sorted(Path(output_dir).glob("*.*"))
        files = [f for f in files if f.suffix.lower() in {".m4a", ".mp4", ".webm", ".ogg", ".opus"}]

    if not files:
        print("[ERROR] Keine Audio-Datei nach Download gefunden.", flush=True)
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
            s3.put_object(Bucket=bucket_name, Key=r2_key, Body=f, ContentType="audio/mp4")
        print("[INFO] Single-Part-Upload abgeschlossen.", flush=True)
        return

    mpu = s3.create_multipart_upload(Bucket=bucket_name, Key=r2_key, ContentType="audio/mp4")
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
        print(f"[ERROR] Upload-Fehler, breche ab: {exc}", flush=True)
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
        print(f"[ERROR] D1-Registrierung fehlgeschlagen: {resp.status_code} {resp.text}", flush=True)
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

    print(f"[INFO] Job {job_id} gestartet: {youtube_url}", flush=True)

    # 1. Metadaten abrufen
    info = get_video_info(youtube_url)
    title    = info["title"]
    duration = info["duration"]
    print(f"[INFO] Titel: {title} | Dauer: {duration}s", flush=True)

    # 2. Audio herunterladen
    with tempfile.TemporaryDirectory() as tmpdir:
        audio_path = download_audio(youtube_url, tmpdir)

        # 3. R2-Schlüssel aufbauen (job_id sorgt für Eindeutigkeit)
        safe_job = re.sub(r"[^a-zA-Z0-9\-]", "", job_id)[:36]
        r2_key   = f"yt/{safe_job}.m4a"

        # 4. Nach R2 hochladen
        upload_to_r2(
            file_path=audio_path,
            r2_key=r2_key,
            account_id=r2_account_id,
            access_key_id=r2_access_key_id,
            secret_access_key=r2_secret_access_key,
            bucket_name=r2_bucket_name,
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
