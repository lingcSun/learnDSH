#!/usr/bin/env python3
"""check_refs — 校验文档引用的源码路径/符号在当前版本中是否仍成立。

用法：
    python scripts/check_refs.py <文档.md> [--root 源码根目录] [--glob]

两种模式：
  * 默认：从文档里抽出形如 `packages/foo/bar.ts`、`apps/cli/...` 的仓库路径，
    逐个检查是否存在；对 basename 形式的引用（如 `agent.ts`、`bin.ts`）
    用 glob 在仓库里搜索同名文件，报告它现在的真实位置。
  * `--json`：输出 JSON，便于程序消费。

设计目的：dsh 的 `packages/` 是分类目录且包会移动，文档里的旧路径会失效。
本脚本把「路径是否存在」这件机械的事一次性做对，人工只需判断语义变化。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

DEFAULT_ROOT = r"D:\deepseek harness\deepseek-harness"

# 仓库路径：以已知顶层目录开头
REPO_PATH_RE = re.compile(
    r"(?<![\w/.-])"
    r"((?:packages|apps|docs|vendor|scripts|python|native|website|benchmarks)"
    r"/[A-Za-z0-9._/-]+\.(?:ts|tsx|js|mjs|json|md|yml|yaml|py))"
)

# 裸文件名引用：不用于判定存在性，只用于提示「它可能指现在哪个文件」
BARE_FILE_RE = re.compile(r"(?<![\w/.-])([a-z0-9][A-Za-z0-9._-]*\.(?:ts|tsx|js|mjs|yml|yaml|json))")

SKIP_BARE = {"package.json", "index.ts", "types.ts", "constants.ts", "README.md", "invariant.ts"}


def find_paths(text: str) -> dict[str, list[int]]:
    """抽出文档里的仓库路径，并记录出现的行号。"""
    out: dict[str, list[int]] = {}
    for i, line in enumerate(text.splitlines(), 1):
        for m in REPO_PATH_RE.finditer(line):
            path = m.group(1).rstrip(".,;:）)")
            out.setdefault(path, []).append(i)
    return out


def find_bare(text: str) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for i, line in enumerate(text.splitlines(), 1):
        for m in BARE_FILE_RE.finditer(line):
            name = m.group(1)
            if name in SKIP_BARE or "/" in line[max(0, m.start() - 1):m.start()]:
                continue
            out.setdefault(name, []).append(i)
    return out


_INDEX: dict[str, list[str]] | None = None


def build_index(root: Path) -> dict[str, list[str]]:
    """一次性建立 basename → [相对路径] 索引。

    仓库含 node_modules，逐个 rglob 极慢；索引一次、查表多次。
    """
    index: dict[str, list[str]] = {}
    skip = {"node_modules", ".git", "lib", "dist", "build", ".dsh-build", "snapshots"}
    stack = [root]
    while stack:
        cur = stack.pop()
        try:
            entries = list(cur.iterdir())
        except (PermissionError, OSError):
            continue
        for e in entries:
            if e.is_dir():
                if e.name in skip or e.name.startswith("."):
                    continue
                stack.append(e)
            elif e.is_file():
                index.setdefault(e.name, []).append(e.relative_to(root).as_posix())
    return index


def locate(root: Path, name: str) -> list[str]:
    """在仓库里按 basename 找文件（优先源码目录，排除构建产物）。"""
    global _INDEX
    if _INDEX is None:
        _INDEX = build_index(root)
    hits = [p for p in _INDEX.get(name, []) if "/lib/" not in p and "/dist/" not in p]
    return sorted(hits, key=len)[:4]


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    as_json = "--json" in argv
    root = Path(DEFAULT_ROOT)
    if "--root" in argv:
        root = Path(argv[argv.index("--root") + 1])
    if not args:
        print(__doc__)
        return 2

    doc = Path(args[0])
    text = doc.read_text(encoding="utf-8")
    repo = find_paths(text)
    bare = find_bare(text)

    ok, missing = [], []
    for path, lines in sorted(repo.items()):
        clean = path.split("#")[0].split(":")[0]
        (ok if (root / clean).exists() else missing).append((path, lines))

    result = {
        "doc": str(doc),
        "root": str(root),
        "total": len(repo),
        "ok": [{"path": p, "lines": l} for p, l in ok],
        "missing": [{"path": p, "lines": l} for p, l in missing],
        "bare": {n: {"lines": l, "candidates": locate(root, n)} for n, l in sorted(bare.items())},
    }

    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    print(f"文档：{doc.name}   源码根：{root.name}")
    print(f"仓库路径引用：{len(repo)}   存在：{len(ok)}   缺失：{len(missing)}\n")
    if missing:
        print("── 缺失（需更新）──")
        for path, lines in missing:
            base = Path(path).name
            cand = locate(root, base)
            where = f"    ← 现可能在: {', '.join(cand)}" if cand else ""
            print(f"  {path}   [行 {','.join(map(str, lines[:6]))}]{where}")
        print()
    print("── 存在 ──")
    for path, lines in ok:
        print(f"  {path}  [{len(lines)} 处]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
