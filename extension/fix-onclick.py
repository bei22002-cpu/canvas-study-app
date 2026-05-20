from pathlib import Path

DIR = Path(__file__).parent
MAP = [
    ("onclick", "data-cs-onclick"),
    ("onkeydown", "data-cs-onkeydown"),
    ("onchange", "data-cs-onchange"),
    ("oninput", "data-cs-oninput"),
]


def fix(text):
    text = text.replace("data-cs-data-cs-", "data-cs-")
    for old, new in MAP:
        text = text.replace(f"{old}=", f"{new}=")
        text = text.replace(f"data-cs-{new}=", f"{new}=")
    return text


for name in ("panel.html", "panel-app.js"):
    p = DIR / name
    t = fix(p.read_text(encoding="utf-8"))
    if name == "panel.html":
        block = (
            '<script src="lib/purify.min.js"></script>\n'
            '<script src="panel-boot.js"></script>\n'
            '<script src="panel-bind.js"></script>\n'
            '<script src="panel-app.js"></script>'
        )
        t = t.replace(block, '<script src="panel-bind.js"></script>\n<script src="panel-app.js"></script>', 1)
    p.write_text(t, encoding="utf-8", newline="\n")
    print(name, "remaining onclick=", t.count("onclick="))
