import * as vscode from "vscode";
import { OutputLogger } from "./output.js";
import { AuthManager } from "./auth.js";
import { StatusBarManager } from "./status-bar.js";
import { SettingsManager } from "./settings.js";

const FIRST_ACTIVATED_KEY = "headsdown.firstActivatedAt";
const FIRST_RUN_DISMISSED_KEY = "headsdown.firstRunDismissed";

let logger: OutputLogger;
let authManager: AuthManager;
let statusBar: StatusBarManager;
let settingsManager: SettingsManager;
let firstInstallTimeout: ReturnType<typeof setTimeout> | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Initialize core services
  logger = new OutputLogger();
  settingsManager = new SettingsManager();
  statusBar = new StatusBarManager(logger, settingsManager);
  authManager = new AuthManager(context.secrets, logger, () => settingsManager.get("apiBaseUrl"));

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
        onSettingsChanged();
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
    await handleFirstInstall(context);
  }
}

export function deactivate(): void {
  if (firstInstallTimeout !== null) {
    clearTimeout(firstInstallTimeout);
    firstInstallTimeout = null;
  }
  // VS Code disposes subscriptions automatically, but be explicit
  statusBar?.dispose();
  logger?.dispose();
}

// === Authenticated state ===

async function refreshAuthenticatedState(): Promise<void> {
  const client = authManager.getClient();
  if (!client) return;

  try {
    const { contract, calendar } = await client.getAvailability();
    statusBar.update(contract, calendar);
    logger.log(formatContractLog(contract));

    // Start timer and polling
    statusBar.startTimer();
    const intervalMs = settingsManager.get("pollingIntervalSeconds") * 1000;
    statusBar.startPolling(client, intervalMs);
  } catch (error) {
    logger.log(
      `Failed to fetch availability: ${error instanceof Error ? error.message : String(error)}`,
    );
    statusBar.showApiUnreachable();

    // Still start polling so we can auto-recover when the API becomes reachable
    statusBar.startTimer();
    const intervalMs = settingsManager.get("pollingIntervalSeconds") * 1000;
    statusBar.startPolling(client, intervalMs);
  }
}

function formatContractLog(
  contract: {
    mode: string;
    statusText?: string | null;
    statusEmoji?: string | null;
    expiresAt?: string | null;
    lock?: boolean | null;
  } | null,
): string {
  if (!contract) return "Status: no active contract";

  const parts: string[] = [`Status: ${capitalize(contract.mode)}`];

  if (contract.statusText) {
    const emoji = contract.statusEmoji ? `${contract.statusEmoji} ` : "";
    parts.push(`${emoji}${contract.statusText}`);
  }

  if (contract.expiresAt) {
    const remaining = Math.ceil((new Date(contract.expiresAt).getTime() - Date.now()) / 60_000);
    if (remaining > 0) parts.push(`${remaining}m remaining`);
  }

  if (contract.lock) parts.push("locked");

  return parts.join(" \u00b7 ");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// === Settings changes ===

function onSettingsChanged(): void {
  if (authManager.isAuthenticated()) {
    const client = authManager.getClient();
    if (client) {
      statusBar.stopPolling();
      const intervalMs = settingsManager.get("pollingIntervalSeconds") * 1000;
      statusBar.startPolling(client, intervalMs);
    }
    refreshAuthenticatedState();
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

// === First Install Notification ===

async function handleFirstInstall(context: vscode.ExtensionContext): Promise<void> {
  const dismissed = context.globalState.get<boolean>(FIRST_RUN_DISMISSED_KEY);
  if (dismissed) return;

  const firstActivatedAt = context.globalState.get<string>(FIRST_ACTIVATED_KEY);

  if (!firstActivatedAt) {
    // First ever activation: record the timestamp, don't show yet
    await context.globalState.update(FIRST_ACTIVATED_KEY, new Date().toISOString());
    logger.log(
      "First activation recorded. Welcome notification will appear in 24h if auto-detect doesn't fire first.",
    );
    return;
  }

  // Check if 24 hours have passed
  const activatedMs = new Date(firstActivatedAt).getTime();
  const elapsed = Date.now() - activatedMs;
  const twentyFourHours = 24 * 60 * 60 * 1000;

  if (elapsed < twentyFourHours) {
    // Schedule a check for when 24h elapses (within this session)
    const remainingMs = twentyFourHours - elapsed;
    if (remainingMs < 60 * 60 * 1000) {
      // Only schedule if less than 1 hour remaining (reasonable session length)
      firstInstallTimeout = setTimeout(() => {
        firstInstallTimeout = null;
        showFirstInstallNotification(context);
      }, remainingMs);
    }
    return;
  }

  // 24 hours have passed without auto-detect firing
  await showFirstInstallNotification(context);
}

async function showFirstInstallNotification(context: vscode.ExtensionContext): Promise<void> {
  const dismissed = context.globalState.get<boolean>(FIRST_RUN_DISMISSED_KEY);
  if (dismissed) return;

  // Don't show if user has already authenticated
  if (authManager.isAuthenticated()) return;

  const action = await vscode.window.showInformationMessage(
    "HeadsDown gives your AI agent awareness of your focus mode and availability.",
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
    logger.log("First-install notification dismissed. Won't show again.");
  }
}
