"""Specialised agent presets. All use the same generic LLM runtime."""

from typing import Any

_READ_TOOLS = ["list_files", "read_file", "search_files"]

PRESETS: dict[str, dict[str, Any]] = {
    "planning": {
        "name": "Planning Agent",
        "description": "Analyses a requirement and produces implementation tasks.",
        "config": {
            "kind": "llm",
            "preset": "planning",
            "system_prompt": (
                "You are a senior software architect. Inspect the repository with the available tools, "
                "then break the requirement into small, concrete implementation tasks."
            ),
            "user_prompt": "Requirement: {{input.requirement}}",
            "tools": _READ_TOOLS,
            "temperature": 0.2,
            "max_tokens": 2048,
            "max_steps": 8,
            "timeout_seconds": 300,
            "retry": {"max_attempts": 2, "backoff_seconds": 5},
            "output_schema": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string"},
                    "tasks": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["summary", "tasks"],
            },
        },
    },
    "developer": {
        "name": "Developer Agent",
        "description": "Implements tasks by editing files in the isolated workspace.",
        "config": {
            "kind": "llm",
            "preset": "developer",
            "system_prompt": (
                "You are a careful senior Python developer. Implement the given tasks by reading and writing "
                "files in the workspace. Keep changes minimal and run the tests before finishing."
            ),
            "user_prompt": "Requirement: {{input.requirement}}",
            "tools": [*_READ_TOOLS, "write_file", "run_tests"],
            "temperature": 0.1,
            "max_tokens": 4096,
            "max_steps": 15,
            "timeout_seconds": 600,
            "retry": {"max_attempts": 1, "backoff_seconds": 5},
            "output_schema": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string"},
                    "files_changed": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["summary"],
            },
        },
    },
    "testing": {
        "name": "Testing Agent",
        "description": "Runs the test suite and summarises results.",
        "config": {
            "kind": "llm",
            "preset": "testing",
            "system_prompt": "You are a QA engineer. Run the test suite with run_tests and report the real results.",
            "user_prompt": "Run the tests and report.",
            "tools": ["run_tests", "read_file"],
            "temperature": 0.0,
            "max_tokens": 1024,
            "max_steps": 4,
            "timeout_seconds": 600,
            "retry": {"max_attempts": 1, "backoff_seconds": 5},
            "output_schema": {
                "type": "object",
                "properties": {
                    "tests_passed": {"type": "boolean"},
                    "summary": {"type": "string"},
                    "failures": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["tests_passed", "summary"],
            },
        },
    },
    "code_review": {
        "name": "Code Review Agent",
        "description": "Reviews the workspace diff and scores it.",
        "config": {
            "kind": "llm",
            "preset": "code_review",
            "system_prompt": (
                "You are a strict code reviewer. Use git_diff to inspect the changes. Score the change from 0 "
                "to 10 for correctness, clarity and test coverage."
            ),
            "user_prompt": "Review the changes for: {{input.requirement}}",
            "tools": ["git_diff", "read_file"],
            "temperature": 0.0,
            "max_tokens": 2048,
            "max_steps": 5,
            "timeout_seconds": 300,
            "retry": {"max_attempts": 2, "backoff_seconds": 5},
            "output_schema": {
                "type": "object",
                "properties": {
                    "score": {"type": "number"},
                    "approved": {"type": "boolean"},
                    "comments": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["score", "approved"],
            },
        },
    },
    "devops": {
        "name": "DevOps Agent",
        "description": "Prepares delivery artifacts (patch, report). Never deploys without approval.",
        "config": {
            "kind": "llm",
            "preset": "devops",
            "system_prompt": (
                "You are a DevOps engineer. Prepare delivery artifacts with generate_patch and create_report. "
                "You cannot deploy or push; never claim that you did."
            ),
            "user_prompt": "Prepare the delivery artifacts.",
            "tools": ["git_diff", "generate_patch", "create_report"],
            "temperature": 0.0,
            "max_tokens": 1024,
            "max_steps": 5,
            "timeout_seconds": 300,
            "retry": {"max_attempts": 1, "backoff_seconds": 5},
            "output_schema": None,
        },
    },
    "documentation": {
        "name": "Documentation Agent",
        "description": "Writes or updates documentation for the change.",
        "config": {
            "kind": "llm",
            "preset": "documentation",
            "system_prompt": "You are a technical writer. Update README/docs in the workspace to describe the change.",
            "user_prompt": "Document the change for: {{input.requirement}}",
            "tools": [*_READ_TOOLS, "write_file", "git_diff"],
            "temperature": 0.3,
            "max_tokens": 2048,
            "max_steps": 8,
            "timeout_seconds": 300,
            "retry": {"max_attempts": 1, "backoff_seconds": 5},
            "output_schema": None,
        },
    },
}


def preset_list() -> list[dict[str, Any]]:
    return [{"key": key, **value} for key, value in PRESETS.items()]
