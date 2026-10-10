"""Capability registry: what business steps can do, independent of how it is implemented.

The planner (LLM) may only reference capability ids from this registry. Python resolves each
capability to a concrete tool or agent; the LLM never chooses implementations or permissions.
"""

from dataclasses import dataclass, field
from typing import Any, Literal

REGISTRY_VERSION = "2026.10.1"

SideEffect = Literal["none", "internal", "communication", "external_write", "financial"]
Connector = Literal["llm", "smtp", "http", "chat"]
DEPARTMENTS = ("hr", "finance", "operations", "it", "engineering")
ALL = ("*",)
SENSITIVE_EFFECTS = {"communication", "external_write", "financial"}

CONNECTOR_LABELS = {
    "llm": "AI model provider",
    "smtp": "Email (SMTP)",
    "http": "Business system (HTTP API)",
    "chat": "Slack / Microsoft Teams",
}


@dataclass(frozen=True)
class FieldSpec:
    key: str
    label: str
    type: str = "string"  # string | number | boolean | file | list | object
    required: bool = True
    description: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {"key": self.key, "label": self.label, "type": self.type, "required": self.required,
                "description": self.description}


JSON_TYPES = {"string": "string", "number": "number", "boolean": "boolean", "file": "string",
              "list": "array", "object": "object"}


@dataclass(frozen=True)
class Capability:
    id: str
    name: str
    description: str
    category: str
    app: str
    inputs: tuple[FieldSpec, ...]
    outputs: tuple[FieldSpec, ...]
    implementation: dict[str, Any]
    sample_output: dict[str, Any]
    side_effect: SideEffect = "none"
    sensitivity: Literal["low", "medium", "high"] = "low"
    departments: tuple[str, ...] = ALL
    connector: Connector | None = None
    keywords: tuple[str, ...] = field(default_factory=tuple)

    @property
    def needs_approval(self) -> bool:
        return self.side_effect in SENSITIVE_EFFECTS

    def allowed_for(self, department: str | None) -> bool:
        return "*" in self.departments or (department is not None and department in self.departments)

    def output_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {f.key: {"type": JSON_TYPES.get(f.type, "string")} for f in self.outputs},
            "required": [f.key for f in self.outputs if f.required],
        }

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id, "name": self.name, "description": self.description, "category": self.category,
            "app": self.app, "inputs": [f.as_dict() for f in self.inputs],
            "outputs": [f.as_dict() for f in self.outputs], "side_effect": self.side_effect,
            "sensitivity": self.sensitivity, "departments": list(self.departments), "connector": self.connector,
            "connector_label": CONNECTOR_LABELS.get(self.connector or "", None),
            "needs_approval": self.needs_approval,
            "implementation": {"kind": self.implementation["kind"],
                               "name": self.implementation.get("tool") or self.implementation.get("agent")},
        }


def F(key: str, label: str, type_: str = "string", required: bool = True, description: str = "") -> FieldSpec:
    return FieldSpec(key, label, type_, required, description)


def tool(name: str, args: dict[str, str] | None = None, fixed: dict[str, Any] | None = None) -> dict[str, Any]:
    """Tool implementation; `args` maps tool argument -> capability input key."""
    return {"kind": "tool", "tool": name, "args": args or {}, "fixed": fixed or {}}


def agent(name: str, instructions: str, tools: list[str]) -> dict[str, Any]:
    return {"kind": "agent", "agent": name, "instructions": instructions, "tools": tools}


CAPABILITIES: dict[str, Capability] = {c.id: c for c in [
    # -- documents ------------------------------------------------------------------------
    Capability(
        "document.extract_text", "Read a document",
        "Reads the text of an uploaded document (PDF, text, Markdown or CSV).", "Documents",
        "Built-in document tools", (F("file", "Document", "file"),),
        (F("text", "Document text"), F("pages", "Pages", "number"), F("chars", "Characters", "number")),
        tool("doc_extract_text", {"file": "file"}),
        {"text": "(sample document text)", "pages": 1, "chars": 22}, keywords=("read", "pdf", "document")),
    Capability(
        "document.check_required_fields", "Check required information in a document",
        "Checks that a document mentions every required item (for example 'IBAN' or 'Date of birth').",
        "Documents", "Built-in document tools",
        (F("file", "Document", "file"), F("fields", "Required items", "list")),
        (F("all_present", "All items present", "boolean"), F("missing", "Missing items", "list"),
         F("found", "Found items", "list")),
        tool("doc_check_fields", {"file": "file", "fields": "fields"}),
        {"all_present": True, "missing": [], "found": ["(sample item)"]},
        keywords=("verify", "complete", "required", "fields")),
    Capability(
        "document.extract_fields", "Extract information from a document",
        "Uses AI to pull specific values (names, amounts, dates...) out of a document.", "Documents",
        "AI document analysis", (F("file", "Document", "file"), F("fields", "Information to extract", "list")),
        (F("fields", "Extracted values", "object"), F("missing", "Values not found", "list"),
         F("all_present", "Everything found", "boolean"), F("summary", "Summary")),
        agent("document_analysis", "Extract exactly the requested fields from the document. Use null for "
              "values that are not present and list them in 'missing'.", ["doc_extract_text"]),
        {"fields": {"(field)": "(sample value)"}, "missing": [], "all_present": True, "summary": "(sample)"},
        sensitivity="medium", connector="llm", keywords=("extract", "invoice", "amount", "parse")),
    Capability(
        "document.compare", "Compare two documents",
        "Uses AI to compare two documents and list the differences.", "Documents", "AI document analysis",
        (F("file_a", "First document", "file"), F("file_b", "Second document", "file"),
         F("focus", "What to compare", required=False)),
        (F("match", "Documents match", "boolean"), F("differences", "Differences", "list"), F("summary", "Summary")),
        agent("document_analysis", "Compare the two documents and list concrete differences.", ["doc_extract_text"]),
        {"match": True, "differences": [], "summary": "(sample)"}, sensitivity="medium", connector="llm",
        keywords=("compare", "match", "difference")),
    # -- data -------------------------------------------------------------------------------
    Capability(
        "data.summarize_table", "Summarize a spreadsheet",
        "Counts rows and calculates totals, minimum, maximum and average for each numeric column of a CSV file.",
        "Data", "Built-in data tools", (F("file", "CSV file", "file"),),
        (F("rows", "Rows", "number"), F("columns", "Columns", "list"), F("totals", "Totals per column", "object"),
         F("summary", "Summary")),
        tool("data_summarize_csv", {"file": "file"}),
        {"rows": 3, "columns": ["(column)"], "totals": {"(column)": 0}, "summary": "(sample)"},
        keywords=("csv", "spreadsheet", "totals", "report")),
    Capability(
        "data.reconcile_total", "Check a total against an expected amount",
        "Adds up a column of a CSV file and compares it with an expected total within a tolerance.", "Data",
        "Built-in data tools",
        (F("file", "CSV file", "file"), F("amount_column", "Amount column"), F("expected_total", "Expected total", "number"),
         F("tolerance", "Allowed difference", "number", required=False)),
        (F("total", "Calculated total", "number"), F("difference", "Difference", "number"),
         F("within_tolerance", "Within tolerance", "boolean")),
        tool("data_reconcile", {"file": "file", "amount_column": "amount_column", "expected_total": "expected_total",
                                "tolerance": "tolerance"}),
        {"total": 100.0, "difference": 0.0, "within_tolerance": True}, keywords=("variance", "budget", "reconcile")),
    Capability(
        "data.analyze", "Analyze data and find issues",
        "Uses AI to analyze a dataset, answer a question about it and flag anomalies.", "Data", "AI data analysis",
        (F("file", "Data file", "file"), F("question", "What to look for")),
        (F("summary", "Summary"), F("findings", "Findings", "list"), F("anomalies_found", "Issues found", "boolean")),
        agent("data_analysis", "Analyze the data to answer the question. Report concrete findings and whether "
              "anomalies were found.", ["data_summarize_csv", "doc_extract_text"]),
        {"summary": "(sample)", "findings": [], "anomalies_found": False}, sensitivity="medium", connector="llm",
        keywords=("analyze", "anomaly", "discrepancy", "trend")),
    # -- text / AI ----------------------------------------------------------------------
    Capability(
        "text.summarize", "Summarize text",
        "Uses AI to write a short summary of a piece of text.", "Writing", "AI writing assistant",
        (F("text", "Text"),), (F("summary", "Summary"),),
        agent("communication", "Write a concise, neutral summary.", []), {"summary": "(sample summary)"},
        connector="llm", keywords=("summarize", "summary")),
    Capability(
        "text.classify", "Classify a request",
        "Uses AI to sort a text into one of the given categories (for example urgency or request type).",
        "Writing", "AI writing assistant", (F("text", "Text"), F("categories", "Categories", "list")),
        (F("category", "Category"), F("confidence", "Confidence (0-1)", "number"), F("reason", "Reason")),
        agent("data_analysis", "Choose exactly one of the given categories.", []),
        {"category": "(first category)", "confidence": 0.9, "reason": "(sample)"}, connector="llm",
        keywords=("classify", "categorize", "triage", "priority")),
    Capability(
        "text.draft_message", "Draft a message",
        "Uses AI to draft an email or message. Drafting never sends anything.", "Communication",
        "AI writing assistant",
        (F("purpose", "Purpose of the message"), F("context", "Details to include", required=False),
         F("tone", "Tone", required=False)),
        (F("subject", "Subject"), F("body", "Message")),
        agent("communication", "Draft a clear, professional message. Do not invent facts.", []),
        {"subject": "(sample subject)", "body": "(sample message)"}, connector="llm",
        keywords=("draft", "write", "email", "letter")),
    # -- communication ---------------------------------------------------------------------
    Capability(
        "notify.in_app", "Notify a person in the app",
        "Sends an in-app notification to a user (by email) or to a department role (for example "
        "'approver@finance').", "Communication", "Inbox (built-in)",
        (F("recipient", "Recipient"), F("title", "Title"), F("message", "Message")),
        (F("notification_id", "Notification"), F("recipients", "Recipients", "number")),
        tool("notify_user", {"recipient": "recipient", "title": "title", "message": "message"}),
        {"notification_id": "(simulated)", "recipients": 1}, side_effect="internal",
        keywords=("notify", "inform", "alert")),
    Capability(
        "task.assign", "Assign a task to a person",
        "Creates a to-do in someone's in-app inbox, optionally with a due date.", "Communication",
        "Inbox (built-in)",
        (F("assignee", "Assignee"), F("title", "Task"), F("description", "Details", required=False),
         F("due_in_days", "Due in (days)", "number", required=False)),
        (F("task_id", "Task"), F("assignees", "Assignees", "number")),
        tool("task_create", {"assignee": "assignee", "title": "title", "description": "description",
                             "due_in_days": "due_in_days"}),
        {"task_id": "(simulated)", "assignees": 1}, side_effect="internal", keywords=("task", "assign", "todo")),
    Capability(
        "email.send", "Send an email",
        "Sends an email through the company's email server.", "Communication", "Email (SMTP)",
        (F("to", "To"), F("subject", "Subject"), F("body", "Message")),
        (F("sent", "Sent", "boolean"), F("message_id", "Message id")),
        tool("email_send", {"to": "to", "subject": "subject", "body": "body"}),
        {"sent": True, "message_id": "(simulated)"}, side_effect="communication", sensitivity="medium",
        connector="smtp", keywords=("email", "mail", "send")),
    Capability(
        "chat.post_message", "Post a message to a team channel",
        "Posts a message to a Slack or Microsoft Teams channel.", "Communication", "Slack / Microsoft Teams",
        (F("text", "Message"),), (F("posted", "Posted", "boolean"),),
        tool("chat_post", {"text": "text"}), {"posted": True}, side_effect="communication", connector="chat",
        keywords=("slack", "teams", "channel", "chat")),
    # -- business systems -------------------------------------------------------------------
    Capability(
        "system.fetch_record", "Look up a record in a business system",
        "Reads data from a connected business system (HR, ticketing, ERP...). Read-only.", "Business systems",
        "Business system (HTTP API)", (F("path", "Record path"),),
        (F("status", "Response status", "number"), F("data", "Record", "object"), F("ok", "Found", "boolean")),
        tool("http_request", {"path": "path"}, {"method": "GET"}),
        {"status": 200, "data": {"(field)": "(sample)"}, "ok": True}, sensitivity="medium", connector="http",
        keywords=("lookup", "fetch", "hris", "erp", "record")),
    Capability(
        "system.update_record", "Create or update a record in a business system",
        "Writes data to a connected business system (for example create an account or a ticket).",
        "Business systems", "Business system (HTTP API)",
        (F("path", "Record path"), F("data", "Data to send", "object"),
         F("method", "Operation (POST/PUT/PATCH)", required=False)),
        (F("status", "Response status", "number"), F("ok", "Succeeded", "boolean"), F("data", "Response", "object")),
        tool("http_request", {"path": "path", "body": "data", "method": "method"}, {"method": "POST"}),
        {"status": 201, "ok": True, "data": {}}, side_effect="external_write", sensitivity="high", connector="http",
        keywords=("create", "update", "provision", "ticket", "account")),
    Capability(
        "finance.submit_payment", "Submit a payment request",
        "Sends a payment request to the finance system. Requires an approval with separation of duties.",
        "Finance", "Business system (HTTP API)",
        (F("path", "Payment endpoint path"), F("data", "Payment details", "object")),
        (F("status", "Response status", "number"), F("ok", "Submitted", "boolean"), F("data", "Response", "object")),
        tool("http_request", {"path": "path", "body": "data"}, {"method": "POST"}),
        {"status": 201, "ok": True, "data": {}}, side_effect="financial", sensitivity="high", connector="http",
        departments=("finance",), keywords=("pay", "payment", "invoice", "transfer")),
    # -- reporting -----------------------------------------------------------------------------
    Capability(
        "report.create", "Create a report",
        "Saves a Markdown report as a downloadable file of the run.", "Reporting", "Reports (built-in)",
        (F("title", "Title"), F("content", "Content", required=False)),
        (F("artifact_id", "Report file"), F("title", "Title")),
        tool("create_report", {"title": "title", "content": "content"}),
        {"artifact_id": "(simulated)", "title": "(sample)"}, side_effect="internal", keywords=("report", "document")),
    # -- engineering ---------------------------------------------------------------------------
    Capability(
        "code.fetch_repository", "Get a code repository",
        "Downloads a public Git repository into the workflow's private workspace.", "Software development",
        "Git (public HTTPS)", (F("repo_url", "Repository URL"), F("ref", "Branch or tag", required=False),
                               F("path", "Folder", required=False)),
        (F("commit", "Commit"), F("files", "Files", "number"), F("path", "Folder")),
        tool("git_clone", {"repo_url": "repo_url", "ref": "ref", "path": "path"}),
        {"commit": "(simulated)", "files": 1, "path": "repo"}, departments=("engineering", "it"),
        keywords=("git", "repository", "clone", "code")),
    Capability(
        "code.run_tests", "Run automated tests",
        "Runs the project's automated tests in an isolated sandbox.", "Software development", "Test runner (sandbox)",
        (F("path", "Test folder", required=False),),
        (F("tests_passed", "Tests passed", "boolean"), F("failed", "Failed tests", "number"),
         F("coverage_percent", "Coverage %", "number"), F("summary", "Summary")),
        tool("run_tests", {"path": "path"}),
        {"tests_passed": True, "failed": 0, "coverage_percent": 90.0, "summary": "(sample)"},
        departments=("engineering", "it"), keywords=("test", "pytest", "quality")),
    Capability(
        "code.analyze_requirement", "Analyze a software requirement",
        "Uses AI to break a requirement into concrete implementation tasks.", "Software development",
        "AI development agent", (F("requirement", "Requirement"),),
        (F("summary", "Summary"), F("tasks", "Tasks", "list")),
        agent("planning", "Break the requirement into small, concrete implementation tasks.",
              ["list_files", "read_file", "search_files"]),
        {"summary": "(sample)", "tasks": ["(task)"]}, departments=("engineering", "it"), connector="llm",
        keywords=("requirement", "plan", "analysis")),
    Capability(
        "code.implement_change", "Write or change code",
        "Uses AI to modify files in the isolated workspace to implement a requirement.", "Software development",
        "AI development agent", (F("requirement", "Requirement"), F("plan", "Plan", "list", required=False)),
        (F("summary", "Summary"), F("files_changed", "Files changed", "list")),
        agent("developer", "Implement the requirement with minimal, tested changes.",
              ["list_files", "read_file", "search_files", "write_file", "run_tests"]),
        {"summary": "(sample)", "files_changed": []}, departments=("engineering",), connector="llm",
        keywords=("implement", "code", "develop", "fix")),
    Capability(
        "code.review_change", "Review code changes",
        "Uses AI to review the workspace changes and score them from 0 to 10.", "Software development",
        "AI development agent", (F("requirement", "Requirement", required=False),),
        (F("score", "Score", "number"), F("approved", "Approved by reviewer", "boolean"), F("comments", "Comments", "list")),
        agent("code_review", "Review the diff strictly; score 0-10.", ["git_diff", "read_file"]),
        {"score": 8, "approved": True, "comments": []}, departments=("engineering",), connector="llm",
        keywords=("review", "quality")),
    Capability(
        "code.create_patch", "Package code changes",
        "Saves all workspace changes as a downloadable patch file. Nothing is pushed anywhere.",
        "Software development", "Git (local workspace)", (F("name", "File name", required=False),),
        (F("artifact_id", "Patch file"), F("files_changed", "Files changed", "list"), F("has_changes", "Has changes", "boolean")),
        tool("generate_patch", {"name": "name"}),
        {"artifact_id": "(simulated)", "files_changed": [], "has_changes": True}, side_effect="internal",
        departments=("engineering",), keywords=("patch", "diff", "deliver")),
]}


def get_capability(capability_id: str) -> Capability | None:
    return CAPABILITIES.get(capability_id)


def tool_side_effects() -> dict[str, str]:
    """Most severe side effect per tool name (used at runtime, e.g. by simulation)."""
    order = ["none", "internal", "communication", "external_write", "financial"]
    effects: dict[str, str] = {}
    for cap in CAPABILITIES.values():
        if cap.implementation["kind"] == "tool":
            name = cap.implementation["tool"]
            current = effects.get(name, "none")
            effects[name] = max(current, cap.side_effect, key=order.index)
    return effects
