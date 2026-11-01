#!/usr/bin/env python3
"""Download optional third-party skins into ./skins (they are not in the repo).

    python3 scripts/fetch_skins.py          # fetch everything listed below
    python3 scripts/fetch_skins.py TRON     # fetch one by name

Files are fetched from the Winamp Skin Museum's CDN and verified against their
MD5 (the id in the skin's skins.webamp.org URL). Existing files are kept.
"""
import hashlib
import os
import sys
import urllib.request

SKINS = {
    # name: (md5 / webamp id, file name)
    "TRON": ("86ef97f56931b02433ec548260d427b5", "TRON.wsz"),
}

DEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skins")


def fetch(name):
    md5, fname = SKINS[name]
    path = os.path.join(DEST, fname)
    if os.path.exists(path):
        print(f"{fname}: already there, skipping")
        return True
    url = f"https://r2.webampskins.org/skins/{md5}.wsz"
    req = urllib.request.Request(url, headers={"User-Agent": "Y2K-MP3-Streamer fetch_skins"})
    try:
        data = urllib.request.urlopen(req, timeout=30).read()
    except Exception as e:
        print(f"{fname}: download failed ({e}); get it by hand from https://skins.webamp.org/skin/{md5}/{fname}")
        return False
    if hashlib.md5(data).hexdigest() != md5:
        print(f"{fname}: checksum mismatch, not saving")
        return False
    os.makedirs(DEST, exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    print(f"{fname}: saved to skins/")
    return True


def main():
    names = sys.argv[1:] or list(SKINS)
    unknown = [n for n in names if n not in SKINS]
    if unknown:
        sys.exit(f"unknown skin(s): {', '.join(unknown)} (known: {', '.join(SKINS)})")
    sys.exit(0 if all([fetch(n) for n in names]) else 1)


if __name__ == "__main__":
    main()
