from app.services.examples import EXAMPLES
from app.services.execution import get_validator
from tests.conftest import edge, node, scripted_agent


def codes(result):
    return {i.code for i in result.errors}


def base(extra_nodes=(), extra_edges=()):
    return {
        "nodes": [node("start", "start"), scripted_agent("agent_a", [{"tool": "list_files", "args": {}}], ["list_files"]),
                  node("end", "end"), *extra_nodes],
        "edges": [edge("start", "agent_a"), edge("agent_a", "end"), *extra_edges],
    }


def test_examples_are_valid():
    for example in EXAMPLES:
        result = get_validator().validate(example["definition"])
        assert result.valid, (example["name"], result.as_dict())


def test_minimal_valid():
    assert get_validator().validate(base()).valid


def test_structural_errors():
    v = get_validator()
    assert "start_count" in codes(v.validate({"nodes": [node("end", "end")], "edges": []}))
    d = base()
    d["edges"].append({"id": "x", "source": "agent_a", "target": "ghost"})
    assert "dangling_edge" in codes(v.validate(d))
    d = base(extra_nodes=[node("orphan", "end")])
    assert "unreachable" in codes(v.validate(d))
    d = base()
    d["edges"].append(edge("agent_a", "end", handle="nope"))
    assert "invalid_handle" in codes(v.validate(d))
    d = base()
    d["nodes"].append(node("Bad-Id", "end"))
    assert "invalid_node_id" in codes(v.validate(d))


def test_unbounded_cycle_rejected_bounded_cycle_accepted():
    v = get_validator()
    unbounded = {
        "nodes": [node("start", "start"),
                  scripted_agent("a", [{"tool": "list_files"}], ["list_files"]),
                  scripted_agent("b", [{"tool": "list_files"}], ["list_files"]),
                  node("end", "end")],
        "edges": [edge("start", "a"), edge("a", "b"), edge("b", "a"), edge("b", "end")],
    }
    assert "unbounded_cycle" in codes(v.validate(unbounded))
    rule = {"op": "lt", "left": {"ref": "a.runs"}, "right": {"value": 3}}
    bounded = {
        "nodes": [node("start", "start"), scripted_agent("a", [{"tool": "list_files"}], ["list_files"]),
                  node("check", "condition", {"branches": [{"handle": "again", "rule": rule}], "default_handle": "done"}),
                  node("end", "end")],
        "edges": [edge("start", "a"), edge("a", "check"), edge("check", "a", "again"), edge("check", "end", "done")],
    }
    assert v.validate(bounded).valid


def test_condition_type_and_reference_checks():
    v = get_validator()
    tool = node("tests", "tool", {"tool": "run_tests"})
    bad_type = node("check", "condition", {"branches": [
        {"handle": "ok", "rule": {"op": "gt", "left": {"ref": "tests.output.tests_passed"}, "right": {"value": 1}}}]})
    d = {"nodes": [node("start", "start"), tool, bad_type, node("end", "end")],
         "edges": [edge("start", "tests"), edge("tests", "check"), edge("check", "end", "ok"), edge("check", "end", "false")]}
    assert "type_mismatch" in codes(v.validate(d))
    unknown = node("check", "condition", {"branches": [
        {"handle": "ok", "rule": {"op": "is_true", "left": {"ref": "ghost.output.x"}}}]})
    d["nodes"][2] = unknown
    assert "unknown_ref" in codes(v.validate(d))


def test_tool_permissions_enforced_in_validation():
    v = get_validator()
    d = base()
    d["nodes"][1] = scripted_agent("agent_a", [{"tool": "write_file", "args": {}}], ["read_file"])
    assert "tool_permission" in codes(v.validate(d))
    d["nodes"][1] = scripted_agent("agent_a", [{"tool": "read_file"}], ["rm_rf"])
    assert "unknown_tool" in codes(v.validate(d))


def tool_wf(extra_node):
    return {"nodes": [node("start", "start"), extra_node, node("end", "end")],
            "edges": [edge("start", extra_node["id"]), edge(extra_node["id"], "end")]}


def messages(result, code):
    return [i.message for i in result.errors if i.code == code]


def test_tool_node_required_arguments():
    v = get_validator()
    # The reported case: a git_clone Tool node with empty args.
    result = v.validate(tool_wf(node("clone", "tool", {"tool": "git_clone", "args": {}})))
    assert any("'repo_url'" in m for m in messages(result, "missing_tool_arg"))
    ok = v.validate(tool_wf(node("clone", "tool", {"tool": "git_clone", "args": {"repo_url": {"ref": "input.repo_url"}}})))
    assert ok.valid, ok.as_dict()
    literal = v.validate(tool_wf(node("clone", "tool", {"tool": "git_clone",
                                                        "args": {"repo_url": "https://github.com/o/r"}})))
    assert literal.valid


def test_tool_argument_names_and_types():
    v = get_validator()
    result = v.validate(tool_wf(node("clone", "tool", {"tool": "git_clone",
                                                       "args": {"repo_url": "https://github.com/o/r", "repo": "x",
                                                                "depth": "deep"}})))
    codes_ = codes(result)
    assert "unknown_tool_arg" in codes_ and "invalid_tool_arg" in codes_


def test_scripted_step_required_arguments():
    v = get_validator()
    bad = tool_wf(scripted_agent("fetch", [{"tool": "git_clone", "args": {"path": "repo"}}], ["git_clone"]))
    assert any("Step 1 (git_clone)" in m and "'repo_url'" in m for m in messages(v.validate(bad), "missing_tool_arg"))
    from app.agents.presets import PRESETS
    preset_node = {"id": "repo_fetch_agent", "type": "agent", "position": {"x": 0, "y": 0},
                   "data": {"label": "fetch", "config": dict(PRESETS["repo_fetch"]["config"])}}
    assert v.validate(tool_wf(preset_node)).valid
