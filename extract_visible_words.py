#!/usr/bin/env python3

"""
extract_visible_words.py  (root-numbered-folders, quiet by default)

Scans the REPO ROOT for numbered folders (e.g., ./1, ./2, ...) and extracts
VISIBLE text (or tokenized words) from files inside each folder.

Default behavior: no console output. Use --log for a one-line summary, or --quiet to
suppress warnings too (errors still exit nonzero).

Usage examples:
  python3 extract_visible_words.py                  # silent
  python3 extract_visible_words.py --log            # prints [ok] line
  python3 extract_visible_words.py --quiet          # suppress non-critical warnings
  python3 extract_visible_words.py --words --one-per-line --headers
  python3 extract_visible_words.py --root . --out pleas_visible.txt

Requires:
  - Python 3.8+
  - beautifulsoup4  (pip install beautifulsoup4)
"""
import argparse
import os
import re
import sys
from pathlib import Path

try:
    from bs4 import BeautifulSoup, Comment  # type: ignore
except Exception as e:
    print("This script requires BeautifulSoup 4. Install with:", file=sys.stderr)
    print("  pip install beautifulsoup4", file=sys.stderr)
    sys.exit(1)


def make_logger(quiet: bool):
    def log(msg: str, *, err: bool = False):
        if quiet:
            return
        print(msg, file=(sys.stderr if err else sys.stdout))
    return log


def is_hidden_element(el) -> bool:
    if not hasattr(el, "attrs"):
        return False
    if "hidden" in el.attrs:
        return True
    aria = el.attrs.get("aria-hidden")
    if isinstance(aria, str) and aria.lower().strip() == "true":
        return True
    classes = el.attrs.get("class", []) or []
    lower_classes = {c.lower() for c in classes if isinstance(c, str)}
    if any(c in lower_classes for c in ["sr-only", "visually-hidden", "hidden"]):
        return True
    style = el.attrs.get("style")
    if isinstance(style, str):
        style_l = style.lower()
        if "display:none" in style_l or "visibility:hidden" in style_l:
            return True
    return False


EXCLUDE_TAGS = {
    "script", "style", "noscript", "template", "svg", "canvas", "head"
}


def extract_visible_text_from_html(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for t in EXCLUDE_TAGS:
        for node in soup.find_all(t):
            node.decompose()
    for c in soup.find_all(string=lambda t: isinstance(t, Comment)):
        c.extract()
    for node in soup.find_all(is_hidden_element):
        node.decompose()
    for br in soup.find_all("br"):
        br.replace_with("\n")

    pieces = []
    for el in soup.find_all(string=True):  # deprecation-safe
        parent = el.parent
        if not parent or getattr(parent, "name", "").lower() in EXCLUDE_TAGS:
            continue
        anc = parent
        hidden = False
        while anc is not None and hasattr(anc, "attrs"):
            if is_hidden_element(anc):
                hidden = True
                break
            anc = getattr(anc, "parent", None)
        if hidden:
            continue
        s = str(el).strip()
        if s:
            pieces.append(s)

    text = "\n".join(pieces)
    text = "\n".join(" ".join(line.split()) for line in text.splitlines())
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text


WORD_RE = re.compile(r"[A-Za-z0-9]+(?:[’'\-][A-Za-z0-9]+)*")


def tokenize_words(text: str):
    return WORD_RE.findall(text)


def find_numbered_dirs(base: Path):
    """Find root-level subdirectories with purely numeric names (no recursion)."""
    dirs = []
    for p in base.iterdir():
        if p.is_dir() and p.name.isdigit():
            dirs.append(p)
    return sorted(dirs, key=lambda x: int(x.name))


def gather_files_from_numbered_dir(d: Path):
    index = d / "index.html"
    if index.exists():
        return [index]
    htmls = sorted(d.glob("*.html"))
    if htmls:
        return htmls
    mds = sorted(d.glob("*.md"))
    if mds:
        return mds
    txts = sorted(d.glob("*.txt"))
    if txts:
        return txts
    candidates = []
    for ext in (".htm", ".markdown", ".rst"):
        candidates.extend(d.glob(f"*{ext}"))
    return sorted(candidates)


def main():
    ap = argparse.ArgumentParser(description="Extract visible text/words from ROOT numbered folders.")
    ap.add_argument("--root", type=str, default=".", help="Repo root (default: current dir)")
    ap.add_argument("--out", type=str, default="pleas_visible.txt", help="Output file path")
    ap.add_argument("--words", action="store_true", help="Write tokenized words instead of raw text")
    ap.add_argument("--one-per-line", action="store_true", dest="one_per_line",
                    help="With --words, write one word per line")
    ap.add_argument("--headers", action="store_true", help="Prefix sections with '----- <folder> -----'")
    ap.add_argument("--log", action="store_true", help="Print a one-line success summary at the end")
    ap.add_argument("--quiet", action="store_true", help="Suppress non-critical warnings")
    args = ap.parse_args()
    log = make_logger(args.quiet)

    root = Path(args.root).resolve()
    if not root.exists():
        print(f"[error] root path does not exist: {root}", file=sys.stderr)
        sys.exit(2)

    base = root
    numbered_dirs = find_numbered_dirs(base)
    if not numbered_dirs:
        log(f"[warn] no numbered folders found under ROOT: {base}", err=True)

    sections = []
    for d in numbered_dirs:
        files = gather_files_from_numbered_dir(d)
        if not files:
            continue

        all_text = []
        for f in files:
            try:
                data = f.read_text(encoding="utf-8", errors="ignore")
            except Exception as e:
                log(f"[warn] failed to read {f}: {e}", err=True)
                continue

            if f.suffix.lower() in (".html", ".htm"):
                txt = extract_visible_text_from_html(data)
            else:
                txt = data

            if txt:
                all_text.append(txt.strip())

        text = "\n\n".join(all_text).strip()
        if not text:
            continue

        if args.words:
            tokens = tokenize_words(text)
            body = "\n".join(tokens) if args.one_per_line else " ".join(tokens)
        else:
            body = text

        if args.headers:
            section = f"----- {d.name.zfill(3)} -----\n{body}\n"
        else:
            section = f"{body}\n"
        sections.append(section)

    out_path = Path(args.out).resolve()
    out_path.write_text("\n".join(sections).rstrip() + "\n", encoding="utf-8")
    if args.log:
        print(f"[ok] wrote {out_path} ({len(sections)} sections)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
