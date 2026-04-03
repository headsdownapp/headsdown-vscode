import * as vscode from "vscode";
import type { Contract, Calendar, HeadsDownClient, Mode } from "@headsdown/sdk";
import type { OutputLogger } from "./output.js";
import type { SettingsManager } from "./settings.js";

/** All information needed to render the status bar. */
interface StatusState {
  contract: Contract | null;
  calendar: Calendar | null;
}

/**
 * Manages the HeadsDown status bar item.
 * Handles both authenticated and unauthenticated states,
 * local timer ticks, and API polling.
 */
export class StatusBarManager {
  private item: vscode.StatusBarItem;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private activityInterval: ReturnType<typeof setInterval> | null = null;
  private documentChangeListener: vscode.Disposable | null = null;

  private state: StatusState = { contract: null, calendar: null };
  private authenticated = false;

  // Unauthenticated activity tracking
  private activityMinutes = 0;
  private lastActivityTimestamp = 0;
  private activityStreakStart = 0;
  private minutesWithActivity = new Set<number>();

  constructor(
    private readonly logger: OutputLogger,
    private readonly settings: SettingsManager,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.item.command = "headsdown.quickAction";
    this.item.show();
  }

  /** Update status bar for authenticated user with contract/calendar data. */
  update(contract: Contract | null, calendar: Calendar | null): void {
    this.authenticated = true;
    this.state = { contract, calendar };
    this.stopActivityTracking();
    this.render();
  }

  /** Render the status bar for an unauthenticated user. */
  showUnauthenticated(codingMinutes?: number): void {
    this.authenticated = false;
    this.state = { contract: null, calendar: null };

    if (codingMinutes && codingMinutes >= 10) {
      this.item.text = `$(shield) HeadsDown \u00b7 coding ${codingMinutes}m`;
      this.item.tooltip = this.buildUnauthenticatedTooltip(codingMinutes);
    } else {
      this.item.text = "$(shield) HeadsDown";
      this.item.tooltip = this.buildUnauthenticatedTooltip(null);
    }

    this.item.color = undefined;
    this.item.backgroundColor = undefined;
  }

  /** Start tracking editor activity for unauthenticated coding timer. */
  startActivityTracking(): void {
    this.stopActivityTracking();

    this.documentChangeListener = vscode.workspace.onDidChangeTextDocument(() => {
      this.lastActivityTimestamp = Date.now();
      const minute = Math.floor(Date.now() / 60000);
      this.minutesWithActivity.add(minute);
    });

    // Check activity every 60 seconds
    this.activityInterval = setInterval(() => {
      this.updateActivityTimer();
    }, 60_000);
  }

  /** Stop tracking editor activity. */
  stopActivityTracking(): void {
    this.documentChangeListener?.dispose();
    this.documentChangeListener = null;

    if (this.activityInterval) {
      clearInterval(this.activityInterval);
      this.activityInterval = null;
    }

    this.activityMinutes = 0;
    this.lastActivityTimestamp = 0;
    this.activityStreakStart = 0;
    this.minutesWithActivity.clear();
  }

  /** Start the 60-second timer tick for countdown updates. */
  startTimer(): void {
    this.stopTimer();
    this.timerInterval = setInterval(() => {
      if (this.authenticated && this.state.contract) {
        this.render();
      }
    }, 60_000);
  }

  /** Stop the timer tick. */
  stopTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  /** Start polling the API for status changes. */
  startPolling(client: HeadsDownClient, intervalMs: number): void {
    this.stopPolling();

    const poll = async () => {
      try {
        const { contract, calendar } = await client.getAvailability();
        const changed = this.hasStatusChanged(contract);
        this.update(contract, calendar);

        if (changed) {
          this.logger.log(this.formatStatusLog(contract, calendar));
        } else {
          this.logger.log("Poll: status unchanged");
        }
      } catch (error) {
        this.logger.log(`Poll failed: ${error instanceof Error ? error.message : String(error)}`);
        this.showApiUnreachable();
      }
    };

    // Poll immediately on start, then repeat on interval
    poll();
    this.pollInterval = setInterval(poll, intervalMs);
  }

  /** Stop API polling. */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /** Show the API-unreachable state. */
  showApiUnreachable(): void {
    this.item.text = "$(cloud-offline) HeadsDown";
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    this.item.tooltip = new vscode.MarkdownString(
      "**HeadsDown**\n\nUnable to reach the HeadsDown API.\n\n_Click to retry._",
    );
  }

  /** Dispose all resources. */
  dispose(): void {
    this.stopTimer();
    this.stopPolling();
    this.stopActivityTracking();
    this.item.dispose();
  }

  // === Private rendering ===

  private render(): void {
    const { contract } = this.state;

    if (!contract) {
      // Authenticated but no active contract
      this.item.text = "$(circle-filled) HeadsDown";
      this.item.color = undefined;
      this.item.backgroundColor = undefined;
      this.item.tooltip = this.buildAuthenticatedTooltip(null);
      return;
    }

    const mode = contract.mode ?? "online";
    const statusText = contract.statusText;
    const statusEmoji = contract.statusEmoji;
    const locked = contract.lock === true;
    const showTime = this.settings.get("showTimeRemaining");
    const remaining = this.calculateRemainingMinutes(contract.expiresAt);

    // Build display text
    let text = "";
    const modeLabel = this.getModeLabel(mode);

    if (locked) {
      text = `$(circle-filled)$(lock) ${modeLabel}`;
    } else {
      text = `$(circle-filled) ${modeLabel}`;
    }

    // Add status text for online mode
    if (mode === "online" && statusText) {
      const emoji = statusEmoji ? `${statusEmoji} ` : "";
      text += ` \u00b7 ${emoji}${statusText}`;
    }

    // Add timer for timed modes
    if (
      (mode === "busy" || mode === "limited") &&
      remaining !== null &&
      remaining > 0 &&
      showTime
    ) {
      text += ` \u00b7 ${remaining}m`;
    }

    // Set icon for offline
    if (mode === "offline") {
      text = `$(circle-outline) Offline`;
    }

    this.item.text = text;
    this.item.color = this.getThemeColor(mode);
    this.item.backgroundColor = undefined;
    this.item.tooltip = this.buildAuthenticatedTooltip(contract);
  }

  private getModeLabel(mode: Mode): string {
    switch (mode) {
      case "online":
        return "Online";
      case "busy":
        return "Heads Down";
      case "limited":
        return "Limited";
      case "offline":
        return "Offline";
      default:
        return "HeadsDown";
    }
  }

  private getThemeColor(mode: Mode): vscode.ThemeColor | undefined {
    switch (mode) {
      case "online":
        return new vscode.ThemeColor("headsdown.onlineColor");
      case "busy":
        return new vscode.ThemeColor("headsdown.busyColor");
      case "limited":
        return new vscode.ThemeColor("headsdown.limitedColor");
      case "offline":
        return new vscode.ThemeColor("headsdown.offlineColor");
      default:
        return undefined;
    }
  }

  private calculateRemainingMinutes(expiresAt: string | null): number | null {
    if (!expiresAt) return null;
    const expiresMs = new Date(expiresAt).getTime();
    const nowMs = Date.now();
    const remaining = Math.ceil((expiresMs - nowMs) / 60_000);
    return remaining > 0 ? remaining : null;
  }

  private buildAuthenticatedTooltip(contract: Contract | null): vscode.MarkdownString {
    if (!contract) {
      const md = new vscode.MarkdownString(
        "**HeadsDown**\n\nNo active status.\n\n_Click to open Quick Actions_",
      );
      md.isTrusted = true;
      return md;
    }

    const mode = contract.mode ?? "online";
    const modeLabel = this.getModeLabel(mode);
    const locked = contract.lock === true;
    const lockIcon = locked ? " $(lock)" : "";

    const lines: string[] = [`**HeadsDown: ${modeLabel}**${lockIcon}`, ""];

    // Status text
    if (contract.statusText) {
      const emoji = contract.statusEmoji ? `${contract.statusEmoji} ` : "\uD83C\uDFAF ";
      lines.push(`${emoji}${contract.statusText}`);
    }

    // Timer
    const remaining = this.calculateRemainingMinutes(contract.expiresAt);
    if (remaining !== null && remaining > 0) {
      const expiresDate = new Date(contract.expiresAt);
      const expiresTime = expiresDate.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
      lines.push(`\u23F1 ${remaining} minutes remaining (expires ${expiresTime})`);
    }

    // Trust level
    const trustLevel = this.settings.get("trustLevel");
    lines.push(`\uD83D\uDCCB Trust level: ${trustLevel}`);

    lines.push("", "_Click to open Quick Actions_");

    const md = new vscode.MarkdownString(lines.join("\n"));
    md.isTrusted = true;
    return md;
  }

  private buildUnauthenticatedTooltip(codingMinutes: number | null): vscode.MarkdownString {
    const lines: string[] = ["**HeadsDown**", ""];

    if (codingMinutes && codingMinutes >= 10) {
      lines.push(`You've been coding for ${codingMinutes} minutes.`);
      lines.push("Sign in to protect your focus time and sync across tools.");
    } else {
      lines.push("Not connected. Click to sign in.");
    }

    lines.push("", "_Click to sign in._");

    const md = new vscode.MarkdownString(lines.join("\n"));
    md.isTrusted = true;
    return md;
  }

  private hasStatusChanged(newContract: Contract | null): boolean {
    const old = this.state.contract;
    if (!old && !newContract) return false;
    if (!old || !newContract) return true;

    return (
      old.mode !== newContract.mode ||
      old.statusText !== newContract.statusText ||
      old.lock !== newContract.lock ||
      old.expiresAt !== newContract.expiresAt
    );
  }

  private formatStatusLog(contract: Contract | null, _calendar: Calendar | null): string {
    if (!contract) {
      return "Status: no active contract";
    }

    const parts: string[] = [`Status: ${this.getModeLabel(contract.mode)}`];

    if (contract.statusText) {
      const emoji = contract.statusEmoji ? `${contract.statusEmoji} ` : "";
      parts.push(`${emoji}${contract.statusText}`);
    }

    const remaining = this.calculateRemainingMinutes(contract.expiresAt);
    if (remaining !== null) {
      parts.push(`${remaining}m remaining`);
    }

    if (contract.lock) {
      parts.push("locked");
    }

    return parts.join(" \u00b7 ");
  }

  private updateActivityTimer(): void {
    if (this.authenticated) return;

    const now = Date.now();
    const currentMinute = Math.floor(now / 60000);

    // Count consecutive minutes with activity, allowing a 2-minute gap.
    // Walk backwards from the current minute. If we hit a minute without
    // activity, start counting gap minutes. If the gap exceeds maxGap,
    // the streak is over. Gap minutes within the streak count as coding time.
    let consecutiveMinutes = 0;
    let gapCount = 0;
    let brokeDueToGap = false;
    const maxGap = 2;

    for (let m = currentMinute; m >= currentMinute - 480; m--) {
      if (this.minutesWithActivity.has(m)) {
        consecutiveMinutes++;
        gapCount = 0;
      } else {
        gapCount++;
        if (gapCount > maxGap) {
          brokeDueToGap = true;
          break;
        }
        // Count gap minutes as part of the streak (user was still "coding")
        consecutiveMinutes++;
      }
    }

    // Subtract trailing gap minutes that weren't followed by more activity.
    // If we broke due to exceeding maxGap, the last gapCount-1 minutes were
    // counted (the one that exceeded wasn't), so subtract those.
    // If we didn't break, subtract any trailing gap at the end of the Set.
    const trailingGaps = brokeDueToGap ? gapCount - 1 : gapCount;
    this.activityMinutes = Math.max(0, consecutiveMinutes - trailingGaps);

    // Clean old entries (keep only last 8 hours)
    const cutoff = currentMinute - 480;
    for (const m of this.minutesWithActivity) {
      if (m < cutoff) this.minutesWithActivity.delete(m);
    }

    this.showUnauthenticated(this.activityMinutes);
  }
}
