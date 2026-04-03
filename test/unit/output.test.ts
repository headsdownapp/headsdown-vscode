import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must mock vscode before importing modules that use it
vi.mock("vscode", () => import("./mocks/vscode.js"));

import { OutputLogger } from "../../src/output.js";
import { MockOutputChannel } from "./mocks/vscode.js";

describe("OutputLogger", () => {
  let channel: MockOutputChannel;
  let logger: OutputLogger;

  beforeEach(() => {
    channel = new MockOutputChannel("HeadsDown");
    logger = new OutputLogger(channel as unknown as import("vscode").OutputChannel);
  });

  afterEach(() => {
    logger.dispose();
    vi.restoreAllMocks();
  });

  it("formats log lines with HH:MM:SS timestamps", () => {
    // Use a fixed date for deterministic output
    const fixedDate = new Date(2024, 0, 15, 15, 23, 1);
    vi.setSystemTime(fixedDate);

    logger.log("Activated headsdown-vscode v0.1.0");

    expect(channel.appendLine).toHaveBeenCalledWith("[15:23:01] Activated headsdown-vscode v0.1.0");

    vi.useRealTimers();
  });

  it("writes to the output channel via appendLine", () => {
    logger.log("test message");

    expect(channel.appendLine).toHaveBeenCalledTimes(1);
    const call = channel.appendLine.mock.calls[0][0];
    expect(call).toMatch(/^\[\d{2}:\d{2}:\d{2}\] test message$/);
  });

  it("channel name is HeadsDown", () => {
    expect(channel.name).toBe("HeadsDown");
  });
});
