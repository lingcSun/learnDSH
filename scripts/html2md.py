#!/usr/bin/env python3
"""html2md — 把带自定义样式的 HTML 文档反向抽取为 Markdown 内容源。

用途：
    python scripts/html2md.py <文件.html> [文件2.html ...]

在源文件旁生成同名 `.md`。配合 `md2html.py` 使用：HTML 是「给人看的排版产物」，
Markdown 是「给 agent 读的内容源」；本脚本把历史遗留的手写 HTML 回收成 md，
之后就只维护 md，HTML 一律由 md2html.py 重新生成。

设计取舍（重要）：
  * 只保留**内容**，丢弃**排版**：导航目录、回到顶部、两栏网格、代码上色 span
    等纯视觉标记不会还原，由 md2html.py 统一重新排版。
  * 结构性标记会翻译成 Markdown 可表达的约定，再由 md2html.py 渲染回同样效果：
      - `<div class="callout|co warn|tip|danger|info|goals|practice">`
        → `> [!WARN] 标题` + 正文（GitHub 风格 alert）
      - `<details><summary>自测</summary>…</details>`
        → `<details markdown="1"><summary>…</summary>` + 内部 Markdown
      - 标题里的 `<span class="no">01</span>` → 标题文字前缀 `01`，由 md2html 重新识别
      - `<span class="tag">推荐</span>` → 标题后的 `（推荐）`
  * 表格、代码块（含 ASCII 图）、嵌套列表、链接、加粗、行内代码都原样保留。

依赖：pip install beautifulsoup4
"""
from __future__ import annotations

import re
import sys
from html.parser import HTMLParser
from pathlib import Path

try:
    from bs4 import BeautifulSoup, Comment, NavigableString, Tag
except ImportError:
    raise SystemExit("缺少依赖：请先执行  pip install beautifulsoup4")


# ── callout 类型：HTML class → alert 关键字 ────────────────────────────────
CALLOUT_ALIASES = {
    "warn": "WARN",
    "warning": "WARN",
    "tip": "TIP",
    "danger": "DANGER",
    "info": "INFO",
    "goals": "GOALS",
    "practice": "PRACTICE",
    "note": "NOTE",
}

# 需要整块丢弃的装饰性节点
DROP_CLASSES = {"toc", "top-link", "progress", "grp", "brand", "kicker"}


class _Text(HTMLParser):
    """把一小段 HTML 转成纯文本（用于标题、表格单元格里的富文本）。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def text(self) -> str:
        return "".join(self.parts)


def _plain_text(node: Tag) -> str:
    p = _Text()
    p.feed(str(node))
    return p.text()


def esc(text: str, *, in_table: bool = False) -> str:
    """对 Markdown 有语法含义的字符做保守转义；不改动中文与标点。"""
    out = text.replace("\\", "\\\\")
    for ch in "`*_[]":
        out = out.replace(ch, "\\" + ch)
    if in_table:
        out = out.replace("|", "\\|")
    return out


def tidy(text: str) -> str:
    """压缩空白：HTML 里的换行/缩进只是排版，进入 md 后应为单空格。"""
    text = text.replace("\u00a0", " ")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\s*\n\s*", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def flatten(text: str) -> str:
    """把一段文本压成单行：用于 callout / 列表项等「视觉上是段落、语义上是行」的场景。

    HTML 源码为了可读性会在 `<strong>`、`<code>`、`<a>` 前后换行，
    这些换行不是内容；但 `<br>` 产生的硬换行（`  \\n`）必须保留。
    """
    text = text.replace("  \n", "\u0000")          # 保护硬换行
    text = re.sub(r"\n+", " ", text)
    text = re.sub(r"[ ]{2,}", " ", text)
    return text.replace("\u0000", "  \n").strip()


# ── 行内渲染 ──────────────────────────────────────────────────────────────
def inline_node(node: Tag, *, in_table: bool = False) -> str:
    """渲染**单个节点自身**（含它的标签语义）：`<strong>x</strong>` → `**x**`。"""
    name = node.name.lower()
    cls = set(node.get("class") or [])
    if name == "br":
        return "  \n"
    if name == "code":
        code = node.get_text()
        # 行内代码里若含反引号，改用更多反引号包裹
        fence = "`" * (max((len(m) for m in re.findall(r"`+", code)), default=0) + 1)
        if code.startswith("`") or code.endswith("`"):
            return f"{fence} {code} {fence}"
        return f"{fence}{code}{fence}"
    if name in ("strong", "b"):
        return f"**{inline(node, in_table=in_table).strip()}**"
    if name in ("em", "i"):
        return f"*{inline(node, in_table=in_table).strip()}*"
    if name == "a":
        href = node.get("href") or ""
        label = inline(node, in_table=in_table).strip() or href
        return f"[{label}]({href})" if href else label
    if name == "span" and cls & {"tag"}:
        return f"**{node.get_text().strip()}**"
    # span.no / span.t / span.arr / span.a 等装饰性 span、small、以及其它容器：
    # 都不带 Markdown 语义，直接展开其子节点
    return inline(node, in_table=in_table)


def inline(node: Tag, *, in_table: bool = False) -> str:
    """把节点的**子节点**渲染成 Markdown 行内文本。"""
    buf: list[str] = []
    for child in node.children:
        if isinstance(child, Comment):
            continue
        if isinstance(child, NavigableString):
            buf.append(esc(str(child), in_table=in_table))
        elif isinstance(child, Tag):
            buf.append(inline_node(child, in_table=in_table))
    return "".join(buf)


def collapse(text: str) -> str:
    """行内文本收尾：把换行折成空格（除非是 <br> 造成的硬换行）。"""
    text = re.sub(r"  \n", "\u0000", text)          # 保护硬换行
    text = re.sub(r"\n+", " ", text)
    text = re.sub(r"[ ]{2,}", " ", text)
    text = text.replace("\u0000", "  \n")
    return text.strip()


def render_inline(node: Tag, *, in_table: bool = False) -> str:
    return collapse(inline(node, in_table=in_table))


# ── 块级渲染 ──────────────────────────────────────────────────────────────
def list_block(node: Tag, depth: int = 0) -> str:
    out: list[str] = []
    ordered = node.name.lower() == "ol"
    idx = int(node.get("start") or 1)
    for li in node.find_all("li", recursive=False):
        marker = f"{idx}." if ordered else "-"
        # 子块（段落/嵌套列表/代码块）需要先取出来，避免和行内文字混在一起
        children = [c for c in li.children
                    if isinstance(c, Tag) and c.name.lower() in ("p", "ul", "ol", "pre", "blockquote")]
        head_parts: list[str] = []
        for c in li.children:
            if isinstance(c, NavigableString):
                head_parts.append(esc(str(c)))
            elif isinstance(c, Tag) and c.name.lower() not in ("p", "ul", "ol", "pre", "blockquote"):
                head_parts.append(inline_node(c))
        head = flatten(collapse("".join(head_parts)))
        pad = "  " * depth
        out.append(f"{pad}{marker} {head}".rstrip())
        for c in children:
            body = block(c, depth + 1)
            if body:
                out.append(body)
        idx += 1
    return "\n".join(out)


def table_block(node: Tag) -> str:
    rows: list[list[str]] = []
    header_rows = node.find_all("thead")
    body_rows = node.find_all("tbody")
    source = header_rows + body_rows if (header_rows or body_rows) else [node]
    for sec in source:
        for tr in sec.find_all("tr"):
            cells = tr.find_all(["th", "td"])
            rows.append([collapse(inline(c, in_table=True)) or "" for c in cells])
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]

    def line(r: list[str]) -> str:
        return "| " + " | ".join(r) + " |"

    out = [line(rows[0]), "| " + " | ".join(["---"] * width) + " |"]
    out += [line(r) for r in rows[1:]]
    return "\n".join(out)


def code_block(node: Tag) -> str:
    code = node.find("code")
    text = (code or node).get_text()
    text = text.replace("\u00a0", " ").rstrip()
    longest = max((len(m) for m in re.findall(r"`+", text)), default=0)
    fence = "`" * max(3, longest + 1)
    return f"{fence}\n{text}\n{fence}"


BLOCK_TAGS = {"p", "ul", "ol", "pre", "blockquote", "table", "div", "section",
              "main", "article", "header", "footer", "nav", "aside", "figure",
              "h1", "h2", "h3", "h4", "h5", "h6", "details", "hr"}


def group_inlines(children: list) -> list[list]:
    """把子节点流切段：连续的非块级节点（裸文本 + `<strong>`/`<code>`/`<a>`…）合成一组。

    HTML 源码常在行内元素前后换行以提升可读性，若逐个节点独立成段，
    一句话就被拆成一堆碎片。这里先合并再渲染，保证「视觉上的一段 = md 里的一段」。
    """
    groups: list[list] = []
    current: list = []
    for child in children:
        if isinstance(child, Comment):
            if current:
                groups.append(current)
                current = []
            continue
        is_block = isinstance(child, Tag) and child.name.lower() in BLOCK_TAGS
        if is_block:
            if current:
                groups.append(current)
                current = []
            groups.append([child])
        else:
            current.append(child)
    if current:
        groups.append(current)
    return groups


def render_group(group: list) -> str:
    """渲染一组节点：块级节点走块渲染，行内组合并成一段。"""
    if len(group) == 1 and isinstance(group[0], Tag) and group[0].name.lower() in BLOCK_TAGS:
        return block(group[0])
    parts = []
    for child in group:
        if isinstance(child, NavigableString):
            parts.append(esc(str(child)))
        elif isinstance(child, Tag):
            parts.append(inline_node(child))
    return flatten(collapse("".join(parts)))


def callout_block(node: Tag) -> str:
    cls = set(node.get("class") or [])
    kind = "NOTE"
    for c in cls:
        if c in CALLOUT_ALIASES:
            kind = CALLOUT_ALIASES[c]
        elif c.startswith("co-") and c[3:] in CALLOUT_ALIASES:
            kind = CALLOUT_ALIASES[c[3:]]
    title = ""
    head = node.find("span", class_="t")
    if head is not None:
        title = head.get_text().strip()
        head.decompose()
    body: list[str] = []
    for group in group_inlines(list(node.children)):
        text = render_group(group)
        if text:
            body.append(text)
    inner = "\n\n".join(flatten(b) for b in body)
    quoted = "\n".join("> " + ln if ln else ">" for ln in inner.splitlines())
    return f"> [!{kind}] {title}\n{quoted}" if title else f"> [!{kind}]\n{quoted}"


def heading_block(node: Tag) -> str:
    level = int(node.name[1])
    # 去掉编号/徽章 span 后的纯标题文本
    for span in node.find_all("span", class_="no"):
        span.decompose()
    text = render_inline(node)
    text = text.replace("  \n", " ").strip()
    # 标题尾部若残留装饰性徽章（推荐/实验性），转为括号后缀
    text = re.sub(r"\s*\*\*(.+?)\*\*\s*$", r"（\1）", text) if node.find("span", class_="tag") else text
    return "#" * level + " " + text


def details_block(node: Tag) -> str:
    summary = node.find("summary")
    label = summary.get_text().strip() if summary else "详情"
    if summary is not None:
        summary.decompose()
    inner: list[str] = []
    for group in group_inlines(list(node.children)):
        b = render_group(group)
        if b:
            inner.append(b)
    body = "\n\n".join(inner)
    return f'<details markdown="1"><summary>{label}</summary>\n\n{body}\n\n</details>'


def block(node, depth: int = 0) -> str:  # noqa: C901 - 分发函数，分支多是正常的
    if isinstance(node, Comment):
        return ""
    if isinstance(node, NavigableString):
        t = str(node).strip()
        return flatten(t) if t else ""
    if not isinstance(node, Tag):
        return ""
    name = node.name.lower()
    cls = set(node.get("class") or [])
    style = (node.get("style") or "")

    if cls & DROP_CLASSES:
        return ""
    if name in ("nav", "footer", "script", "style"):
        return ""

    if name == "pre":
        return code_block(node)
    if name == "table":
        return table_block(node)
    if name in ("ol", "ul"):
        return list_block(node, depth)
    if name == "details":
        return details_block(node)
    if name == "h1":
        return heading_block(node)
    if name in ("h2", "h3", "h4", "h5", "h6"):
        return heading_block(node)
    if name == "p":
        text = render_inline(node)
        if not text:
            return ""
        prefix = "  " * depth
        return "\n".join(prefix + ln for ln in text.split("\n"))
    if name == "blockquote":
        inner = "\n\n".join(b for g in group_inlines(list(node.children)) if (b := render_group(g)))
        return "\n".join("> " + ln if ln else ">" for ln in inner.splitlines())
    if name == "div" and (cls & {"callout"} or (cls & {"co"}) or any(c.startswith("co-") for c in cls)):
        return callout_block(node)
    if name == "div" and cls & {"seq"}:
        return code_block(node)
    if name == "div" and cls & {"flow", "part", "badges"}:
        text = render_inline(node)
        return f"**{text}**" if cls & {"part"} else text
    if name == "hr":
        return "---"
    if name == "header" and cls & {"hero"}:
        parts = [b for c in node.children if (b := block(c, depth))]
        return "\n\n".join(p for p in parts if p)
    if name in ("div", "section", "main", "article", "span", "header"):
        # 段落型容器（含 <p>、标题、表格…）：逐块渲染，但把散落的行内碎片合并成段。
        # 纯行内容器（无块级子节点）才整体 flatten，避免把整节压成一行。
        children = [c for c in node.children if not isinstance(c, Comment)]
        has_block = any(isinstance(c, Tag) and c.name.lower() in BLOCK_TAGS for c in children)
        if not has_block:
            text = flatten(render_inline(node))
            return text
        parts: list[str] = []
        for group in group_inlines(children):
            b = render_group(group)
            if b:
                parts.append(b)
        return "\n\n".join(parts)
    if name == "br":
        return ""
    # 兜底：行内内容
    text = render_inline(node)
    return text if text and not style else ""


def convert(path: Path) -> Path:
    html = path.read_text(encoding="utf-8")
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.find_all(["script", "style", "nav"]):
        tag.decompose()
    body = soup.body or soup

    parts: list[str] = []
    for child in body.children:
        b = block(child)
        if b:
            parts.append(b)
    md = "\n\n".join(parts)
    md = re.sub(r"\n{3,}", "\n\n", md)
    md = re.sub(r"[ \t]+\n", "\n", md)
    out = path.with_suffix(".md")
    out.write_text(md.rstrip() + "\n", encoding="utf-8")
    return out


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    for arg in argv[1:]:
        p = Path(arg)
        if p.suffix.lower() != ".html" or not p.is_file():
            print(f"跳过（不是存在的 .html 文件）：{p}")
            continue
        print(f"{p} -> {convert(p)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
