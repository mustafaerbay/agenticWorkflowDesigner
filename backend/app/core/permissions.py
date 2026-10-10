"""Authorization rules (RBAC + department memberships). Enforced by the API and worker,
never delegated to the designer or the LLM."""

from typing import Any

from app.models import Approval, User, Workflow, WorkflowRun

DEPARTMENT_ROLES = ("member", "builder", "approver", "dept_admin")


def roles_in(user: User, department: str | None) -> set[str]:
    if department is None:
        return set()
    roles: set[str] = set()
    for m in user.memberships or []:
        if m.get("department") == department:
            roles.update(m.get("roles") or [])
    if "dept_admin" in roles:
        roles.update(DEPARTMENT_ROLES)
    return roles


def departments_of(user: User) -> set[str]:
    return {m.get("department") for m in user.memberships or [] if m.get("department")}


def is_admin(user: User) -> bool:
    return user.role == "admin"


def can_view_workflow(user: User, wf: Workflow) -> bool:
    if is_admin(user) or wf.owner_id == user.id:
        return True
    if wf.department:
        return bool(roles_in(user, wf.department))
    return wf.is_example


def can_edit_workflow(user: User, wf: Workflow) -> bool:
    if user.role == "viewer":
        return False
    if is_admin(user):
        return True
    if wf.department:
        return wf.owner_id == user.id or bool(roles_in(user, wf.department) & {"builder", "dept_admin"})
    return user.role == "editor" and wf.owner_id == user.id


def can_run_workflow(user: User, wf: Workflow) -> bool:
    if user.role == "viewer":
        return False
    if is_admin(user) or wf.owner_id == user.id:
        return True
    if wf.department:
        return bool(roles_in(user, wf.department))
    return user.role == "editor" and wf.is_example


def can_enable_workflow(user: User, wf: Workflow) -> bool:
    if is_admin(user):
        return True
    return bool(wf.department) and bool(roles_in(user, wf.department) & {"builder", "dept_admin"}) \
        and user.role != "viewer"


def can_build_in(user: User, department: str | None) -> bool:
    if user.role == "viewer":
        return False
    if is_admin(user):
        return True
    if department is None:
        return user.role == "editor"
    return bool(roles_in(user, department) & {"builder", "dept_admin"})


def can_view_run(user: User, run: WorkflowRun, wf: Workflow | None) -> bool:
    if is_admin(user) or run.created_by == user.id:
        return True
    if wf is not None and wf.owner_id == user.id:
        return True
    department = run.department or (wf.department if wf else None)
    return bool(department) and bool(roles_in(user, department))


def approval_decision_problem(user: User, approval: Approval, run: WorkflowRun, wf: Workflow | None) -> str | None:
    """Return why `user` may not decide `approval`, or None if allowed."""
    if user.role == "viewer":
        return "Read-only accounts cannot decide approvals"
    if approval.separation_of_duties and run.created_by == user.id:
        return "Separation of duties: the person who started the run cannot approve it"
    if is_admin(user):
        return None
    department = approval.department or run.department
    if department:
        if approval.required_role in roles_in(user, department) or "dept_admin" in roles_in(user, department):
            return None
        return f"Only a{'n' if approval.required_role[0] in 'aeiou' else ''} {approval.required_role} in " \
               f"{department} can decide this approval"
    # Legacy workflows without a department: owners/initiators with edit rights.
    if user.role == "editor" and (run.created_by == user.id or (wf is not None and wf.owner_id == user.id)):
        return None
    return "You are not allowed to decide this approval"


def public_user(user: User) -> dict[str, Any]:
    return {"id": str(user.id), "email": user.email, "name": user.name, "role": user.role,
            "memberships": user.memberships or [], "is_active": user.is_active}
