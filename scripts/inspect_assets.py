import os
import subprocess
import json
from PIL import Image

FFMPEG = r"C:\Users\GD\Desktop\GD\yt-dlp\ffmpeg.exe"
DOWNLOADS = r"C:\Users\GD\Downloads"
DURGA_DIR = os.path.join(DOWNLOADS, "Durga Saptashati")
ELEMENTS_DIR = os.path.join(DURGA_DIR, "Elements")

print("--- Elements Check ---")
for f in os.listdir(ELEMENTS_DIR):
    p = os.path.join(ELEMENTS_DIR, f)
    print(f, os.path.getsize(p))
    if f.lower().endswith(('.png', '.jpg', '.jpeg')):
        im = Image.open(p)
        print(f"  Image size: {im.size}, mode: {im.mode}")

print("\n--- Audio Check ---")
audio_files = [
    os.path.join(DOWNLOADS, "2. Kavacha Stotram.mp3"),
    os.path.join(DURGA_DIR, "Devi Kavacham.MP3")
]
for af in audio_files:
    if os.path.exists(af):
        print(f"File: {af} ({os.path.getsize(af)} bytes)")
        cmd = [FFMPEG, "-i", af]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
        for line in res.stderr.splitlines():
            if "Duration:" in line or "Audio:" in line:
                print(" ", line.strip())
    else:
        print(f"File NOT found: {af}")

print("\n--- Markdown Files Check ---")
md_dev = os.path.join(DURGA_DIR, "(For Projecting) Shri Durga Saptashati - Devanagari.md")
md_eng = os.path.join(DURGA_DIR, "(For Projecting) Shri Durga Saptashati - English.md")

for name, path in [("Devanagari", md_dev), ("English", md_eng)]:
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        print(f"{name}: {len(lines)} lines")
        # search for Kavacham
        for idx, line in enumerate(lines[:200]):
            if any(k in line.lower() for k in ["kavach", "कवच"]):
                print(f"  Line {idx+1}: {line.strip()[:80]}")
    else:
        print(f"{name} NOT found: {path}")
