import * as vscode from "vscode";
import { ConfigStore, type HeadsDownClient } from "@headsdown/sdk";
import { OutputLogger } from "./output.js";
import { AuthManager } from "./auth.js";
import { StatusBarManager } from "./status-bar.js";
import { SettingsManager } from "./settings.js";
import { AvailabilitySubscription } from "./subscription.js";

const FIRST_RUN_DISMISSED_KEY = "headsdown.firstRunDismissed";

let logger: OutputLogger;
let authManager: AuthManager;
let statusBar: StatusBarManager;
let settingsManager: SettingsManager;
let availabilitySubscription: AvailabilitySubscription | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Initialize core services
  logger = new OutputLogger();
  settingsManager = new SettingsManager();
  statusBar = new StatusBarManager(logger, settingsManager);
  authManager = new AuthManager(context.secrets, logger, () => settingsManager.get("apiBaseUrl"));

  // Register sign-in nudge callback once; tracking may start later depending on auth state.
  statusBar.onActivityThreshold((minutes) => {
    void showActivitySignInNudge(context, minutes);
  });

  // Prime the shared config cache so synchronous get() calls work
  await settingsManager.primeCache();

  const version = context.extension?.packageJSON?.version ?? "0.1.0";
  logger.log(`Activated headsdown-vscode v${version}`);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("headsdown.signIn", async () => {
      const success = await authManager.signIn();
      if (success) {
        await refreshAuthenticatedState();
      }
    }),

    vscode.commands.registerCommand("headsdown.signOut", async () => {
      await authManager.signOut();
      availabilitySubscription?.stop();
      availabilitySubscription = null;
      statusBar.stopPolling();
      statusBar.stopTimer();
      statusBar.showUnauthenticated();
      statusBar.startActivityTracking();
    }),

    vscode.commands.registerCommand("headsdown.quickAction", async () => {
      if (authManager.isAuthenticated()) {
        await showAuthenticatedQuickPick();
      } else {
        await showUnauthenticatedQuickPick();
      }
    }),

    vscode.commands.registerCommand("headsdown.showOutput", () => {
      logger.show();
    }),
  );

  // Register disposables
  context.subscriptions.push(statusBar, logger);

  // Watch for settings changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("headsdown")) {
        settingsManager.invalidateCache();
        void onSettingsChanged();
      }
    }),
  );

  // Try to authenticate with stored credentials
  const authenticated = await authManager.initialize();

  if (authenticated) {
    await refreshAuthenticatedState();
  } else {
    statusBar.showUnauthenticated();
    statusBar.startActivityTracking();
  }
}

export function deactivate(): void {
  availabilitySubscription?.stop();
  availabilitySubscription = null;
  // VS Code disposes subscriptions automatically, but be explicit
  statusBar?.dispose();
  logger?.dispose();
}

// === Authenticated state ===

async function refreshAuthenticatedState(): Promise<void> {
  const client = authManager.getClient();
  if (!client) return;

  try {
    const { contract, schedule } = await client.getAvailability();
    statusBar.update(contract, schedule);
    logger.log(formatContractLog(contract));
    statusBar.startTimer();
    startRealtimeUpdates(client);
  } catch (error) {
    logger.log(
      `Failed to fetch availability: ${error instanceof Error ? error.message : String(error)}`,
    );
    statusBar.showApiUnreachable();

    // Poll so we can auto-recover even if initial subscription connection fails
    statusBar.startTimer();
    const intervalMs = settingsManager.get("pollingIntervalSeconds") * 1000;
    statusBar.startPolling(client, intervalMs);
  }
}

function startRealtimeUpdates(client: HeadsDownClient): void {
  availabilitySubscription?.stop();

  const token = authManager.getApiKey();
  if (!token) {
    logger.log("Subscriptions: missing API token, using polling fallback.");
    const intervalMs = settingsManager.get("pollingIntervalSeconds") * 1000;
    statusBar.startPolling(client, intervalMs);
    return;
  }

  availabilitySubscription = new AvailabilitySubscription(
    logger,
    () => settingsManager.get("apiBaseUrl"),
    () => authManager.getApiKey(),
    {
      onConnected: () => {
        logger.log("Subscriptions: connected (graphql-transport-ws)");
        statusBar.stopPolling();
      },
      onDisconnected: (reason) => {
        logger.log(`Subscriptions: disconnected (${reason}), enabling polling fallback.`);
        const intervalMs = settingsManager.get("pollingIntervalSeconds") * 1000;
        statusBar.startPolling(client, intervalMs);
      },
      onContractChanged: () => {
        void (async () => {
          try {
            const { contract, schedule } = await client.getAvailability();
            statusBar.update(contract, schedule);
            logger.log(formatContractLog(contract));
          } catch (error) {
            logger.log(
              `Subscription refresh failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        })();
      },
      onError: (message) => {
        logger.log(`Subscriptions: ${message}`);
        const intervalMs = settingsManager.get("pollingIntervalSeconds") * 1000;
        statusBar.startPolling(client, intervalMs);
      },
    },
  );

  availabilitySubscription.start();
}

function formatContractLog(
  contract: {
    mode: string;
    statusText?: string | null;
    statusEmoji?: string | null;
    expiresAt?: string | null;
    lock?: boolean | null;
    ruleSetType?: string | null;
  } | null,
): string {
  if (!contract) return "Status: no active contract";

  const parts: string[] = [`Status: ${formatModeLabel(contract.mode)}`];

  if (contract.statusText) {
    const emoji = contract.statusEmoji ? `${contract.statusEmoji} ` : "";
    parts.push(`${emoji}${contract.statusText}`);
  }

  if (contract.expiresAt) {
    const remaining = Math.ceil((new Date(contract.expiresAt).getTime() - Date.now()) / 60_000);
    if (remaining > 0) parts.push(`${remaining}m remaining`);
  }

  if (contract.ruleSetType) {
    const policy = contract.ruleSetType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    parts.push(`policy: ${policy}`);
  }

  if (contract.lock) parts.push("locked");

  return parts.join(" \u00b7 ");
}

function formatModeLabel(mode: string): string {
  switch (mode) {
    case "online":
      return "Online";
    case "busy":
      return "Focused";
    case "limited":
      return "Away";
    case "offline":
      return "Offline";
    default:
      return mode.charAt(0).toUpperCase() + mode.slice(1);
  }
}

// === Settings changes ===

async function onSettingsChanged(): Promise<void> {
  // Sync calibration setting to SDK config
  try {
    const configStore = new ConfigStore();
    const config = await configStore.load();
    const calibration = settingsManager.get("calibration");
    if (config.calibration !== calibration) {
      await configStore.save({ ...config, calibration });
      logger.log(`Calibration ${calibration ? "enabled" : "disabled"}`);
    }
  } catch {
    // Non-critical
  }

  if (authManager.isAuthenticated()) {
    await refreshAuthenticatedState();
  }
}

// === Quick Picks ===

async function showAuthenticatedQuickPick(): Promise<void> {
  const profile = authManager.getProfile();
  const items: vscode.QuickPickItem[] = [
    {
      label: "$(sign-out) Sign Out",
      description: profile ? `Signed in as ${profile.name ?? profile.email}` : undefined,
    },
    {
      label: "$(output) Show Logs",
      description: "View HeadsDown output channel",
    },
    {
      label: "$(gear) Settings",
      description: "Configure HeadsDown",
    },
  ];

  const selected = await vscode.window.showQuickPick(items, {
    title: "HeadsDown",
    placeHolder: "Quick Actions",
  });

  if (!selected) return;

  if (selected.label.includes("Sign Out")) {
    await vscode.commands.executeCommand("headsdown.signOut");
  } else if (selected.label.includes("Show Logs")) {
    logger.show();
  } else if (selected.label.includes("Settings")) {
    await vscode.commands.executeCommand("workbench.action.openSettings", "headsdown");
  }
}

async function showUnauthenticatedQuickPick(): Promise<void> {
  const items: vscode.QuickPickItem[] = [
    {
      label: "$(sign-in) Sign In",
      description: "Connect to sync your availability",
    },
    {
      label: "$(globe) Learn More",
      description: "headsdown.app",
    },
    {
      label: "$(gear) Settings",
      description: "Configure auto-detection and more",
    },
  ];

  const selected = await vscode.window.showQuickPick(items, {
    title: "HeadsDown",
    placeHolder: "Get started",
  });

  if (!selected) return;

  if (selected.label.includes("Sign In")) {
    await vscode.commands.executeCommand("headsdown.signIn");
  } else if (selected.label.includes("Learn More")) {
    await vscode.env.openExternal(vscode.Uri.parse("https://headsdown.app"));
  } else if (selected.label.includes("Settings")) {
    await vscode.commands.executeCommand("workbench.action.openSettings", "headsdown");
  }
}

// === Activity-Based Sign-In Nudge ===

async function showActivitySignInNudge(
  context: vscode.ExtensionContext,
  minutes: number,
): Promise<void> {
  const dismissed = context.globalState.get<boolean>(FIRST_RUN_DISMISSED_KEY);
  if (dismissed) return;

  // Don't show if user has already authenticated
  if (authManager.isAuthenticated()) return;

  logger.log(`Sustained coding detected (${minutes}m). Showing sign-in nudge.`);

  const action = await vscode.window.showInformationMessage(
    `You've been coding for ${minutes} minutes. Want to protect your focus time with HeadsDown?`,
    "Sign In",
    "Learn More",
    "Dismiss",
  );

  if (action === "Sign In") {
    await vscode.commands.executeCommand("headsdown.signIn");
  } else if (action === "Learn More") {
    await vscode.env.openExternal(vscode.Uri.parse("https://headsdown.app"));
  } else if (action === "Dismiss") {
    await context.globalState.update(FIRST_RUN_DISMISSED_KEY, true);
    logger.log("Sign-in nudge dismissed. Won't show again.");
  }
}
