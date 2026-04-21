import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => import("./mocks/vscode.js"));

import { __internal } from "../../src/extension.js";

describe("extension actor context helpers", () => {
  it("builds actor context with vscode source, session, and workspace", () => {
    const actor = __internal.buildActorContext("grants.manage");

    expect(actor).toEqual({
      source: "vscode",
      agentId: "vscode:grants.manage",
      sessionId: "mock-session-id",
      workspaceRef: "/mock/workspace",
    });
  });

  it("scopes a client with actor context", () => {
    const client = {
      withActor: (actorContext: unknown) => ({ actorContext }),
    };

    const scoped = __internal.withActorContext(client as any, "override.manage");
    expect(scoped).toEqual({
      actorContext: {
        source: "vscode",
        agentId: "vscode:override.manage",
        sessionId: "mock-session-id",
        workspaceRef: "/mock/workspace",
      },
    });
  });
});

describe("availability override compatibility", () => {
  it("uses native sdk methods when available", async () => {
    const client = {
      createAvailabilityOverride: async (input: unknown) => ({ id: "ovr-1", input }),
      getActiveAvailabilityOverride: async () => ({ id: "ovr-1", mode: "busy" }),
      cancelAvailabilityOverride: async (id: string, reason?: string) => ({ id, reason }),
    };

    const created = await __internal.createAvailabilityOverrideCompat(client as any, {
      mode: "busy",
      durationMinutes: 30,
      source: "vscode",
    });
    expect(created).toEqual({
      id: "ovr-1",
      input: { mode: "busy", durationMinutes: 30, source: "vscode" },
    });

    const active = await __internal.getActiveAvailabilityOverrideCompat(client as any);
    expect(active).toEqual({ id: "ovr-1", mode: "busy" });

    const cancelled = await __internal.cancelAvailabilityOverrideCompat(
      client as any,
      "ovr-1",
      "done",
    );
    expect(cancelled).toEqual({ id: "ovr-1", reason: "done" });
  });

  it("falls back to low-level graphql when native methods are missing", async () => {
    const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];

    const client = {
      graphql: {
        async request(query: string, variables?: Record<string, unknown>) {
          calls.push({ query, variables });

          if (query.includes("ActiveAvailabilityOverride")) {
            return { activeAvailabilityOverride: { id: "ovr-1", mode: "limited" } };
          }

          if (query.includes("CreateAvailabilityOverride")) {
            return { createAvailabilityOverride: { id: "ovr-2", mode: "offline" } };
          }

          return {
            cancelAvailabilityOverride: {
              id: "ovr-2",
              mode: "offline",
              cancelledAt: "2026-04-21T05:00:00Z",
            },
          };
        },
      },
    };

    const active = await __internal.getActiveAvailabilityOverrideCompat(client as any);
    expect(active).toEqual({ id: "ovr-1", mode: "limited" });

    const created = await __internal.createAvailabilityOverrideCompat(client as any, {
      mode: "offline",
      durationMinutes: 45,
      source: "vscode",
    });
    expect(created).toEqual({ id: "ovr-2", mode: "offline" });

    const cancelled = await __internal.cancelAvailabilityOverrideCompat(
      client as any,
      "ovr-2",
      "finished",
    );
    expect(cancelled).toEqual({
      id: "ovr-2",
      mode: "offline",
      cancelledAt: "2026-04-21T05:00:00Z",
    });

    expect(calls[1]?.variables).toEqual({
      input: { mode: "offline", durationMinutes: 45, source: "vscode" },
    });
    expect(calls[2]?.variables).toEqual({ id: "ovr-2", reason: "finished", source: "vscode" });
  });
});
