"""Link checker for the parts catalogue.

Requests every catalogue URL that is not "TODO", reports status codes, and
lists broken or TODO links so they can be fixed before the demo.

Run from the backend/ directory:
    .venv/bin/python -m parts.check_links
Exit code 1 if any non-TODO link is broken.
"""

from __future__ import annotations

import sys

import httpx

from . import match

TIMEOUT_S = 10


def main() -> int:
    items = match.catalog_items()
    todo, ok, broken = [], [], []
    with httpx.Client(timeout=TIMEOUT_S, follow_redirects=True,
                      headers={"User-Agent": "Mozilla/5.0 (buildfromvision link-checker)"}) as client:
        for item in items:
            url = item.get("url", "TODO")
            if url == "TODO":
                todo.append(item["id"])
                continue
            try:
                r = client.get(url)
                if 200 <= r.status_code < 400:
                    ok.append((item["id"], r.status_code))
                else:
                    broken.append((item["id"], url, r.status_code))
            except Exception as e:
                broken.append((item["id"], url, type(e).__name__))

    print(f"catalogue items : {len(items)}")
    print(f"TODO links      : {len(todo)}  -> {', '.join(todo) if todo else '-'}")
    print(f"working links   : {len(ok)}")
    for pid, code in ok:
        print(f"  OK   {pid:<22} HTTP {code}")
    print(f"broken links    : {len(broken)}")
    for pid, url, status in broken:
        print(f"  FAIL {pid:<22} {url}  ({status})")
    if broken:
        print("\nFix the broken links above (or mark them TODO) before the demo.")
        return 1
    print("\nNo broken non-TODO links. Fill in the TODO links with real shop URLs.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
