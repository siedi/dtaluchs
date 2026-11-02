"""Size guard rails as a hint, never red (CONVENTIONS.md §3)."""

import ast
import sys
from pathlib import Path

MAX_MODULE_LINES = 400
MAX_FUNCTION_LINES = 60
MAX_BRANCHES = 15
BRANCH_NODES = (ast.If, ast.For, ast.While, ast.Try, ast.With, ast.match_case, ast.IfExp)


def hints(path: Path) -> list[str]:
    """One line per guard rail the file exceeds."""
    source = path.read_text(encoding="utf-8")
    found = []
    lines = len(source.splitlines())
    if lines > MAX_MODULE_LINES:
        found.append(f"{path}: {lines} Zeilen, beim nächsten Anfassen teilen")
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        length = (node.end_lineno or node.lineno) - node.lineno + 1
        branches = sum(isinstance(n, BRANCH_NODES) for n in ast.walk(node))
        if length > MAX_FUNCTION_LINES or branches > MAX_BRANCHES:
            found.append(
                f"{path}:{node.lineno} {node.name}: {length} Zeilen, {branches} Verzweigungen, "
                "herausziehen"
            )
    return found


def main(roots: list[str]) -> int:
    found = [h for root in roots for p in sorted(Path(root).rglob("*.py")) for h in hints(p)]
    for line in found:
        print(f"  Hinweis: {line}")
    if not found:
        print("  keine Hinweise")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or ["src"]))
