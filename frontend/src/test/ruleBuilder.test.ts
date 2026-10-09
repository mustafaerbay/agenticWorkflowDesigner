import { describe, expect, it } from "vitest";
import type { Rule } from "@/types";
import {
  addChild,
  describeRule,
  newComparison,
  newGroup,
  operandFromUI,
  operandToUI,
  removeNode,
  ruleErrors,
  ruleToUI,
  toggleNot,
  uiToRule,
  type RuleUI,
} from "@/workflow/ruleBuilder";

const complex: Rule = {
  op: "or",
  rules: [
    {
      op: "and",
      rules: [
        { op: "eq", left: { ref: "testing_agent.output.tests_passed" }, right: { value: true } },
        { op: "gte", left: { ref: "testing_agent.output.coverage" }, right: { value: 80 } },
      ],
    },
    { op: "not", rule: { op: "contains", left: { ref: "review.output.labels" }, right: { value: "blocker" } } },
    { op: "exists", left: { ref: "input.ticket" } },
    { op: "is_true", left: { ref: "deploy.output.approved" } },
    { op: "is_false", left: { ref: "x.output.flag" } },
    { op: "lt", left: { ref: "fix_agent.runs" }, right: { value: 3 } },
    { op: "neq", left: { ref: "a.status" }, right: { value: null } },
    { op: "eq", left: { ref: "a.output.list" }, right: { value: [1, "two", { three: 3 }] } },
    { op: "lte", left: { value: 1.5 }, right: { ref: "b.output.score" } },
  ],
};

describe("rule builder serialization", () => {
  it("round-trips every operator and operand kind exactly", () => {
    expect(uiToRule(ruleToUI(complex))).toEqual(complex);
  });

  it("maps operands to typed UI literals", () => {
    expect(operandToUI({ value: 80 })).toEqual({ mode: "value", valueType: "number", raw: "80" });
    expect(operandToUI({ value: false })).toEqual({ mode: "value", valueType: "boolean", raw: "false" });
    expect(operandToUI({ value: null })).toEqual({ mode: "value", valueType: "null", raw: "" });
    expect(operandToUI({ value: "x" })).toEqual({ mode: "value", valueType: "string", raw: "x" });
    expect(operandToUI({ ref: "a.output.b" })).toEqual({ mode: "ref", ref: "a.output.b" });
  });

  it("parses typed literals from UI input", () => {
    expect(operandFromUI({ mode: "value", valueType: "number", raw: "7.5" })).toEqual({ value: 7.5 });
    expect(operandFromUI({ mode: "value", valueType: "boolean", raw: "true" })).toEqual({ value: true });
    expect(operandFromUI({ mode: "value", valueType: "null", raw: "anything" })).toEqual({ value: null });
    expect(operandFromUI({ mode: "value", valueType: "string", raw: "42" })).toEqual({ value: "42" });
    expect(operandFromUI({ mode: "ref", ref: "  a.output.x " })).toEqual({ ref: "a.output.x" });
  });

  it("unary ops serialize without a right operand", () => {
    const ui: RuleUI = { ...(newComparison() as Extract<RuleUI, { kind: "cmp" }>), op: "exists", left: { mode: "ref", ref: "input.x" } };
    expect(uiToRule(ui)).toEqual({ op: "exists", left: { ref: "input.x" } });
  });

  it("supports building a tree via immutable edits", () => {
    let root = newGroup("and", []);
    const c1 = newComparison();
    root = addChild(root, root.id, c1);
    const sub = newGroup("or", []);
    root = addChild(root, root.id, sub);
    root = addChild(root, sub.id, newComparison());
    root = toggleNot(root, c1.id);
    const rule = uiToRule(root);
    expect(rule).toEqual({
      op: "and",
      rules: [
        { op: "not", rule: { op: "eq", left: { ref: "" }, right: { value: true } } },
        { op: "or", rules: [{ op: "eq", left: { ref: "" }, right: { value: true } }] },
      ],
    });
    // un-NOT
    const notId = root.kind === "group" ? root.children[0]!.id : "";
    root = toggleNot(root, notId);
    expect(uiToRule(root)).toMatchObject({ rules: [{ op: "eq" }, { op: "or" }] });
    // remove sub group
    root = removeNode(root, sub.id);
    expect(uiToRule(root)).toEqual({ op: "and", rules: [{ op: "eq", left: { ref: "" }, right: { value: true } }] });
  });

  it("reports validation errors", () => {
    const root = ruleToUI({ op: "and", rules: [{ op: "gt", left: { ref: "" }, right: { value: 1 } }] });
    expect(ruleErrors(root)).toContain("Choose a value reference");
    expect(ruleErrors(ruleToUI({ op: "or", rules: [] }))).toEqual(["OR group has no conditions"]);
    expect(ruleErrors(ruleToUI(complex))).toEqual([]);
  });

  it("describes rules readably", () => {
    expect(
      describeRule({ op: "and", rules: [{ op: "eq", left: { ref: "t.output.ok" }, right: { value: true } }, { op: "not", rule: { op: "exists", left: { ref: "x" } } }] }),
    ).toBe("t.output.ok == true AND NOT (x exists)");
  });
});
