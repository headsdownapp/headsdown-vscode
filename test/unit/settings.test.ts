import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must mock vscode before importing modules that use it
vi.mock("vscode", () => import("./mocks/vscode.js"));

import { SettingsManager } from "../../src/settings.js";
import { MockWorkspaceConfiguration, workspace } from "./mocks/vscode.js";

// Mock fs for shared config
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { readFile } from "node:fs/promises";

const mockReadFile = vi.mocked(readFile);

describe("SettingsManager", () => {
  let settings: SettingsManager;
  let mockConfig: MockWorkspaceConfiguration;

  beforeEach(() => {
    settings = new SettingsManager();
    mockConfig = new MockWorkspaceConfiguration({
      trustLevel: "advisory",
      sensitivePaths: [],
      "notifications.enabled": true,
      "notifications.expiryWarningMinutes": 5,
      "statusBar.showTimeRemaining": true,
      "polling.intervalSeconds": 300,
      "autoDetect.enabled": true,
      "autoDetect.thresholdMinutes": 20,
      "api.baseUrl": "https://headsdown.app",
    });
    workspace._setConfig("headsdown", mockConfig);

    // Default: no shared config
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
  });

  afterEach(() => {
    workspace._clearConfigs();
    vi.restoreAllMocks();
  });

  it("returns VS Code setting when explicitly set globally", async () => {
    mockConfig._setGlobal("trustLevel", "guarded");

    const result = await settings.getSettings();
    expect(result.trustLevel).toBe("guarded");
  });

  it("returns VS Code workspace setting over global", async () => {
    mockConfig._setGlobal("trustLevel", "guarded");
    mockConfig._setWorkspace("trustLevel", "active");

    const result = await settings.getSettings();
    expect(result.trustLevel).toBe("active");
  });

  it("falls back to shared config when VS Code is at default", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ trustLevel: "active" }) as never);

    settings.invalidateCache();
    const result = await settings.getSettings();
    expect(result.trustLevel).toBe("active");
  });

  it("returns SDK default when both are at default", async () => {
    const result = await settings.getSettings();
    expect(result.trustLevel).toBe("advisory");
  });

  it("validates trust level enum", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ trustLevel: "invalid_value" }) as never);

    settings.invalidateCache();
    const result = await settings.getSettings();
    expect(result.trustLevel).toBe("advisory");
  });

  it("merges sensitive paths from VS Code and shared config", async () => {
    mockConfig._setGlobal("sensitivePaths", ["*.secret"]);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ sensitivePaths: ["*.private", "*.secret"] }) as never,
    );

    settings.invalidateCache();
    const result = await settings.getSettings();
    // Deduplicated merge
    expect(result.sensitivePaths).toContain("*.secret");
    expect(result.sensitivePaths).toContain("*.private");
    expect(new Set(result.sensitivePaths).size).toBe(result.sensitivePaths.length);
  });

  it("baseUrl override works", async () => {
    mockConfig._setGlobal("api.baseUrl", "https://dev.headsdown.app");

    const result = await settings.getSettings();
    expect(result.apiBaseUrl).toBe("https://dev.headsdown.app");
  });

  it("loads auto-detect settings correctly", async () => {
    mockConfig._setGlobal("autoDetect.enabled", false);
    mockConfig._setGlobal("autoDetect.thresholdMinutes", 30);

    const result = await settings.getSettings();
    expect(result.autoDetectEnabled).toBe(false);
    expect(result.autoDetectThresholdMinutes).toBe(30);
  });
});
