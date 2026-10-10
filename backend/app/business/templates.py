"""Department workflow templates. Each template is a Business Plan; nothing here bypasses the
compiler, policy or registry. Whether a template runs locally is computed from its capabilities."""

from typing import Any


def inp(key: str, label: str, type_: str = "string", required: bool = True, description: str = "", example: Any = None) -> dict[str, Any]:
    return {"key": key, "label": label, "type": type_, "required": required, "description": description, "example": example}


def frm(ref: str) -> dict[str, str]:
    return {"from": ref}


def action(id_: str, title: str, capability: str, params: dict[str, Any], description: str = "", **extra: Any) -> dict[str, Any]:
    return {"id": id_, "kind": "action", "title": title, "capability": capability, "params": params,
            "description": description, **extra}


def decision(id_: str, title: str, branches: list[dict[str, Any]], otherwise: Any) -> dict[str, Any]:
    return {"id": id_, "kind": "decision", "title": title, "branches": branches, "otherwise": otherwise}


def branch(id_: str, label: str, when: dict[str, Any], goto: Any) -> dict[str, Any]:
    return {"id": id_, "label": label, "when": when, "goto": goto}


def approval(id_: str, title: str, department: str, instructions: str = "", on_reject: Any = None, **extra: Any) -> dict[str, Any]:
    step = {"id": id_, "kind": "approval", "title": title, "approver": {"role": "approver", "department": department},
            "instructions": instructions, **extra}
    if on_reject is not None:
        step["on_reject"] = on_reject
    return step


def is_true(ref: str) -> dict[str, Any]:
    return {"op": "is_true", "left": {"ref": ref}}


def is_false(ref: str) -> dict[str, Any]:
    return {"op": "is_false", "left": {"ref": ref}}


def cmp(op: str, ref: str, value: Any) -> dict[str, Any]:
    return {"op": op, "left": {"ref": ref}, "right": {"value": value}}


def plan(title: str, department: str, summary: str, inputs: list[dict[str, Any]], steps: list[dict[str, Any]],
         trigger: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"schema": "bp/1", "title": title, "department": department, "summary": summary,
            "trigger": trigger or {"type": "manual"}, "inputs": inputs, "steps": steps}


TEMPLATES: list[dict[str, Any]] = [
    # -- HR --------------------------------------------------------------------------------
    {"id": "hr_onboarding", "name": "Employee onboarding", "plan": plan(
        "Employee onboarding", "hr",
        "Checks the signed contract, asks IT to prepare equipment, informs the manager and welcomes the new employee.",
        [inp("employee_name", "Employee name", example="Alex Doe"), inp("employee_email", "Employee email", "email"),
         inp("manager_email", "Manager email", "email"), inp("start_date", "Start date", "date"),
         inp("contract", "Signed contract", "file")],
        [action("check_contract", "Check the signed contract", "document.check_required_fields",
                {"file": frm("input.contract"), "fields": ["Start date", "Salary", "Signature"]}),
         decision("contract_complete", "Is the contract complete?",
                  [branch("complete", "Complete", is_true("steps.check_contract.all_present"), "prepare_equipment")],
                  {"fail": "The contract is missing required information"}),
         action("prepare_equipment", "Ask IT to prepare equipment and accounts", "task.assign",
                {"assignee": "member@it", "title": "Prepare laptop and accounts for {{input.employee_name}}",
                 "description": "Start date: {{input.start_date}}", "due_in_days": 3}),
         action("inform_manager", "Inform the manager", "notify.in_app",
                {"recipient": frm("input.manager_email"), "title": "New team member starts {{input.start_date}}",
                 "message": "{{input.employee_name}} joins your team. IT is preparing equipment."}),
         action("welcome_email", "Send the welcome email", "email.send",
                {"to": frm("input.employee_email"), "subject": "Welcome aboard, {{input.employee_name}}!",
                 "body": "We are happy to welcome you on {{input.start_date}}. Your manager will contact you soon."})])},
    {"id": "hr_leave_request", "name": "Leave request approval", "plan": plan(
        "Leave request approval", "hr",
        "Routes a leave request to an approver (HR for long leave) and informs the employee of the decision.",
        [inp("employee_email", "Employee email", "email"), inp("days", "Number of days", "number", example=3),
         inp("start_date", "First day", "date"), inp("reason", "Reason", required=False)],
        [decision("long_leave", "Is it longer than 10 days?",
                  [branch("long", "More than 10 days", cmp("gt", "input.days", 10), "hr_approval")], "manager_approval"),
         approval("hr_approval", "HR approval for long leave", "hr",
                  "Long leave requests need HR approval.", on_reject="notify_rejected", next="notify_approved"),
         approval("manager_approval", "Approver decision", "hr", "Approve or reject the leave request.",
                  on_reject="notify_rejected"),
         action("notify_approved", "Tell the employee it was approved", "notify.in_app",
                {"recipient": frm("input.employee_email"), "title": "Leave approved",
                 "message": "Your {{input.days}}-day leave from {{input.start_date}} was approved."}, next="end"),
         action("notify_rejected", "Tell the employee it was rejected", "notify.in_app",
                {"recipient": frm("input.employee_email"), "title": "Leave not approved",
                 "message": "Your leave request from {{input.start_date}} was not approved. Please talk to your manager."})])},
    {"id": "hr_document_verification", "name": "Document verification", "plan": plan(
        "Employee document verification", "hr",
        "Checks an employee document for required information and creates a follow-up task if anything is missing.",
        [inp("document", "Document", "file"), inp("employee_email", "Employee email", "email")],
        [action("verify", "Verify required information", "document.check_required_fields",
                {"file": frm("input.document"), "fields": ["Full name", "Date of birth", "ID number"]}),
         decision("all_there", "Is everything there?",
                  [branch("yes", "Complete", is_true("steps.verify.all_present"), "record_result")], "follow_up"),
         action("follow_up", "Ask HR to follow up", "task.assign",
                {"assignee": "member@hr", "title": "Missing information for {{input.employee_email}}",
                 "description": "Missing: {{steps.verify.missing}}", "due_in_days": 2}),
         action("record_result", "Record the verification result", "report.create",
                {"title": "Document verification for {{input.employee_email}}",
                 "content": "Found: {{steps.verify.found}}\n\nMissing: {{steps.verify.missing}}"})])},
    # -- Finance ---------------------------------------------------------------------------
    {"id": "finance_invoice", "name": "Invoice processing", "plan": plan(
        "Invoice processing", "finance",
        "Checks an invoice, requires finance-manager approval above 10,000 and notifies accounts payable.",
        [inp("invoice", "Invoice", "file"), inp("amount", "Invoice amount", "number", example=2500),
         inp("supplier", "Supplier name")],
        [action("check_invoice", "Check the invoice details", "document.check_required_fields",
                {"file": frm("input.invoice"), "fields": ["Invoice number", "IBAN", "Total"]}),
         decision("invoice_complete", "Is the invoice complete?",
                  [branch("complete", "Complete", is_true("steps.check_invoice.all_present"), "large_amount")],
                  {"fail": "The invoice is missing required information"}),
         decision("large_amount", "Is the amount over 10,000?",
                  [branch("large", "Over 10,000", cmp("gt", "input.amount", 10000), "finance_manager")],
                  "notify_payables"),
         approval("finance_manager", "Finance manager approval", "finance",
                  "Invoices above 10,000 need a finance manager.", separation_of_duties=True),
         action("notify_payables", "Notify accounts payable", "task.assign",
                {"assignee": "member@finance", "title": "Pay invoice from {{input.supplier}}",
                 "description": "Amount: {{input.amount}}", "due_in_days": 5})])},
    {"id": "finance_expense", "name": "Expense verification", "plan": plan(
        "Expense verification", "finance",
        "Adds up the receipts in a CSV, compares with the claimed total and routes the claim for approval.",
        [inp("receipts", "Receipts (CSV with an Amount column)", "file"),
         inp("claimed_total", "Claimed total", "number", example=420.5), inp("employee_email", "Employee email", "email")],
        [action("add_up", "Add up the receipts", "data.reconcile_total",
                {"file": frm("input.receipts"), "amount_column": "Amount", "expected_total": frm("input.claimed_total"),
                 "tolerance": 1}),
         decision("matches", "Do the receipts match the claim?",
                  [branch("ok", "Matches", is_true("steps.add_up.within_tolerance"), "approve_claim")], "review_task"),
         approval("approve_claim", "Approve the expense claim", "finance", on_reject="notify_employee"),
         action("notify_employee", "Inform the employee", "notify.in_app",
                {"recipient": frm("input.employee_email"), "title": "Expense claim processed",
                 "message": "Your claim of {{input.claimed_total}} has been processed."}, next="end"),
         action("review_task", "Ask finance to review the difference", "task.assign",
                {"assignee": "member@finance", "title": "Expense claim does not match receipts",
                 "description": "Claimed {{input.claimed_total}}, receipts total {{steps.add_up.total}}"})])},
    {"id": "finance_budget_variance", "name": "Budget variance reporting", "plan": plan(
        "Budget variance report", "finance",
        "Summarizes actual spending, compares it to the budget and publishes a variance report.",
        [inp("actuals", "Actual spending (CSV with an Amount column)", "file"),
         inp("budget", "Budget", "number", example=50000), inp("tolerance", "Allowed variance", "number", example=2500)],
        [action("summarize", "Summarize spending", "data.summarize_table", {"file": frm("input.actuals")}),
         action("compare", "Compare with the budget", "data.reconcile_total",
                {"file": frm("input.actuals"), "amount_column": "Amount", "expected_total": frm("input.budget"),
                 "tolerance": frm("input.tolerance")}),
         action("report", "Create the variance report", "report.create",
                {"title": "Budget variance",
                 "content": "{{steps.summarize.summary}}\n\nActual: {{steps.compare.total}}\nBudget: {{input.budget}}\n"
                            "Difference: {{steps.compare.difference}}"}),
         decision("over_budget", "Is the variance too large?",
                  [branch("over", "Outside tolerance", is_false("steps.compare.within_tolerance"),
                          "alert_finance")], "end"),
         action("alert_finance", "Alert the finance team", "notify.in_app",
                {"recipient": "approver@finance", "title": "Budget variance outside tolerance",
                 "message": "Difference: {{steps.compare.difference}}"})])},
    # -- Operations ------------------------------------------------------------------------
    {"id": "ops_daily_report", "name": "Daily report generation", "plan": plan(
        "Daily operations report", "operations",
        "Every weekday morning, fetches yesterday's figures, summarizes them and shares the report.",
        [],
        [action("fetch", "Fetch yesterday's figures", "system.fetch_record", {"path": "/api/reports/daily"}),
         action("summarize", "Summarize the figures", "text.summarize", {"text": "{{steps.fetch.data}}"}),
         action("report", "Create the daily report", "report.create",
                {"title": "Daily operations report", "content": "{{steps.summarize.summary}}"}),
         action("share", "Share with the operations team", "notify.in_app",
                {"recipient": "member@operations", "title": "Daily report ready", "message": "{{steps.summarize.summary}}"})],
        trigger={"type": "schedule", "cron": "0 8 * * 1-5", "timezone": "UTC"})},
    {"id": "ops_escalation", "name": "Service issue escalation", "plan": plan(
        "Service issue escalation", "operations",
        "Classifies a service issue and escalates critical ones to the operations lead and the team channel.",
        [inp("issue", "Issue description"), inp("customer", "Customer")],
        [action("classify", "Assess the urgency", "text.classify",
                {"text": frm("input.issue"), "categories": ["critical", "high", "normal"]}),
         decision("critical", "Is it critical?",
                  [branch("yes", "Critical", cmp("eq", "steps.classify.category", "critical"), "escalate")], "log_issue"),
         action("escalate", "Assign to the operations lead", "task.assign",
                {"assignee": "dept_admin@operations", "title": "CRITICAL: {{input.customer}}",
                 "description": "{{input.issue}}\n\nWhy: {{steps.classify.reason}}", "due_in_days": 0}),
         action("announce", "Alert the team channel", "chat.post_message",
                {"text": "Critical issue for {{input.customer}}: {{steps.classify.reason}}"}, next="end"),
         action("log_issue", "Queue for the team", "notify.in_app",
                {"recipient": "member@operations", "title": "New {{steps.classify.category}} issue",
                 "message": "{{input.customer}}: {{input.issue}}"})])},
    # -- IT --------------------------------------------------------------------------------
    {"id": "it_access_request", "name": "Access request approval", "plan": plan(
        "Access request approval", "it",
        "Gets approval for a system access request, provisions it in the identity system and informs the requester.",
        [inp("requester_email", "Requester email", "email"), inp("system", "System"),
         inp("access_level", "Access level", example="read-only"), inp("justification", "Business justification")],
        [approval("approve_access", "Approve the access request", "it",
                  "Check that the justification matches the requested access level."),
         action("provision", "Grant the access", "system.update_record",
                {"path": "/api/access-grants", "data": {"user": frm("input.requester_email"), "system": frm("input.system"),
                                                         "level": frm("input.access_level")}}),
         action("inform", "Inform the requester", "notify.in_app",
                {"recipient": frm("input.requester_email"), "title": "Access granted",
                 "message": "You now have {{input.access_level}} access to {{input.system}}."})])},
    {"id": "it_incident_analysis", "name": "Incident analysis", "plan": plan(
        "Incident analysis", "it",
        "Reads an incident report, rates its severity, writes a summary report and escalates major incidents.",
        [inp("report_file", "Incident report", "file")],
        [action("read", "Read the incident report", "document.extract_text", {"file": frm("input.report_file")}),
         action("severity", "Rate the severity", "text.classify",
                {"text": "{{steps.read.text}}", "categories": ["major", "minor"]}),
         action("summary", "Summarize the incident", "text.summarize", {"text": "{{steps.read.text}}"}),
         action("report", "Create the incident report", "report.create",
                {"title": "Incident analysis", "content": "Severity: {{steps.severity.category}}\n\n{{steps.summary.summary}}"}),
         decision("major", "Is it a major incident?",
                  [branch("yes", "Major", cmp("eq", "steps.severity.category", "major"), "escalate")], "end"),
         action("escalate", "Escalate to the IT lead", "task.assign",
                {"assignee": "dept_admin@it", "title": "Major incident", "description": "{{steps.summary.summary}}",
                 "due_in_days": 0})])},
    # -- Software development ----------------------------------------------------------------
    {"id": "eng_requirement_analysis", "name": "Requirement analysis", "plan": plan(
        "Requirement analysis", "engineering",
        "Fetches the repository and breaks a requirement into implementation tasks in a report.",
        [inp("requirement", "Requirement"), inp("repo_url", "Repository URL", example="https://github.com/octocat/Hello-World")],
        [action("fetch", "Get the code", "code.fetch_repository", {"repo_url": frm("input.repo_url")}),
         action("analyze", "Analyze the requirement", "code.analyze_requirement", {"requirement": frm("input.requirement")}),
         action("report", "Write the analysis report", "report.create",
                {"title": "Requirement analysis", "content": "{{steps.analyze.summary}}\n\nTasks: {{steps.analyze.tasks}}"})])},
    {"id": "eng_code_generation", "name": "Code generation", "plan": plan(
        "Code generation", "engineering",
        "Implements a requirement with AI, runs the tests, retries up to three times and packages the change.",
        [inp("requirement", "Requirement"), inp("repo_url", "Repository URL")],
        [action("fetch", "Get the code", "code.fetch_repository", {"repo_url": frm("input.repo_url")}),
         action("plan_work", "Plan the change", "code.analyze_requirement", {"requirement": frm("input.requirement")}),
         action("implement", "Write the code", "code.implement_change",
                {"requirement": frm("input.requirement"), "plan": frm("steps.plan_work.tasks")}),
         action("test", "Run the tests", "code.run_tests", {}),
         decision("tests_ok", "Did the tests pass?",
                  [branch("pass", "Passed", is_true("steps.test.tests_passed"), "package"),
                   branch("retry", "Try again (max 3)", cmp("lt", "steps.implement.attempts", 3), "implement")],
                  {"fail": "Tests still fail after three attempts"}),
         action("package", "Package the change", "code.create_patch", {"name": "change.patch"})])},
    {"id": "eng_test_and_review", "name": "Testing and code review", "plan": plan(
        "Testing and code review", "engineering",
        "Runs the tests, has the change reviewed and requires approval before packaging it.",
        [inp("repo_url", "Repository URL"), inp("requirement", "What the change should do", required=False)],
        [action("fetch", "Get the code", "code.fetch_repository", {"repo_url": frm("input.repo_url")}),
         action("test", "Run the tests", "code.run_tests", {}),
         decision("tests_ok", "Did the tests pass?",
                  [branch("pass", "Passed", is_true("steps.test.tests_passed"), "review")],
                  {"fail": "The tests are failing"}),
         action("review", "Review the change", "code.review_change", {"requirement": frm("input.requirement")}),
         decision("review_ok", "Is the review good enough?",
                  [branch("good", "Score 7 or more", cmp("gte", "steps.review.score", 7), "lead_approval")],
                  {"fail": "The review score is too low"}),
         approval("lead_approval", "Team lead approval", "engineering"),
         action("package", "Package the change", "code.create_patch", {"name": "reviewed.patch"})])},
    {"id": "eng_run_tests", "name": "Run a repository's tests", "plan": plan(
        "Repository test run", "engineering",
        "Fetches a public repository, runs its tests and records the result. Runs without any AI model.",
        [inp("repo_url", "Repository URL")],
        [action("fetch", "Get the code", "code.fetch_repository", {"repo_url": frm("input.repo_url")}),
         action("test", "Run the tests", "code.run_tests", {}),
         decision("tests_ok", "Did the tests pass?",
                  [branch("pass", "Passed", is_true("steps.test.tests_passed"), "report")],
                  {"fail": "The tests are failing"}),
         action("report", "Record the result", "report.create",
                {"title": "Test results", "content": "{{steps.test.summary}}"})])},
]

def get_template(template_id: str) -> dict[str, Any] | None:
    return next((t for t in TEMPLATES if t["id"] == template_id), None)
