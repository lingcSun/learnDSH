#!/usr/bin/env python3
"""md2html — 按“输出约定”把 Markdown 输出文档转换为给人看的 HTML。

用法：
    python scripts/md2html.py <文件.md> [文件2.md ...]

在源文件旁生成同名 `.html`（自包含单文件：内嵌 CSS，无外部依赖，双击即可阅读）。
Markdown 是唯一内容源，HTML 由本脚本派生，不要手工编辑生成的 HTML。

支持的 Markdown 扩展（超出标准 Markdown 的部分）：
  * GitHub 风格提示块 `> [!NOTE|TIP|WARN|DANGER|INFO|GOALS|PRACTICE] 标题`
    → 带图标与配色的提示框（由 md2html 的 alert 扩展渲染）
  * 折叠块 `<details markdown="1"><summary>标题</summary>…markdown…</details>`
    → 原生可折叠区域，内部 Markdown 会被渲染（details 扩展）
    （`html2md.py` 反向抽取时用的也是这套约定，两者互为逆操作）

依赖：pip install markdown
"""
import re
import sys
import xml.etree.ElementTree as etree
from pathlib import Path
from textwrap import dedent

try:
    import markdown
except ImportError:
    raise SystemExit("缺少依赖：请先执行  pip install markdown")

from markdown.blockprocessors import BlockProcessor
from markdown.extensions import Extension
from markdown.treeprocessors import Treeprocessor
from markdown.util import AtomicString

CSS = """
:root{
  --ink:#1f2328; --ink-2:#57606a; --ink-3:#8b93a1;
  --line:#e5e8ee; --line-2:#d8dee4;
  --bg:#f7f8fa; --paper:#ffffff;
  --code-bg:#f6f8fa;
  --brand:#4f46e5; --brand-soft:#eef2ff;
}
*{box-sizing:border-box}
body {
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC",
    "Hiragino Sans GB", sans-serif;
  max-width: 900px;
  margin: 0 auto;
  padding: 40px 24px 96px;
  line-height: 1.78;
  color: var(--ink);
  font-size: 16px;
  background: var(--bg);
}
#page {
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 40px 48px 56px;
  box-shadow: 0 1px 2px rgba(16,24,40,.04);
}
h1, h2 { border-bottom: 1px solid var(--line-2); padding-bottom: 8px; }
h1 { font-size: 1.9em; margin: 0 0 .8em; line-height:1.35; }
h2 { font-size: 1.4em; margin-top: 2.2em; }
h3 { font-size: 1.15em; margin-top: 1.7em; }
h4 { font-size: 1.02em; margin-top: 1.5em; color: var(--ink-2); }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  font-family: Consolas, "JetBrains Mono", "Cascadia Code", monospace;
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 1px 5px;
  font-size: .88em;
}
pre {
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px 16px;
  overflow-x: auto;
  line-height: 1.55;
}
pre code { background: none; border: none; padding: 0; font-size: .85em; }
blockquote {
  border-left: 4px solid var(--line-2);
  color: var(--ink-2);
  margin: 1em 0;
  padding: .2em 1em;
}
table { border-collapse: collapse; margin: 1em 0; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line-2); padding: 7px 14px; vertical-align: top; }
th { background: var(--code-bg); text-align: left; }
tr:nth-child(even) td { background: #fbfcfd; }
hr { border: none; border-top: 1px solid var(--line-2); margin: 2.4em 0; }
li > p { margin: .3em 0; }
ol, ul { padding-left: 1.6em; }

/* ── GitHub 风格提示块 ───────────────────────────────── */
.alert {
  border: 1px solid var(--line-2);
  border-left: 4px solid var(--ink-3);
  border-radius: 8px;
  background: var(--paper);
  padding: 12px 18px;
  margin: 1.3em 0;
}
.alert > .alert-title {
  display: block;
  font-weight: 700;
  margin-bottom: .3em;
  color: var(--ink);
}
.alert > p { margin: .35em 0; }
.alert > p:last-child { margin-bottom: 0; }
.alert > :first-child { margin-top: 0; }
.alert-note    { border-left-color: #4f46e5; background: #f5f6ff; }
.alert-tip     { border-left-color: #1a7f37; background: #f2fbf5; }
.alert-warn    { border-left-color: #9a6700; background: #fffbf0; }
.alert-danger  { border-left-color: #cf222e; background: #fff5f5; }
.alert-info    { border-left-color: #0969da; background: #f2f7fd; }
.alert-goals   { border-left-color: #8250df; background: #f8f4ff; }
.alert-practice{ border-left-color: #0f766e; background: #f1faf8; }

/* ── 折叠块 ──────────────────────────────────────────── */
details {
  border: 1px solid var(--line-2);
  border-radius: 8px;
  background: #fcfcfd;
  padding: 10px 16px;
  margin: 1.2em 0;
}
details[open] { background: var(--paper); }
summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--brand);
  padding: 2px 0;
}
summary:hover { color: #3730a3; }
details[open] > summary { margin-bottom: .5em; padding-bottom: .4em; border-bottom: 1px dashed var(--line); }

@media (max-width: 640px) {
  body { padding: 16px 10px 60px; }
  #page { padding: 22px 18px 32px; border-radius: 10px; }
}
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
<div id="page">
__BODY__
</div>
</body>
</html>
"""


# ── 扩展一：GitHub 风格提示块 > [!TIP] 标题 ────────────────────────────────
ALERT_KINDS = {"NOTE", "TIP", "WARN", "WARNING", "DANGER", "INFO", "GOALS", "PRACTICE"}
ALERT_RE = re.compile(r"^\[!(?P<kind>[A-Z]+)\]\s*(?P<title>.*)$")


class AlertProcessor(BlockProcessor):
    """把 `> [!WARN] 标题` 开头的引用块渲染成带配色的提示框。"""

    def test(self, parent, block):
        return block.startswith("> [!")

    def run(self, parent, blocks):  # noqa: D102 - 覆写基类接口
        block = blocks.pop(0)
        raw = block
        # 逐行去掉 `> ` 前缀
        lines = []
        for ln in block.split("\n"):
            ln = re.sub(r"^\s*>\s?", "", ln)
            lines.append(ln)
        inner = "\n".join(lines).strip()

        first, sep, rest = inner.partition("\n")
        m = ALERT_RE.match(first.strip())
        kind = "note"
        title = ""
        if m:
            kind = m.group("kind").lower()
            title = m.group("title").strip()
            body_md = rest.strip()
        else:
            body_md = inner.strip()

        div = etree.SubElement(parent, "div")
        div.set("class", f"alert alert-{kind}")
        if title:
            span = etree.SubElement(div, "span")
            span.set("class", "alert-title")
            span.text = title
        if body_md:
            # 用宽松的递归解析，保证提示框里也能有列表/代码/强调
            self.parser.parseChunk(div, body_md)
        return True


class AlertExtension(Extension):
    def extendMarkdown(self, md):  # noqa: D102 - 覆写基类接口
        md.parser.blockprocessors.register(AlertProcessor(md.parser), "alert", 105)


# ── 扩展二：折叠块 details 内部的 Markdown ─────────────────────────────────
class DetailsProcessor(Treeprocessor):
    """让 `<details markdown="1">` 内部的原始 Markdown 文本被真正渲染。

    Python-Markdown 默认把 HTML 块内的内容当纯文本；这里对每个带
    `markdown="1"` 的 details/summary 容器，重新解析其正文。
    """

    def run(self, root):  # noqa: D102 - 覆写基类接口
        for el in root.iter():
            if el.tag not in ("details", "summary"):
                continue
            if el.get("markdown") != "1":
                continue
            del el.attrib["markdown"]
            if el.tag == "summary":
                continue
            # 收集 details 内的文本（summary 之后的正文）
            parts: list[str] = []
            summary = el.find("summary")
            for child in list(el):
                if child is summary:
                    continue
                parts.append(etree.tostring(child, encoding="unicode", method="html").strip())
            for child in list(el):
                if child is not summary:
                    el.remove(child)
            body = "\n\n".join(p for p in parts if p)
            if not body:
                continue
            # 交给 Markdown 解析，再把结果挂回 details
            holder = etree.Element("div")
            self.md.parseChunk(holder, dedent(body))
            for kid in list(holder):
                el.append(kid)
            if holder.text and holder.text.strip():
                el.text = holder.text


class DetailsExtension(Extension):
    def extendMarkdown(self, md):  # noqa: D102 - 覆写基类接口
        md.treeprocessors.register(DetailsProcessor(md), "details_md", 20)


def extract_title(text: str, fallback: str) -> str:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip().lstrip("#").strip()
    return fallback


def convert(path: Path) -> Path:
    text = path.read_text(encoding="utf-8")
    md = markdown.Markdown(extensions=[
        "tables", "fenced_code", "sane_lists", "attr_list", "md_in_html",
        AlertExtension(), DetailsExtension(),
    ])
    body = md.convert(text)
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
