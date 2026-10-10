import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectionsPage from "@/pages/ConnectionsPage";
import { useAuthStore } from "@/stores/auth";
import type { Connection, ConnectorType } from "@/types";
import { adminUser, departments, json, mockFetch, renderRoutes, type Call } from "./helpers";

const connectors: ConnectorType[] = [
  {
    type: "smtp",
    label: "Email (SMTP)",
    description: "Send email through your mail server.",
    capability_connector: "smtp",
    fields: [
      { key: "host", label: "SMTP server", type: "string", required: true, placeholder: "smtp.example.com" },
      { key: "port", label: "Port", type: "number", required: true, default: 587 },
      { key: "security", label: "Security", type: "select", required: false, options: ["starttls", "ssl", "none"], default: "starttls" },
      { key: "from_address", label: "Send as (from address)", type: "string", required: true },
      { key: "allowed_recipient_domains", label: "Allowed recipient domains", type: "list", required: false },
    ],
    secret: { key: "password", label: "Password / app password", required: false },
  },
];

const existing: Connection = {
  id: "c-1",
  name: "HR mailbox",
  connector: "smtp",
  config: { host: "smtp.corp.example", port: 587, security: "starttls", from_address: "hr@corp.example", allowed_recipient_domains: ["corp.example"] },
  departments: ["hr"],
  enabled: true,
  has_secret: true,
  last_test_ok: true,
  last_test_at: "2026-10-09T10:00:00Z",
  created_at: "2026-10-01T00:00:00Z",
};

describe("Connections page", () => {
  let calls: Call[];
  beforeEach(() => {
    useAuthStore.setState({ token: "t", user: adminUser });
    calls = mockFetch(({ method, path, body }) => {
      if (method === "GET" && path === "/api/connectors") return json(connectors);
      if (method === "GET" && path === "/api/connections") return json([existing]);
      if (method === "GET" && path === "/api/departments") return json(departments);
      if (method === "PUT" && path === "/api/connections/c-1") return json({ ...existing, ...(body as object), has_secret: true });
      if (method === "POST" && path === "/api/connections")
        return json({ ...existing, id: "c-2", name: (body as { name: string }).name, has_secret: true }, 201);
      if (method === "POST" && path === "/api/connections/c-2/test") return json({ ok: true, detail: "Connected to smtp" });
      return undefined;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("never pre-fills the secret when editing and omits it from the update when left empty", async () => {
    const user = userEvent.setup();
    renderRoutes([{ path: "/", element: <ConnectionsPage /> }], "/");
    await user.click(await screen.findByRole("button", { name: "Edit HR mailbox" }));
    const dialog = await screen.findByRole("dialog");
    const secret = within(dialog).getByTestId("connection-secret");
    expect(secret).toHaveAttribute("type", "password");
    expect(secret).toHaveValue("");
    expect(secret).toHaveAttribute("placeholder", "Secret stored — leave empty to keep");
    expect(within(dialog).getByText(/Leave this empty to keep it/)).toBeInTheDocument();
    // non-secret config is shown; list fields as chips
    expect(within(dialog).getByLabelText(/SMTP server/)).toHaveValue("smtp.corp.example");
    expect(within(dialog).getByText("corp.example")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: /Save connection/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const body = calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("secret");
    expect(body).toEqual({
      name: "HR mailbox",
      connector: "smtp",
      config: { host: "smtp.corp.example", port: 587, security: "starttls", from_address: "hr@corp.example", allowed_recipient_domains: ["corp.example"] },
      departments: ["hr"],
    });
  });

  it("guides creation, sends the secret once and never displays it afterwards", async () => {
    const user = userEvent.setup();
    renderRoutes([{ path: "/", element: <ConnectionsPage /> }], "/");
    await user.click(await screen.findByRole("button", { name: /Add connection/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Email \(SMTP\)/ }));

    expect(within(dialog).getByText(/never shown again/)).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Connection name"));
    await user.type(within(dialog).getByLabelText("Connection name"), "Finance mail");
    await user.type(within(dialog).getByLabelText(/SMTP server/), "smtp.example.com");
    await user.type(within(dialog).getByLabelText(/Send as/), "finance@example.com");
    await user.type(within(dialog).getByLabelText(/Allowed recipient domains/), "example.com, partner.com,");
    await user.type(within(dialog).getByTestId("connection-secret"), "s3cr3t-value");
    await user.click(within(dialog).getByRole("checkbox", { name: "Finance" }));
    await user.click(within(dialog).getByRole("button", { name: /Save connection/ }));

    expect(await within(dialog).findByText(/Finance mail is saved/)).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/connections")!;
    expect(post.body).toEqual({
      name: "Finance mail",
      connector: "smtp",
      config: { host: "smtp.example.com", port: 587, security: "starttls", from_address: "finance@example.com", allowed_recipient_domains: ["example.com", "partner.com"] },
      secret: "s3cr3t-value",
      departments: ["finance"],
    });
    expect(screen.queryByDisplayValue("s3cr3t-value")).toBeNull();
    expect(screen.queryByText(/s3cr3t-value/)).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: /Test connection/ }));
    expect(await within(dialog).findByText(/Connection works/)).toBeInTheDocument();
  });
});
