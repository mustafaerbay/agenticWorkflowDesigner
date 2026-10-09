import pytest

from app.orchestration.conditions import EvalContext, RuleError, check_rule_structure, evaluate


def ctx() -> EvalContext:
    return EvalContext(
        {"requirement": "add feature", "threshold": 80},
        {"testing_agent": {"tests_passed": True, "coverage": 85.5, "tags": ["fast", "unit"], "nested": {"score": 7}},
         "review": {"score": 6, "approved": False, "summary": "needs work"}},
        statuses={"testing_agent": "COMPLETED"},
        run_counts={"fix_agent": 2},
        steps=9,
    )


def cmp(op, left, right):
    return {"op": op, "left": left, "right": right}


@pytest.mark.parametrize("rule,expected", [
    (cmp("eq", {"ref": "testing_agent.output.tests_passed"}, {"value": True}), True),
    (cmp("neq", {"ref": "review.output.approved"}, {"value": True}), True),
    (cmp("gt", {"ref": "testing_agent.output.coverage"}, {"value": 80}), True),
    (cmp("gte", {"ref": "review.output.score"}, {"value": 7}), False),
    (cmp("gte", {"ref": "testing_agent.output.nested.score"}, {"value": 7}), True),
    (cmp("lt", {"ref": "fix_agent.runs"}, {"value": 3}), True),
    (cmp("lte", {"ref": "run.steps"}, {"value": 9}), True),
    (cmp("contains", {"ref": "review.output.summary"}, {"value": "work"}), True),
    (cmp("contains", {"ref": "testing_agent.output.tags"}, {"value": "unit"}), True),
    (cmp("gt", {"ref": "testing_agent.output.coverage"}, {"ref": "input.threshold"}), True),
    ({"op": "exists", "left": {"ref": "testing_agent.output.coverage"}}, True),
    ({"op": "exists", "left": {"ref": "missing_node.output.x"}}, False),
    ({"op": "is_true", "left": {"ref": "testing_agent.output.tests_passed"}}, True),
    ({"op": "is_false", "left": {"ref": "review.output.approved"}}, True),
    (cmp("eq", {"ref": "testing_agent.status"}, {"value": "COMPLETED"}), True),
])
def test_operators(rule, expected):
    assert evaluate(rule, ctx()) is expected


def test_boolean_composition():
    passed = {"op": "is_true", "left": {"ref": "testing_agent.output.tests_passed"}}
    good_review = cmp("gte", {"ref": "review.output.score"}, {"value": 7})
    assert evaluate({"op": "and", "rules": [passed, good_review]}, ctx()) is False
    assert evaluate({"op": "or", "rules": [passed, good_review]}, ctx()) is True
    assert evaluate({"op": "not", "rule": good_review}, ctx()) is True


def test_type_strictness():
    # Booleans never equal numbers; numeric comparisons on non-numbers are false, not errors.
    assert evaluate(cmp("eq", {"value": True}, {"value": 1}), ctx()) is False
    assert evaluate(cmp("gt", {"ref": "review.output.summary"}, {"value": 1}), ctx()) is False
    assert evaluate(cmp("gt", {"ref": "missing.output.x"}, {"value": 1}), ctx()) is False


def test_rejects_code_and_bad_refs():
    with pytest.raises(RuleError):
        evaluate(cmp("eq", {"ref": "__import__('os').system('id')"}, {"value": 1}), ctx())
    with pytest.raises(RuleError):
        evaluate({"op": "exec", "left": {"value": 1}}, ctx())
    assert check_rule_structure({"op": "and", "rules": []})
    assert check_rule_structure(cmp("gt", {"ref": "a.output.x"}, {"value": "high"}))
    assert check_rule_structure(cmp("eq", {"ref": "a.output.x"}, {"value": 1})) == []
