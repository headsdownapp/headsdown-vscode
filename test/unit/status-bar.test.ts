import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must mock vscode before importing modules that use it
vi.mock("vscode", () => import("./mocks/vscode.js"));

import { StatusBarManager } from "../../src/status-bar.js";
import { OutputLogger } from "../../src/output.js";
import { SettingsManager } from "../../src/settings.js";
import type { Contract, Calendar } from "@headsdown/sdk";
import { MockStatusBarItem, ThemeColor, MarkdownString, workspace } from "./mocks/vscode.js";

// === Helpers ===

function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: "c-1",
    mode: "online",
    status: true,
    statusEmoji: null,
    statusText: null,
    afk: false,
    autoRespond: false,
    lock: null,
    duration: null,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), // 60 min from now
    insertedAt: new Date().toISOString(),
    recordMessages: false,
    snooze: false,
    ...overrides,
  };
}

function makeCalendar(overrides: Partial<Calendar> = {}): Calendar {
  return {
    automateEndOfDay: false,
    automateStartOfDay: false,
    day: "monday",
    endsAt: "17:00:00",
    nextWorkday: "tuesday",
    nextWorkdayStartsAt: "09:00:00",
    now: new Date().toISOString(),
    offHours: false,
    startsAt: "09:00:00",
    workHours: true,
    working: true,
    ...overrides,
  };
}

function getStatusBarItem(manager: StatusBarManager): MockStatusBarItem {
  // Access the private item for assertions
  return (manager as unknown as { item: MockStatusBarItem }).item;
}

describe("StatusBarManager", () => {
  let logger: OutputLogger;
  let settings: SettingsManager;
  let manager: StatusBarManager;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = new OutputLogger();
    settings = new SettingsManager();

    // Mock settings to return expected defaults
    vi.spyOn(settings, "get").mockImplementation((key: string) => {
      const defaults: Record<string, unknown> = {
        showTimeRemaining: true,
        trustLevel: "advisory",
        pollingIntervalSeconds: 300,
      };
      return defaults[key] as never;
    });

    manager = new StatusBarManager(logger, settings);
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // === Authenticated states ===

  describe("authenticated states", () => {
    it("shows Online for online mode with no status text", () => {
      const contract = makeContract({ mode: "online" });
      manager.update(contract, makeCalendar());

      const item = getStatusBarItem(manager);
      expect(item.text).toBe("$(circle-filled) Online");
      expect(item.color).toBeInstanceOf(ThemeColor);
      expect((item.color as ThemeColor).id).toBe("headsdown.onlineColor");
    });

    it("shows Online with status text and emoji", () => {
      const contract = makeContract({
        mode: "online",
        statusText: "Taking a break",
        statusEmoji: "☕",
      });
      manager.update(contract, makeCalendar());

      const item = getStatusBarItem(manager);
      expect(item.text).toBe("$(circle-filled) Online · ☕ Taking a break");
    });

    it("shows Heads Down with timer for busy mode", () => {
      const contract = makeContract({
        mode: "busy",
        expiresAt: new Date(Date.now() + 47 * 60_000).toISOString(),
      });
      manager.update(contract, makeCalendar());

      const item = getStatusBarItem(manager);
      expect(item.text).toBe("$(circle-filled) Heads Down · 47m");
      expect((item.color as ThemeColor).id).toBe("headsdown.busyColor");
    });

    it("shows lock icon when busy and locked", () => {
      const contract = makeContract({
        mode: "busy",
        lock: true,
        expiresAt: new Date(Date.now() + 47 * 60_000).toISOString(),
      });
      manager.update(contract, makeCalendar());

      const item = getStatusBarItem(manager);
      expect(item.text).toBe("$(circle-filled)$(lock) Heads Down · 47m");
    });

    it("shows Limited with timer", () => {
      const contract = makeContract({
        mode: "limited",
        expiresAt: new Date(Date.now() + 22 * 60_000).toISOString(),
      });
      manager.update(contract, makeCalendar());

      const item = getStatusBarItem(manager);
      expect(item.text).toBe("$(circle-filled) Limited · 22m");
      expect((item.color as ThemeColor).id).toBe("headsdown.limitedColor");
    });

    it("shows Offline with circle-outline", () => {
      const contract = makeContract({ mode: "offline" });
      manager.update(contract, makeCalendar());

      const item = getStatusBarItem(manager);
      expect(item.text).toBe("$(circle-outline) Offline");
      expect((item.color as ThemeColor).id).toBe("headsdown.offlineColor");
    });

    it("shows HeadsDown with no mode label when no contract", () => {
      manager.update(null, makeCalendar());

      const item = getStatusBarItem(manager);
      expect(item.text).toBe("$(circle-filled) HeadsDown");
      expect(item.color).toBeUndefined();
    });

    it("omits timer when showTimeRemaining is false", () => {
      vi.spyOn(settings, "get").mockImplementation((key: string) => {
        if (key === "showTimeRemaining") return false as never;
        return "advisory" as never;
      });

      const contract = makeContract({
        mode: "busy",
        expiresAt: new Date(Date.now() + 47 * 60_000).toISOString(),
      });
      manager.update(contract, makeCalendar());

      const item = getStatusBarItem(manager);
      expect(item.text).toBe("$(circle-filled) Heads Down");
      expect(item.text).not.toContain("47m");
    });

    it("omits timer when expiresAt is in the past", () => {
      const contract = makeContract({
        mode: "busy",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      manager.update(contract, makeCalendar());

      const item = getStatusBarItem(manager);
      expect(item.text).toBe("$(circle-filled) Heads Down");
    });

    it("renders tooltip with mode, time remaining, and trust level", () => {
      const contract = makeContract({
        mode: "busy",
        statusText: "Deep work on auth refactor",
        expiresAt: new Date(Date.now() + 47 * 60_000).toISOString(),
        lock: true,
      });
      manager.update(contract, makeCalendar());

      const item = getStatusBarItem(manager);
      const tooltip = item.tooltip as MarkdownString;
      expect(tooltip.value).toContain("HeadsDown: Heads Down");
      expect(tooltip.value).toContain("$(lock)");
      expect(tooltip.value).toContain("Deep work on auth refactor");
      expect(tooltip.value).toContain("47 minutes remaining");
      expect(tooltip.value).toContain("Trust level: advisory");
    });

    it("sets command to headsdown.quickAction", () => {
      const item = getStatusBarItem(manager);
      expect(item.command).toBe("headsdown.quickAction");
    });
  });

  // === Timer ===

  describe("timer", () => {
    it("recalculates time remaining every 60 seconds without API call", () => {
      const expiresAt = new Date(Date.now() + 47 * 60_000).toISOString();
      const contract = makeContract({ mode: "busy", expiresAt });
      manager.update(contract, makeCalendar());
      manager.startTimer();

      const item = getStatusBarItem(manager);
      expect(item.text).toContain("47m");

      // Advance 1 minute
      vi.advanceTimersByTime(60_000);
      expect(item.text).toContain("46m");
    });

    it("dispose clears all intervals", () => {
      manager.startTimer();
      manager.dispose();

      // No errors on timer tick after dispose
      vi.advanceTimersByTime(120_000);
    });
  });

  // === Unauthenticated states ===

  describe("unauthenticated states", () => {
    it("shows shield icon without timer when no activity", () => {
      manager.showUnauthenticated();

      const item = getStatusBarItem(manager);
      expect(item.text).toBe("$(shield) HeadsDown");
    });

    it("shows shield icon with coding timer when activity >= 10 minutes", () => {
      manager.showUnauthenticated(23);

      const item = getStatusBarItem(manager);
      expect(item.text).toBe("$(shield) HeadsDown · coding 23m");
    });

    it("hides timer when activity < 10 minutes", () => {
      manager.showUnauthenticated(5);

      const item = getStatusBarItem(manager);
      expect(item.text).toBe("$(shield) HeadsDown");
    });

    it("shows sign-in prompt tooltip when no activity", () => {
      manager.showUnauthenticated();

      const item = getStatusBarItem(manager);
      const tooltip = item.tooltip as MarkdownString;
      expect(tooltip.value).toContain("Not connected. Click to sign in.");
    });

    it("shows coding time in tooltip when activity detected", () => {
      manager.showUnauthenticated(23);

      const item = getStatusBarItem(manager);
      const tooltip = item.tooltip as MarkdownString;
      expect(tooltip.value).toContain("You've been coding for 23 minutes.");
      expect(tooltip.value).toContain("Sign in to protect your focus time");
    });
  });

  // === Activity tracking ===

  describe("activity tracking", () => {
    function getMinutesWithActivity(mgr: StatusBarManager): Set<number> {
      return (mgr as unknown as { minutesWithActivity: Set<number> }).minutesWithActivity;
    }

    function triggerActivityUpdate(mgr: StatusBarManager): void {
      // Call the private updateActivityTimer method
      (mgr as unknown as { updateActivityTimer: () => void }).updateActivityTimer();
    }

    it("counts consecutive minutes of activity correctly", () => {
      const now = Date.now();
      const currentMinute = Math.floor(now / 60000);
      const activitySet = getMinutesWithActivity(manager);

      // Simulate 15 consecutive minutes of activity
      for (let i = 0; i < 15; i++) {
        activitySet.add(currentMinute - i);
      }

      triggerActivityUpdate(manager);

      const item = getStatusBarItem(manager);
      expect(item.text).toBe("$(shield) HeadsDown \u00b7 coding 15m");
    });

    it("bridges a 2-minute gap in activity", () => {
      const now = Date.now();
      const currentMinute = Math.floor(now / 60000);
      const activitySet = getMinutesWithActivity(manager);

      // 8 minutes of activity, then a 2-minute gap, then 4 more minutes
      // Total streak: 14 minutes (8 + 2 gap + 4)
      for (let i = 0; i < 8; i++) {
        activitySet.add(currentMinute - i);
      }
      // 2-minute gap at current-8 and current-9
      for (let i = 10; i < 14; i++) {
        activitySet.add(currentMinute - i);
      }

      triggerActivityUpdate(manager);

      // The activity count should bridge the 2-minute gap
      const activityMinutes = (manager as unknown as { activityMinutes: number }).activityMinutes;
      expect(activityMinutes).toBe(14);

      // 14 >= 10, so "coding" should appear in the status bar
      const item = getStatusBarItem(manager);
      expect(item.text).toContain("coding 14m");
    });

    it("breaks streak on gaps longer than 2 minutes", () => {
      const now = Date.now();
      const currentMinute = Math.floor(now / 60000);
      const activitySet = getMinutesWithActivity(manager);

      // Activity at current, current-1, then 3-minute gap, then current-5
      activitySet.add(currentMinute);
      activitySet.add(currentMinute - 1);
      // 3-minute gap at current-2, current-3, current-4
      activitySet.add(currentMinute - 5);

      triggerActivityUpdate(manager);

      const activityMinutes = (manager as unknown as { activityMinutes: number }).activityMinutes;
      // Only counts current and current-1 (streak breaks at 3-minute gap)
      expect(activityMinutes).toBe(2);
    });
  });
});
