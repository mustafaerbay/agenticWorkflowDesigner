import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EnvVariablesPage from "@/pages/EnvVariablesPage";
import ModelSettingsPage from "@/pages/ModelSettingsPage";
import { useAuthStore } from "@/stores/auth";
import type { EnvVariable } from "@/types";
import { adminUser, json, mockFetch, renderRoutes } from "./helpers";

const variable: EnvVariable = {
  id: "v1",
  name: "OPENAI_API_KEY",
  description: "Designer model",
  has_value: true,
  created_at: "2026-10-19T08:00:00Z",
  updated_at: "2026-10-19T08:00:00Z",
  updated_by: "admin@example.com",
  used_by: ["OpenAI"],
};

describe("Environment variables", () => {
  beforeEach(() => useAuthStore.setState({ token: "t", user: adminUser }));
  afterEach(() => vi.unstubAllGlobals());

  it("lists names without values and reveals a value on request", async () => {
    const calls = mockFetch(({ method, path }) => {
      if (method === "GET" && path === "/api/env-variables") return json([variable]);
      if (method === "POST" && path === "/api/env-variables/v1/reveal") return json({ name: "OPENAI_API_KEY", value: "sk-secret-1" });
      return undefined;
    });
    renderRoutes([{ path: "/", element: <EnvVariablesPage /> }], "/");
    expect(await screen.findByText("OPENAI_API_KEY")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.queryByText("sk-secret-1")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Reveal OPENAI_API_KEY" }));
    expect(await screen.findByTestId("revealed-value")).toHaveTextContent("sk-secret-1");
    expect(calls.filter((c) => c.path === "/api/env-variables/v1/reveal")).toHaveLength(1);
  });

  it("creates a variable from Model Settings and selects it without submitting the provider form", async () => {
    let vars: EnvVariable[] = [];
    const calls = mockFetch(({ method, path, body }) => {
      if (method === "GET" && path === "/api/model-providers") return json([]);
      if (method === "GET" && path === "/api/env-variables") return json(vars);
      if (method === "POST" && path === "/api/env-variables") {
        const b = body as { name: string };
        vars = [{ ...variable, id: "v2", name: b.name, used_by: [] }];
        return json(vars[0], 201);
      }
      if (method === "POST" && path === "/api/model-providers") return json({ id: "p1", ...(body as object), api_key_configured: true }, 201);
      return undefined;
    });
    renderRoutes([{ path: "/", element: <ModelSettingsPage /> }], "/");
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: /add provider/i }))[0]!);
    const providerDialog = await screen.findByRole("dialog");
    await user.type(within(providerDialog).getByLabelText("Name"), "Acme AI");
    await user.type(within(providerDialog).getByLabelText("Base URL"), "https://llm.example.com/v1");
    await user.type(within(providerDialog).getByLabelText("Default model"), "acme-1");
    await user.click(within(providerDialog).getByRole("button", { name: /new variable/i }));
    const varDialog = (await screen.findAllByRole("dialog")).at(-1)!;
    expect(within(varDialog).getByLabelText("Name")).toHaveValue("ACME_AI_API_KEY");
    await user.type(within(varDialog).getByLabelText("Value"), "sk-new");
    await user.click(within(varDialog).getByRole("button", { name: /create variable/i }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "API key" })).toHaveValue("ACME_AI_API_KEY"));
    expect(calls.find((c) => c.path === "/api/env-variables" && c.method === "POST")!.body).toEqual({
      name: "ACME_AI_API_KEY",
      value: "sk-new",
      description: "",
    });
    expect(calls.some((c) => c.path === "/api/model-providers" && c.method === "POST")).toBe(false);
  });
});
