#!/usr/bin/env python3
"""Split panel.html inline script/handlers for MV3 CSP compliance."""
import re
from pathlib import Path

DIR = Path(__file__).parent
PANEL = DIR / "panel.html"

ATTR_MAP = [
    ("onclick", "data-cs-onclick"),
    ("onkeydown", "data-cs-onkeydown"),
    ("onchange", "data-cs-onchange"),
    ("oninput", "data-cs-oninput"),
]


def remap_handlers(text: str) -> str:
    text = text.replace("data-cs-data-cs-", "data-cs-")
    for old, new in ATTR_MAP:
        text = text.replace(f'{old}="', f'{new}="')
        text = text.replace(f"data-cs-{new}=", f"{new}=")
    return text


def main():
    html = remap_handlers(PANEL.read_text(encoding="utf-8"))

    m = re.search(r"(?s)<script>\s*\r?\n(.*?)\r?\n</script>", html)
    if m:
        script = remap_handlers(m.group(1))
        (DIR / "panel-app.js").write_text(script, encoding="utf-8", newline="\n")
        replacement = (
            '<script src="panel-bind.js"></script>\r\n'
            '<script src="panel-app.js"></script>\r\n'
        )
        html = html[: m.start()] + replacement + html[m.end() :]
        print("Removed inline script; wrote panel-app.js")
    else:
        print("No inline <script> block found")

    if "panel-bind.js" not in html:
        html = html.replace(
            '<script src="panel-boot.js"></script>',
            '<script src="panel-boot.js"></script>\n'
            '<script src="panel-bind.js"></script>\n'
            '<script src="panel-app.js"></script>',
            1,
        )

    PANEL.write_text(html, encoding="utf-8", newline="\n")
    print("panel.html updated")


if __name__ == "__main__":
    main()
