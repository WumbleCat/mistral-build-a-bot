"""Link checker for the parts catalogue (final schema: `url` field, "TODO" = no link yet).

Classification:
  - 2xx / 3xx                 -> ok
  - 401 / 403                 -> blocked (bot protection, check manually)
  - 404 / 5xx / network error -> broken
Items whose url is "TODO" are skipped (counted separately).

Run from the backend/ directory:
    .venv/bin/python -m parts.check_links
Exit code 1 ONLY if at least one non-TODO link is broken (blocked shops do
not fail the run - they are expected and should be checked manually).
"""

from __future__ import annotations

import sys

import httpx

from . import match

TIMEOUT_S = 10
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def classify(status_code: int | None) -> str:
    """Map an HTTP status (or None for a network error) to ok/blocked/broken."""
    if status_code is None:
        return "broken"
    if 200 <= status_code < 400:
        return "ok"
    if status_code in (401, 403):
        return "blocked"
    return "broken"  # 404, 5xx, anything else


def main() -> int:
    items = match.catalog_items()
    todo: list[str] = []
    ok: list[tuple[str, int]] = []
    blocked: list[tuple[str, str, int]] = []
    broken: list[tuple[str, str, object]] = []

    with httpx.Client(timeout=TIMEOUT_S, follow_redirects=True,
                      headers={"User-Agent": USER_AGENT}) as client:
        for item in items:
            url = item.get("url", "TODO")
            if not url or url == "TODO":
                todo.append(item["id"])
                continue
            try:
                r = client.get(url)
                status: int | None = r.status_code
                err = None
            except Exception as e:  # network error, timeout, DNS, ...
                status, err = None, type(e).__name__
            kind = classify(status)
            if kind == "ok":
                ok.append((item["id"], status))
            elif kind == "blocked":
                blocked.append((item["id"], url, status))
            else:
                broken.append((item["id"], url, err if err else status))

    print(f"catalogue items : {len(items)}")
    print(f"TODO (skipped)  : {len(todo)}" + (f"  -> {', '.join(todo)}" if todo else ""))
    print(f"ok (2xx/3xx)    : {len(ok)}")
    for pid, code in ok:
        print(f"  OK      {pid:<24} HTTP {code}")
    print(f"blocked (401/403, bot protection - check manually): {len(blocked)}")
    for pid, url, code in blocked:
        print(f"  BLOCKED {pid:<24} HTTP {code}  {url}")
    print(f"broken (404/5xx/network error): {len(broken)}")
    for pid, url, status in broken:
        print(f"  BROKEN  {pid:<24} {status}  {url}")

    if broken:
        print("\nFix the broken links above (or mark them TODO) before the demo.")
        return 1
    print("\nNo broken links. Blocked shops (bot protection) should be verified manually.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
