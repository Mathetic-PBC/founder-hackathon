"""Mirror the reading notes into a folder on this device: one folder per book, one markdown file per
reading session, photos in each book's attachments/ folder.

    python vault.py            # sync once
    python vault.py --watch    # keep syncing every 5 seconds

agents.py also syncs in the background after every agent call. The folder is VAULT_DIR in pi/.env
(default pi/vault/); point it at a notes app's folder, e.g. an Engelbart project, to see notes there.
Uses the same BART_URL and BART_TOKEN as agents.py.
"""
import json
import os
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
_since = "1970-01-01T00:00:00Z"
_lock = threading.Lock()


def vault_dir():
    return Path(os.environ.get("VAULT_DIR") or HERE / "vault").expanduser()


def sync():
    """Write every note changed since the last sync. Returns the paths written."""
    global _since
    url, token = os.environ.get("BART_URL", "").rstrip("/"), os.environ.get("BART_TOKEN", "")
    if not (url and token):
        return []
    with _lock:
        req = urllib.request.Request(f"{url}/api/notes?since={urllib.parse.quote(_since)}", headers={"x-bart-token": token})
        with urllib.request.urlopen(req, timeout=30) as res:
            notes = json.load(res)["notes"]
        root = vault_dir().resolve()
        written = []
        for note in notes:
            path = (root / note["path"]).resolve()
            if root not in path.parents:
                continue  # never write outside the vault
            path.parent.mkdir(parents=True, exist_ok=True)
            content = note["content"]
            for link, download in note["attachments"].items():
                local = path.parent / "attachments" / Path(link).name
                if not local.exists():
                    local.parent.mkdir(exist_ok=True)
                    urllib.request.urlretrieve(download, local)
                content = content.replace(f"]({link})", f"](attachments/{local.name})")
            path.write_text(content)
            written.append(path.relative_to(root))
            _since = note["updated_at"]
        return written


def sync_in_background():
    def run():
        try:
            for path in sync():
                print(f"  vault: wrote {path}")
        except Exception as e:  # the vault is a mirror; never let it break the conversation
            print(f"  vault: sync failed ({e})")

    threading.Thread(target=run, daemon=True).start()


if __name__ == "__main__":
    import argparse

    from dotenv import load_dotenv

    parser = argparse.ArgumentParser()
    parser.add_argument("--watch", action="store_true", help="keep syncing every 5 seconds")
    args = parser.parse_args()
    load_dotenv(HERE / ".env")
    print(f"vault: {vault_dir()}")
    while True:
        for p in sync():
            print(f"wrote {p}")
        if not args.watch:
            break
        time.sleep(5)
