import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SHARED_CONFIG_PATH = join(homedir(), ".config", "headsdown", "config.json");

export type TrustLevel = "advisory" | "active" | "guarded";

export interface HeadsDownSettings {
  trustLevel: TrustLevel;
  sensitivePaths: string[];
  notificationsEnabled: boolean;
  expiryWarningMinutes: number;
  showTimeRemaining: boolean;
  pollingIntervalSeconds: number;
  autoDetectEnabled: boolean;
  autoDetectThresholdMinutes: number;
  apiBaseUrl: string;
}

const VALID_TRUST_LEVELS: TrustLevel[] = ["advisory", "active", "guarded"];

const DEFAULTS: HeadsDownSettings = {
  trustLevel: "advisory",
  sensitivePaths: [],
  notificationsEnabled: true,
  expiryWarningMinutes: 5,
  showTimeRemaining: true,
  pollingIntervalSeconds: 300,
  autoDetectEnabled: true,
  autoDetectThresholdMinutes: 20,
  apiBaseUrl: "https://headsdown.app",
};

/**
 * Settings manager that resolves values from:
 * 1. VS Code settings (user/workspace)
 * 2. Shared config at ~/.config/headsdown/config.json
 * 3. SDK defaults
 *
 * VS Code settings win when explicitly set (not at declared default).
 * Shared config is the fallback for values VS Code hasn't overridden.
 */
export class SettingsManager {
  private sharedConfig: Record<string, unknown> | null = null;
  private sharedConfigLoaded = false;

  /** Load all settings with the resolution chain applied. */
  async getSettings(): Promise<HeadsDownSettings> {
    const config = vscode.workspace.getConfiguration("headsdown");
    const shared = await this.loadSharedConfig();

    return {
      trustLevel: this.resolveTrustLevel(config, shared),
      sensitivePaths: this.resolveSensitivePaths(config, shared),
      notificationsEnabled: this.resolve<boolean>(
        config,
        "notifications.enabled",
        shared,
        "notificationsEnabled",
        DEFAULTS.notificationsEnabled,
      ),
      expiryWarningMinutes: this.resolve<number>(
        config,
        "notifications.expiryWarningMinutes",
        shared,
        "expiryWarningMinutes",
        DEFAULTS.expiryWarningMinutes,
      ),
      showTimeRemaining: this.resolve<boolean>(
        config,
        "statusBar.showTimeRemaining",
        shared,
        "showTimeRemaining",
        DEFAULTS.showTimeRemaining,
      ),
      pollingIntervalSeconds: this.resolve<number>(
        config,
        "polling.intervalSeconds",
        shared,
        "pollingIntervalSeconds",
        DEFAULTS.pollingIntervalSeconds,
      ),
      autoDetectEnabled: this.resolve<boolean>(
        config,
        "autoDetect.enabled",
        shared,
        "autoDetectEnabled",
        DEFAULTS.autoDetectEnabled,
      ),
      autoDetectThresholdMinutes: this.resolve<number>(
        config,
        "autoDetect.thresholdMinutes",
        shared,
        "autoDetectThresholdMinutes",
        DEFAULTS.autoDetectThresholdMinutes,
      ),
      apiBaseUrl: this.resolve<string>(
        config,
        "api.baseUrl",
        shared,
        "baseUrl",
        DEFAULTS.apiBaseUrl,
      ),
    };
  }

  /**
   * Get a single setting value synchronously.
   * Uses the same resolution chain as getSettings(): VS Code > shared config > default.
   * The shared config is loaded lazily on first call (sync read via cache).
   * Call loadSharedConfigSync() or getSettings() at startup to prime the cache.
   */
  get<K extends keyof HeadsDownSettings>(key: K): HeadsDownSettings[K] {
    const config = vscode.workspace.getConfiguration("headsdown");
    const shared = this.sharedConfig ?? {};

    const VSCODE_KEY_MAP: Record<keyof HeadsDownSettings, string> = {
      trustLevel: "trustLevel",
      sensitivePaths: "sensitivePaths",
      notificationsEnabled: "notifications.enabled",
      expiryWarningMinutes: "notifications.expiryWarningMinutes",
      showTimeRemaining: "statusBar.showTimeRemaining",
      pollingIntervalSeconds: "polling.intervalSeconds",
      autoDetectEnabled: "autoDetect.enabled",
      autoDetectThresholdMinutes: "autoDetect.thresholdMinutes",
      apiBaseUrl: "api.baseUrl",
    };

    const SHARED_KEY_MAP: Record<keyof HeadsDownSettings, string> = {
      trustLevel: "trustLevel",
      sensitivePaths: "sensitivePaths",
      notificationsEnabled: "notificationsEnabled",
      expiryWarningMinutes: "expiryWarningMinutes",
      showTimeRemaining: "showTimeRemaining",
      pollingIntervalSeconds: "pollingIntervalSeconds",
      autoDetectEnabled: "autoDetectEnabled",
      autoDetectThresholdMinutes: "autoDetectThresholdMinutes",
      apiBaseUrl: "baseUrl",
    };

    if (key === "trustLevel") {
      return this.resolveTrustLevel(config, shared) as HeadsDownSettings[K];
    }

    if (key === "sensitivePaths") {
      return this.resolveSensitivePaths(config, shared) as HeadsDownSettings[K];
    }

    return this.resolve<HeadsDownSettings[K]>(
      config,
      VSCODE_KEY_MAP[key],
      shared,
      SHARED_KEY_MAP[key],
      DEFAULTS[key],
    );
  }

  /**
   * Prime the shared config cache. Call once at startup so that
   * subsequent synchronous get() calls have access to the shared config.
   */
  async primeCache(): Promise<void> {
    await this.loadSharedConfig();
  }

  /** Invalidate cached shared config (call when file might have changed). */
  invalidateCache(): void {
    this.sharedConfig = null;
    this.sharedConfigLoaded = false;
  }

  private async loadSharedConfig(): Promise<Record<string, unknown>> {
    if (this.sharedConfigLoaded) {
      return this.sharedConfig ?? {};
    }

    try {
      const raw = await readFile(SHARED_CONFIG_PATH, "utf-8");
      this.sharedConfig = JSON.parse(raw) as Record<string, unknown>;
    } catch (error: unknown) {
      // ENOENT is expected (no shared config file), anything else is worth noting
      const isNotFound =
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!isNotFound && error instanceof SyntaxError) {
        // Malformed JSON in shared config, user should know
        console.warn(`HeadsDown: failed to parse ${SHARED_CONFIG_PATH}: ${error.message}`);
      }
      this.sharedConfig = null;
    }

    this.sharedConfigLoaded = true;
    return this.sharedConfig ?? {};
  }

  /**
   * Resolve a setting: VS Code config (if explicitly set) > shared config > default.
   * We check if VS Code has the setting at a non-default value using inspect().
   */
  private resolve<T>(
    config: vscode.WorkspaceConfiguration,
    vscodeKey: string,
    shared: Record<string, unknown>,
    sharedKey: string,
    defaultValue: T,
  ): T {
    const inspection = config.inspect<T>(vscodeKey);
    if (inspection) {
      // User or workspace explicitly set the value
      if (inspection.workspaceValue !== undefined) return inspection.workspaceValue;
      if (inspection.globalValue !== undefined) return inspection.globalValue;
    }

    // Fall back to shared config
    const sharedValue = shared[sharedKey];
    if (sharedValue !== undefined && sharedValue !== null) {
      return sharedValue as T;
    }

    return defaultValue;
  }

  private resolveTrustLevel(
    config: vscode.WorkspaceConfiguration,
    shared: Record<string, unknown>,
  ): TrustLevel {
    const raw = this.resolve<string>(
      config,
      "trustLevel",
      shared,
      "trustLevel",
      DEFAULTS.trustLevel,
    );
    return VALID_TRUST_LEVELS.includes(raw as TrustLevel)
      ? (raw as TrustLevel)
      : DEFAULTS.trustLevel;
  }

  private resolveSensitivePaths(
    config: vscode.WorkspaceConfiguration,
    shared: Record<string, unknown>,
  ): string[] {
    const vscodeValue = this.resolve<string[]>(
      config,
      "sensitivePaths",
      shared,
      "sensitivePaths",
      DEFAULTS.sensitivePaths,
    );
    const sharedValue = Array.isArray(shared["sensitivePaths"])
      ? (shared["sensitivePaths"] as string[]).filter((p): p is string => typeof p === "string")
      : [];

    // Merge: VS Code paths + shared config paths (deduplicated)
    const merged = [...new Set([...vscodeValue, ...sharedValue])];
    return merged;
  }
}
