import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleCard } from "@/components/business/ScheduleCard";
import { useAuthStore } from "@/stores/auth";
import type { Workflow } from "@/types";
import { planWorkflow } from "./fixtures";
import { adminUser, json, mockFetch, renderRoutes } from "./helpers";

describe("Schedule card", () => {
  beforeEach(() => useAuthStore.setState({ token: "t", user: adminUser }));
  afterEach(() => vi.unstubAllGlobals());

  it("switches a manual workflow to every 15 minutes", async () => {
    const wf = { ...planWorkflow, status: "enabled" } as Workflow;
    const updated = { ...wf, plan: { ...wf.plan!, trigger: { type: "schedule", cron: "*/15 * * * *", timezone: "UTC", skip_if_running: true } } } as Workflow;
    const calls = mockFetch(({ method, path }) => (method === "PUT" && path === `/api/workflows/${wf.id}/schedule` ? json(updated) : undefined));
    renderRoutes([{ path: "/", element: <ScheduleCard workflow={wf} canEdit /> }], "/");
    expect(screen.getByTestId("schedule-summary")).toHaveTextContent("Runs only when someone starts it");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /change schedule/i }));
    await user.click(screen.getByLabelText(/automatically on a schedule/i));
    expect(screen.getByLabelText("How often")).toHaveValue("*/15 * * * *");
    await user.click(screen.getByRole("button", { name: /save schedule/i }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ enabled: true, cron: "*/15 * * * *", timezone: "UTC", skip_if_running: true });
  });

  it("supports a custom cron expression", async () => {
    const wf = {
      ...planWorkflow,
      plan: { ...planWorkflow.plan!, trigger: { type: "schedule", cron: "*/30 8-18 * * 1-5", timezone: "Europe/Istanbul" } },
    } as Workflow;
    renderRoutes([{ path: "/", element: <ScheduleCard workflow={wf} canEdit={false} /> }], "/");
    expect(screen.getByTestId("schedule-summary")).toHaveTextContent("Custom schedule (*/30 8-18 * * 1-5) · Europe/Istanbul");
    expect(screen.queryByRole("button", { name: /change schedule/i })).toBeNull();
  });
});
