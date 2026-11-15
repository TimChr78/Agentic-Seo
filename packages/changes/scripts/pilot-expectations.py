#!/usr/bin/env python3
"""Generate the pilot's expected slugs and frontmatter output from the pilot's own functions.

The two functions below are copied verbatim from TimChr78/martechsignal's ``tools/build_blog.py``
at commit ``b1b0bd3295f693944b8d7f783f2ab1712dd3eda0`` (re-read on 2026-11-15). They are not
reimplemented: the point of the fixture is to state what Python actually does with characters whose
meaning differs from JavaScript (U+0085, U+001C-U+001F, U+2028, U+00A0, U+FEFF, ...).

Run from the repository root:

    python3 packages/changes/scripts/pilot-expectations.py

It writes ``packages/changes/test/fixtures/pilot/python-expectations.json``. Commit both the script
and the fixture; the tests read the fixture, so CI does not need Python. Re-run it (and review the
diff) if the pilot's build script or a case here changes.
"""

from __future__ import annotations

import json
import re
from pathlib import Path


def slugify(title: str) -> str:
    """Convert a title to a URL-friendly slug."""
    s = title.lower()
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    s = re.sub(r"\s+", "-", s)
    return s.strip("-")


def parse_frontmatter(text: str):
    """Parse YAML-style frontmatter block. Returns (meta dict, body text)."""
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    raw = parts[1].strip()
    body = parts[2].strip()
    meta = {}
    for line in raw.split("\n"):
        m = re.match(r"(\w+):\s*(.+)", line)
        if not m:
            continue
        key = m.group(1)
        val = m.group(2).strip().strip('"').strip("'")
        if val.startswith("[") and val.endswith("]"):
            val = [v.strip().strip('"').strip("'") for v in val[1:-1].split(",")]
        meta[key] = val
    return meta, body


# Titles whose slug depends on a character JavaScript and Python classify differently: line
# separators and C1 controls (whitespace to Python, not to a JavaScript regex), U+FEFF (whitespace to
# JavaScript, not to Python), non-breaking and ideographic spaces, and a zero-width space (neither).
TITLES = [
    "Hello World",
    "Hello\u0085World",
    "Hello\u2028World",
    "Hello\u2029World",
    "Hello\u00a0World",
    "Hello\u3000World",
    "Hello\u001cWorld",
    "Hello\u001fWorld",
    "Hello\ufeffWorld",
    "  Hello   World  ",
    "Claude SEO v2.25 \u2014 Rescore (61 vs 92)",
    "\u00dcn\u00efcode \u0164itle",
    "Keep-Hyphens-Intact",
    "A\u200bB",
    "--------",
    "\u0130stanbul",
    "MCP Rewrites: The Tool Layer",
]

# Documents whose frontmatter block depends on Python's strip/split/`.` semantics: a value carrying a
# line separator, leading C1 whitespace, U+FEFF, CRLF line endings, an indented or comment line, a
# quoted value, a list, a duplicate key, a Unicode key, and a value that closes the block early.
DOCUMENTS = [
    "---\ntitle: Hello\u2028World\n---\nBody text\n",
    "---\nslug: Hello\u0085World\n---\n",
    "---\ntitle: \u0085Hello\n---\n",
    "---\ntitle: \ufeffHello\n---\n",
    "---\r\ntitle: Hi\r\n---\r\nbody\r\n",
    "---\n# slug: ignored\ntitle: Real\n---\n",
    '---\nseo_title: "Quoted: value"\n---\n',
    "---\ntags: [a, b]\n---\n",
    "---\ntitle: A\u2029B\n---\n",
    "---\ntitle:   spaced   \n---\n",
    "---\ntitle:\n---\n",
    "---\nt\u00edtle: x\n---\n",
    "no frontmatter at all",
    "---\ntitle: One\ntitle: Two\n---\n",
    "---\ntitle: [not, a list]\n---\n",
    "---\ntitle: \"Hello 'both' quotes\"\n---\n",
    "---\ntitle: A --- B\n---\nbody\n",
]


def main() -> None:
    fixture = {
        "source": {
            "repository": "TimChr78/martechsignal",
            "file": "tools/build_blog.py",
            "commit": "b1b0bd3295f693944b8d7f783f2ab1712dd3eda0",
            "functions": ["slugify", "parse_frontmatter"],
            "generated_by": "packages/changes/scripts/pilot-expectations.py",
        },
        "slugify": [{"title": title, "slug": slugify(title)} for title in TITLES],
        "frontmatter": [],
    }
    for text in DOCUMENTS:
        meta, body = parse_frontmatter(text)
        fixture["frontmatter"].append({"text": text, "meta": meta, "body": body})

    out = Path(__file__).resolve().parents[1] / "test" / "fixtures" / "pilot" / "python-expectations.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fixture, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out.relative_to(Path.cwd())}")


if __name__ == "__main__":
    main()
