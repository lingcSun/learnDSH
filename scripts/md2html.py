#!/usr/bin/env python3
"""md2html — 按“输出约定”把 Markdown 输出文档转换为给人看的 HTML。

用法：
    python scripts/md2html.py <文件.md> [文件2.md ...]

在源文件旁生成同名 `.html`（自包含单文件：内嵌 CSS，无外部依赖，双击即可阅读）。
Markdown 是唯一内容源，HTML 由本脚本派生，不要手工编辑生成的 HTML。

依赖：pip install markdown
"""
import sys
from pathlib import Path

try:
    import markdown
except ImportError:
    raise SystemExit("缺少依赖：请先执行  pip install markdown")

CSS = """
body {
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC",
    "Hiragino Sans GB", sans-serif;
  max-width: 880px;
  margin: 0 auto;
  padding: 40px 24px 80px;
  line-height: 1.75;
  color: #1f2328;
  font-size: 16px;
}
h1, h2 { border-bottom: 1px solid #d8dee4; padding-bottom: 8px; margin-top: 2em; }
h1 { font-size: 1.9em; margin-top: 0.5em; }
h2 { font-size: 1.4em; }
h3 { font-size: 1.15em; margin-top: 1.6em; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  font-family: Consolas, "JetBrains Mono", "Cascadia Code", monospace;
  background: #f6f8fa;
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 0.9em;
}
pre {
  background: #f6f8fa;
  border: 1px solid #e6eaef;
  border-radius: 8px;
  padding: 14px 16px;
  overflow-x: auto;
  line-height: 1.5;
}
pre code { background: none; padding: 0; font-size: 0.85em; }
blockquote {
  border-left: 4px solid #d0d7de;
  color: #57606a;
  margin: 0 0 1em;
  padding: 0 1em;
}
table { border-collapse: collapse; margin: 1em 0; display: block; overflow-x: auto; }
th, td { border: 1px solid #d0d7de; padding: 6px 14px; }
th { background: #f6f8fa; }
tr:nth-child(even) td { background: #fbfcfd; }
hr { border: none; border-top: 1px solid #d8dee4; margin: 2em 0; }
li > p { margin: 0.3em 0; }
"""

TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>__CSS__</style>
</head>
<body>
__BODY__
</body>
</html>
"""


def extract_title(text: str, fallback: str) -> str:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip().lstrip("#").strip()
    return fallback


def convert(path: Path) -> Path:
    text = path.read_text(encoding="utf-8")
    body = markdown.markdown(text, extensions=["tables", "fenced_code", "sane_lists"])
    html = (TEMPLATE
            .replace("__TITLE__", extract_title(text, path.stem))
            .replace("__CSS__", CSS.strip())
            .replace("__BODY__", body))
    out = path.with_suffix(".html")
    out.write_text(html, encoding="utf-8")
    return out


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    for arg in argv[1:]:
        p = Path(arg)
        if p.suffix.lower() != ".md" or not p.is_file():
            print(f"跳过（不是存在的 .md 文件）：{p}")
            continue
        print(f"{p} -> {convert(p)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
