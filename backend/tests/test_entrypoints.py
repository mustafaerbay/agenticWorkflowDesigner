"""Service entry points run as `python -m ...`; anything defined after the `__main__` guard would not
exist yet when main() starts (tests import the module, so they would not notice)."""

import ast
from pathlib import Path

import pytest

ENTRYPOINTS = ["app/workers/agent_worker.py", "app/workers/orchestrator.py"]


@pytest.mark.parametrize("path", ENTRYPOINTS)
def test_main_guard_is_the_last_statement(path):
    tree = ast.parse((Path(__file__).parent.parent / path).read_text())
    last = tree.body[-1]
    assert isinstance(last, ast.If) and "__main__" in ast.unparse(last.test), f"{path}: code after the __main__ guard"
