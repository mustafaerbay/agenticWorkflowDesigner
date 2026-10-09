"""Bundled example workflows, seeded at startup when missing."""

from typing import Any

FIXED_CALCULATOR = '''"""Tiny calculator used as the sandbox repository for the example SDLC workflow."""


def add(a: float, b: float) -> float:
    return a + b


def subtract(a: float, b: float) -> float:
    return a - b


def multiply(a: float, b: float) -> float:
    return a * b


def divide(a: float, b: float) -> float:
    if b == 0:
        raise ValueError("division by zero")
    return a / b
'''

REQUIREMENT = "Make divide() raise ValueError('division by zero') when the divisor is 0."


def node(id_: str, type_: str, label: str, x: int, y: int, config: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"id": id_, "type": type_, "position": {"x": x, "y": y}, "data": {"label": label, "config": config or {}}}


def edge(source: str, target: str, handle: str = "out", label: str | None = None) -> dict[str, Any]:
    e: dict[str, Any] = {"id": f"e_{source}_{handle}_{target}", "source": source, "target": target,
                         "sourceHandle": handle, "targetHandle": "in"}
    if label:
        e["label"] = label
    return e


def ref(path: str) -> dict[str, str]:
    return {"ref": path}


def val(value: Any) -> dict[str, Any]:
    return {"value": value}


def _pipeline(scripted: bool) -> dict[str, Any]:
    start = node("start", "start", "Requirement", 0, 200, {
        "default_input": {"requirement": REQUIREMENT, "workspace_template": "sample-calculator"},
        "input_schema": {"type": "object", "properties": {"requirement": {"type": "string"},
                                                          "workspace_template": {"type": "string"}},
                         "required": ["requirement"]},
    })
    if scripted:
        planning = node("planning_agent", "agent", "Planning Agent (scripted, no LLM)", 260, 200, {
            "kind": "scripted", "tools": ["list_files", "read_file"],
            "steps": [{"tool": "list_files", "args": {}}, {"tool": "read_file", "args": {"path": "calculator.py"}}],
        })
        developer = node("developer_agent", "agent", "Developer Agent (scripted, no LLM)", 520, 200, {
            "kind": "scripted", "tools": ["write_file"],
            "steps": [{"tool": "write_file", "args": {"path": "CHANGELOG.md",
                                                      "content": "# Changelog\n\n- divide(): reject a zero divisor\n"}}],
        })
        fix = node("fix_agent", "agent", "Fix Code Agent (scripted, no LLM)", 1040, 420, {
            "kind": "scripted", "tools": ["write_file"],
            "steps": [{"tool": "write_file", "args": {"path": "calculator.py", "content": FIXED_CALCULATOR}}],
        })
        review = node("code_review", "tool", "Review: inspect diff", 1300, 200, {"tool": "git_diff", "args": {}})
        review_rule = {"op": "and", "rules": [
            {"op": "is_true", "left": ref("code_review.output.has_changes")},
            {"op": "gte", "left": ref("run_tests.output.coverage_percent"), "right": val(80)},
        ]}
    else:
        planning = node("planning_agent", "agent", "Planning Agent", 260, 200, {"kind": "llm", "preset": "planning"})
        developer = node("developer_agent", "agent", "Developer Agent", 520, 200, {
            "kind": "llm", "preset": "developer",
            "user_prompt": "Requirement: {{input.requirement}}\nPlan: {{planning_agent.output.tasks}}\n"
                           "Reviewer feedback (if any): {{code_review.output.comments}}",
        })
        fix = node("fix_agent", "agent", "Fix Code Agent", 1040, 420, {
            "kind": "llm", "preset": "developer",
            "system_prompt": "You fix failing tests with minimal, correct code changes. Never weaken or delete tests.",
            "user_prompt": "The test suite is failing. Fix the code.\nFailures: {{run_tests.output.failures}}\n"
                           "Output: {{run_tests.output.output}}",
        })
        review = node("code_review", "agent", "Code Review Agent", 1300, 200, {"kind": "llm", "preset": "code_review"})
        review_rule = {"op": "and", "rules": [
            {"op": "gte", "left": ref("code_review.output.score"), "right": val(7)},
            {"op": "is_true", "left": ref("code_review.output.approved")},
        ]}

    nodes = [
        start, planning, developer,
        node("run_tests", "tool", "Testing: run pytest", 780, 200, {"tool": "run_tests", "args": {},
                                                                    "timeout_seconds": 300}),
        node("tests_passed", "condition", "Tests passed?", 1040, 200, {
            "branches": [
                {"handle": "passed", "label": "Passed", "rule": {"op": "is_true", "left": ref("run_tests.output.tests_passed")}},
                {"handle": "fix", "label": "Retry fix (< 3)", "rule": {"op": "lt", "left": ref("fix_agent.runs"), "right": val(3)}},
            ],
            "default_handle": "give_up",
        }),
        fix, review,
        node("review_ok", "condition", "Review passed?", 1560, 200, {
            "branches": [
                {"handle": "approved", "label": "Approved", "rule": review_rule},
                {"handle": "rework", "label": "Rework (< 3)", "rule": {"op": "lt", "left": ref("developer_agent.runs"), "right": val(3)}},
            ],
            "default_handle": "rejected",
        }),
        node("human_approval", "approval", "Human approval", 1820, 200, {
            "title": "Approve delivery of the change",
            "description": "Tests pass and review passed. Approve to generate the patch and report.",
        }),
        node("generate_patch", "tool", "Generate patch", 2080, 120, {"tool": "generate_patch", "args": {"name": "change.patch"}}),
        node("report", "tool", "Execution report", 2340, 120, {"tool": "create_report", "args": {"title": "Development report"}}),
        node("end", "end", "Done", 2600, 120),
        node("fail_tests", "fail", "Tests still failing", 1300, 600, {"message": "Tests still failing after 3 fix attempts"}),
        node("fail_review", "fail", "Review failed", 1820, 480, {"message": "Code review failed after 3 rework cycles"}),
        node("fail_rejected", "fail", "Rejected", 2080, 340, {"message": "Delivery rejected by a human approver"}),
    ]
    edges = [
        edge("start", "planning_agent"),
        edge("planning_agent", "developer_agent"),
        edge("developer_agent", "run_tests"),
        edge("run_tests", "tests_passed"),
        edge("tests_passed", "code_review", "passed", "Passed"),
        edge("tests_passed", "fix_agent", "fix", "Fix"),
        edge("tests_passed", "fail_tests", "give_up", "Give up"),
        edge("fix_agent", "run_tests"),
        edge("code_review", "review_ok"),
        edge("review_ok", "human_approval", "approved", "Approved"),
        edge("review_ok", "developer_agent", "rework", "Rework"),
        edge("review_ok", "fail_review", "rejected", "Rejected"),
        edge("human_approval", "generate_patch", "approved", "Approved"),
        edge("human_approval", "fail_rejected", "rejected", "Rejected"),
        edge("generate_patch", "report"),
        edge("report", "end"),
    ]
    return {"nodes": nodes, "edges": edges,
            "settings": {"max_loop_iterations": 5, "max_total_steps": 60, "max_duration_seconds": 3600}}


EXAMPLES: list[dict[str, Any]] = [
    {
        "name": "Autonomous Development Pipeline",
        "description": "Planning → development → real pytest run → fix loop → code review → human approval → "
                       "patch + report. LLM agents need a configured OpenAI-compatible model provider.",
        "definition": _pipeline(scripted=False),
    },
    {
        "name": "Autonomous Development Pipeline (deterministic demo, no LLM)",
        "description": "Same pipeline with scripted, deterministic agents (no LLM). Tests, diff, branching, loop, "
                       "approval and artifacts are all real; only the agents' decisions are pre-scripted.",
        "definition": _pipeline(scripted=True),
    },
]
