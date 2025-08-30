# -*- coding: utf-8 -*-
"""
Generate sitemap.xml for DailyPlea.

- Scans root for numeric folders: /NN/
- Also scans /archive/NN/ if /archive exists
- lastmod = mtime of that folder's index.html
- Includes optional entries for "/" and "/archive/"

Usage (PowerShell):
  py -3 generate_sitemap.py --base https://dailyplea.com --include-root --include-archive-index
"""

from pathlib import Path
from datetime import datetime, timezone
import argparse

def iso_date(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")

def find_numbered_dirs(base_dir: Path, subdir: Path | None = None):
    """Yield (url_path, lastmod_ts) for /NN/ (optionally under subdir)."""
    root = base_dir if subdir is None else (base_dir / subdir)
    if not root.exists():
        return
    for p in root.iterdir():
        if p.is_dir() and p.name.isdigit():
            idx = p / "index.html"
            if idx.exists():
                # Build the URL path with a trailing slash
                if subdir is None:
                    url_path = f"/{p.name}/"
                else:
                    url_path = f"/{subdir.as_posix().strip('/')}/{p.name}/"
                yield (url_path, idx.stat().st_mtime, int(p.name))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="https://dailyplea.com", help="Base site URL")
    ap.add_argument("--out", default="sitemap.xml", help="Output filename")
    ap.add_argument("--include-root", action="store_true", help="Include '/' in sitemap")
    ap.add_argument("--include-archive-index", action="store_true", help="Include '/archive/' if it exists")
    args = ap.parse_args()

    base_dir = Path(__file__).resolve().parent
    items: list[tuple[str, str, str, str]] = []  # (loc, lastmod, changefreq, priority)

    # Optional root index
    if args.include_root:
        root_idx = base_dir / "index.html"
        lm = iso_date(root_idx.stat().st_mtime) if root_idx.exists() else datetime.now(timezone.utc).strftime("%Y-%m-%d")
        items.append((f"{args.base}/", lm, "daily", "1.0"))

    # Optional archive index
    archive_idx = base_dir / "archive" / "index.html"
    if args.include_archive_index and archive_idx.exists():
        items.append((f"{args.base}/archive/", iso_date(archive_idx.stat().st_mtime), "daily", "0.8"))

    # Numbered pages at root
    numbered_root = list(find_numbered_dirs(base_dir))
    # Numbered pages under /archive (if present)
    numbered_archive = list(find_numbered_dirs(base_dir, Path("archive")))

    # Merge and sort by numeric value descending (newest first)
    numbered_all = numbered_root + numbered_archive
    numbered_all.sort(key=lambda t: t[2], reverse=True)

    for url_path, mtime, _num in numbered_all:
        items.append((f"{args.base}{url_path}", iso_date(mtime), "daily", "0.9"))

    # Build XML
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    ]
    for loc, lastmod, changefreq, priority in items:
        lines += [
            "  <url>",
            f"    <loc>{loc}</loc>",
            f"    <lastmod>{lastmod}</lastmod>",
            f"    <changefreq>{changefreq}</changefreq>",
            f"    <priority>{priority}</priority>",
            "  </url>"
        ]
    lines.append("</urlset>")

    out_path = base_dir / args.out
    out_path.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    print(f"Wrote {out_path} with {len(items)} URLs.")

if __name__ == "__main__":
    main()
