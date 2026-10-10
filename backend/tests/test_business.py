"""Business Plan layer: compiler determinism, stable ids, policy, operations, graph round trip."""

import copy
import json

import pytest

from app.business.compiler import compile_plan
from app.business.explain import explain_plan
from app.business.graph_edit import graph_to_operations
from app.business.operations import OperationError, apply_operations, diff_plans, parse_operations
from app.business.plan import BusinessPlan
from app.business.policy import PolicyContext, apply_policy
from app.services.execution import get_validator


def invoice_plan(**overrides) -> BusinessPlan:
    data = {
        "schema": "bp/1",
        "title": "Invoice processing",
        "department": "finance",
        "inputs": [{"key": "invoice", "label": "Invoice", "type": "file"},
                   {"key": "amount", "label": "Amount", "type": "number"}],
        "steps": [
            {"id": "check_invoice", "kind": "action", "title": "Check invoice details",
             "capability": "document.check_required_fields",
             "params": {"file": {"from": "input.invoice"}, "fields": ["Invoice number", "IBAN"]}},
            {"id": "complete", "kind": "decision", "title": "Invoice complete?",
             "branches": [{"id": "yes", "label": "Complete", "goto": "large",
                           "when": {"op": "is_true", "left": {"ref": "steps.check_invoice.all_present"}}}],
             "otherwise": {"fail": "Invoice is incomplete"}},
            {"id": "large", "kind": "decision", "title": "Large amount?",
             "branches": [{"id": "big", "label": "Over 10,000", "goto": "notify_finance",
                           "when": {"op": "gt", "left": {"ref": "input.amount"}, "right": {"value": 10000}}}],
             "otherwise": "notify_finance"},
            {"id": "notify_finance", "kind": "action", "title": "Notify finance team",
             "capability": "notify.in_app",
             "params": {"recipient": "approver@finance", "title": "Invoice received",
                        "message": "Invoice {{input.amount}} is ready"}},
        ],
    }
    data.update(overrides)
    return BusinessPlan.model_validate(data)


CTX = PolicyContext(department="finance", connected={"llm", "smtp", "http", "chat"},
                    departments={"hr", "finance", "operations", "it", "engineering"})


def test_compilation_is_deterministic_and_valid():
    plan = invoice_plan()
    a, b = compile_plan(plan), compile_plan(BusinessPlan.model_validate(json.loads(json.dumps(plan.dump()))))
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    assert a["meta"]["compiler_version"] and a["meta"]["registry_version"] and len(a["meta"]["plan_hash"]) == 16
    result = get_validator().validate(a)
    assert result.valid, result.as_dict()
    ids = {n["id"] for n in a["nodes"]}
    assert {"start", "check_invoice", "complete", "large", "notify_finance", "end"} <= ids
    assert any(n["type"] == "fail" for n in a["nodes"])
    biz = next(n for n in a["nodes"] if n["id"] == "check_invoice")["data"]["business"]
    assert biz["app"] == "Built-in document tools" and biz["produces"]


def test_stable_ids_across_edits():
    plan = invoice_plan()
    before = compile_plan(plan)
    edited = apply_operations(plan, parse_operations([
        {"op": "add_step", "after": "check_invoice",
         "step": {"kind": "wait", "title": "Wait for bank cut-off", "seconds": 60}},
        {"op": "update_step", "step_id": "notify_finance", "title": "Tell finance"},
    ]))
    after = compile_plan(edited)
    old_nodes = {n["id"]: n for n in before["nodes"]}
    new_nodes = {n["id"]: n for n in after["nodes"]}
    for sid in ("check_invoice", "complete", "large"):
        assert old_nodes[sid]["data"]["config"] == new_nodes[sid]["data"]["config"]
    assert "wait_for_bank_cut_off" in new_nodes and new_nodes["notify_finance"]["data"]["label"] == "Tell finance"
    assert before["meta"]["plan_hash"] != after["meta"]["plan_hash"]


def test_operations_are_transactional():
    plan = invoice_plan()
    snapshot = plan.dump()
    with pytest.raises(OperationError):
        apply_operations(plan, parse_operations([
            {"op": "rename", "title": "Renamed"},
            {"op": "remove_step", "step_id": "does_not_exist"},
        ]))
    assert plan.dump() == snapshot  # nothing applied
    with pytest.raises(OperationError, match="used by"):
        apply_operations(plan, parse_operations([{"op": "remove_step", "step_id": "check_invoice"}]))


def test_remove_step_reconnects_flow_and_diff_is_meaningful():
    plan = invoice_plan()
    new = apply_operations(plan, parse_operations([
        {"op": "remove_step", "step_id": "large"},
        {"op": "set_retry", "step_id": "notify_finance", "max_attempts": 3, "backoff_seconds": 10},
    ]))
    complete = new.step("complete")
    assert complete.branches[0].goto == "notify_finance"
    diff = diff_plans(plan, new)
    assert [r["step_id"] for r in diff["removed"]] == ["large"]
    changed = {c["step_id"]: [f["field"] for f in c["fields"]] for c in diff["changed"]}
    assert "retry" in changed["notify_finance"] and "branches" in changed["complete"]


def test_policy_inserts_mandatory_approval_and_separation_of_duties():
    plan = invoice_plan()
    plan = apply_operations(plan, parse_operations([
        {"op": "add_step", "step": {"id": "pay", "kind": "action", "title": "Pay supplier",
                                    "capability": "finance.submit_payment",
                                    "params": {"path": "/api/payments", "data": {"amount": {"from": "input.amount"}}}}},
        {"op": "add_step", "after": "notify_finance",
         "step": {"id": "email_supplier", "kind": "action", "title": "Email supplier", "capability": "email.send",
                  "params": {"to": "ap@supplier.example", "subject": "Paid", "body": "Done"}}},
    ]))
    result = apply_policy(plan, CTX)
    ids = [s.id for s in result.plan.steps]
    assert ids.index("approval_before_email_supplier") == ids.index("email_supplier") - 1
    pay_approval = result.plan.step("approval_before_pay")
    assert pay_approval is not None and pay_approval.policy_inserted and pay_approval.separation_of_duties
    assert not result.errors, [f.as_dict() for f in result.errors]
    # Policy-inserted approvals cannot be removed by an edit.
    with pytest.raises(OperationError, match="required by policy"):
        apply_operations(result.plan, parse_operations([{"op": "remove_step", "step_id": "approval_before_pay"}]))
    # Applying policy again is a no-op (idempotent).
    again = apply_policy(result.plan, CTX)
    assert [s.id for s in again.plan.steps] == ids


def test_existing_approval_on_every_path_is_respected():
    plan = invoice_plan()
    plan = apply_operations(plan, parse_operations([
        {"op": "add_step", "after": "notify_finance",
         "step": {"id": "email_supplier", "kind": "action", "title": "Email supplier", "capability": "email.send",
                  "params": {"to": "ap@supplier.example", "subject": "Paid", "body": "Done"}}},
        {"op": "add_approval_before", "step_id": "email_supplier", "title": "Manager approval"},
    ]))
    result = apply_policy(plan, CTX)
    assert not any(s.policy_inserted for s in result.plan.steps)


def test_department_restrictions_and_setup_requirements():
    plan = invoice_plan(department="hr")
    plan = apply_operations(plan, parse_operations([
        {"op": "add_step", "step": {"id": "pay", "kind": "action", "title": "Pay", "capability": "finance.submit_payment",
                                    "params": {"path": "/api/p", "data": {}}}},
        {"op": "add_step", "step": {"id": "magic", "kind": "action", "title": "Teleport invoice",
                                    "capability": "quantum.teleport", "params": {}}},
    ]))
    result = apply_policy(plan, PolicyContext(department="hr", connected=set(), departments={"hr", "finance"}))
    codes = {(f.code, f.step_id) for f in result.findings}
    assert ("capability_restricted", "pay") in codes          # finance-only capability in HR
    assert ("connection_required", "pay") in codes             # no HTTP connection
    assert ("capability_unavailable", "magic") in codes        # never faked or substituted
    with pytest.raises(Exception):
        compile_plan(result.plan)  # unknown capabilities cannot compile into fake implementations


def test_missing_required_params_and_bad_refs():
    plan = invoice_plan()
    plan = apply_operations(plan, parse_operations([
        {"op": "update_step", "step_id": "notify_finance", "params": {"recipient": None,
                                                                       "message": "{{steps.nope.value}}"}},
    ]))
    codes = {f.code for f in apply_policy(plan, CTX).findings}
    assert {"missing_param", "invalid_reference"} <= codes


def test_graph_round_trip_supported_edits():
    plan = invoice_plan()
    definition = compile_plan(plan)
    edited = copy.deepcopy(definition)
    node = next(n for n in edited["nodes"] if n["id"] == "notify_finance")
    node["data"]["label"] = "Notify the finance team"
    node["data"]["config"]["args"]["title"] = "New invoice"
    node["data"]["config"]["retry"] = {"max_attempts": 2, "backoff_seconds": 1}
    node["position"] = {"x": 999, "y": 42}
    cond = next(n for n in edited["nodes"] if n["id"] == "large")
    cond["data"]["config"]["branches"][0]["rule"]["right"]["value"] = 5000
    ops, unsupported = graph_to_operations(plan, edited)
    assert unsupported == []
    new_plan = apply_operations(plan, ops)
    step = new_plan.step("notify_finance")
    assert step.title == "Notify the finance team" and step.params["title"] == "New invoice"
    assert step.retry.max_attempts == 2
    assert new_plan.step("large").branches[0].when["right"]["value"] == 5000
    assert new_plan.ui["positions"]["notify_finance"] == {"x": 999, "y": 42}
    recompiled = compile_plan(new_plan)
    assert next(n for n in recompiled["nodes"] if n["id"] == "notify_finance")["position"] == {"x": 999, "y": 42}


def test_graph_add_approval_rewire_and_delete():
    plan = invoice_plan()
    edited = compile_plan(plan)
    # Insert an approval between "large" (otherwise) and notify_finance, drawn by hand.
    edited["nodes"].append({"id": "cfo_ok", "type": "approval", "position": {"x": 0, "y": 0},
                            "data": {"label": "CFO approval", "config": {"title": "CFO approval"}}})
    for e in edited["edges"]:
        if e["source"] == "large" and e["sourceHandle"] == "otherwise":
            e["target"] = "cfo_ok"
            e["id"] = "e_large_otherwise_cfo_ok"
    edited["edges"].append({"id": "x1", "source": "cfo_ok", "target": "notify_finance", "sourceHandle": "approved", "targetHandle": "in"})
    fail = next(n for n in edited["nodes"] if n["type"] == "fail")
    edited["edges"].append({"id": "x2", "source": "cfo_ok", "target": fail["id"], "sourceHandle": "rejected", "targetHandle": "in"})
    ops, unsupported = graph_to_operations(plan, edited)
    assert unsupported == []
    new_plan = apply_operations(plan, ops)
    assert new_plan.step("large").otherwise == "cfo_ok"
    compiled = compile_plan(new_plan)
    flow = {(e["source"], e["sourceHandle"]): e["target"] for e in compiled["edges"]}
    assert flow[("cfo_ok", "approved")] == "notify_finance"
    assert flow[("large", "otherwise")] == "cfo_ok"
    assert flow[("notify_finance", "out")] == "end"  # the old last step still finishes (no accidental loop)
    assert get_validator().validate(compiled).valid


def test_graph_unsupported_edits_are_explained_not_dropped():
    plan = invoice_plan()
    edited = compile_plan(plan)
    edited["nodes"].append({"id": "fork", "type": "parallel", "position": {"x": 0, "y": 0}, "data": {"label": "Fork", "config": {}}})
    edited["nodes"].append({"id": "custom_ai", "type": "agent", "position": {"x": 0, "y": 0},
                            "data": {"label": "Custom AI", "config": {"kind": "llm", "tools": ["email_send"]}}})
    edited["edges"].append({"id": "dup", "source": "check_invoice", "target": "end", "sourceHandle": "out", "targetHandle": "in"})
    ops, unsupported = graph_to_operations(plan, edited)
    messages = " ".join(u.message for u in unsupported)
    assert "Parallel branches" in messages and "cannot be added" in messages and "only continue to one" in messages
    assert len(unsupported) >= 3


def test_explanation_is_business_language():
    plan = apply_policy(invoice_plan(), CTX).plan
    explanation = explain_plan(plan, [], {})
    decision = next(s for s in explanation["steps"] if s["step_id"] == "large")
    assert "the request's 'amount' is more than 10000" in decision["rules"][0]
    assert explanation["trigger"].startswith("Started manually")
    assert any("Invoice is incomplete" in o for o in explanation["outcomes"])
