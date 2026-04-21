import * as vscode from "vscode";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigStore, type HeadsDownClient } from "@headsdown/sdk";
import type {
  ActorContext,
  DelegationGrant,
  DelegationGrantFilterInput,
  DelegationGrantInput,
  DelegationGrantPermission,
  DelegationGrantScope,
} from "@headsdown/sdk";
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
let extensionContext: vscode.ExtensionContext | null = null;
let controlCenterPanel: vscode.WebviewPanel | null = null;

interface AvailabilityOverride {
  id: string;
  mode: "online" | "busy" | "limited" | "offline";
  reason: string | null;
  source: string;
  expiresAt: string;
  cancelledAt: string | null;
  expiredAt: string | null;
  createdById: string;
  cancelledById: string | null;
  insertedAt: string;
  updatedAt: string;
}

const ACTIVE_AVAILABILITY_OVERRIDE_QUERY = `
  query ActiveAvailabilityOverride {
    activeAvailabilityOverride {
      id
      mode
      reason
      source
      expiresAt
      cancelledAt
      expiredAt
      createdById
      cancelledById
      insertedAt
      updatedAt
    }
  }
`;

const CREATE_AVAILABILITY_OVERRIDE_MUTATION = `
  mutation CreateAvailabilityOverride($input: AvailabilityOverrideInput!) {
    createAvailabilityOverride(input: $input) {
      id
      mode
      reason
      source
      expiresAt
      cancelledAt
      expiredAt
      createdById
      cancelledById
      insertedAt
      updatedAt
    }
  }
`;

const CANCEL_AVAILABILITY_OVERRIDE_MUTATION = `
  mutation CancelAvailabilityOverride($id: ID!, $reason: String, $source: String) {
    cancelAvailabilityOverride(id: $id, reason: $reason, source: $source) {
      id
      mode
      reason
      source
      expiresAt
      cancelledAt
      expiredAt
      createdById
      cancelledById
      insertedAt
      updatedAt
    }
  }
`;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;

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
      statusBar.setSyncState("unknown");
      statusBar.stopTimer();
      statusBar.showUnauthenticated();
      statusBar.startActivityTracking();
      updateControlCenter();
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

    vscode.commands.registerCommand("headsdown.manageDelegationGrants", async () => {
      await manageDelegationGrants();
    }),

    vscode.commands.registerCommand("headsdown.manageAvailabilityOverride", async () => {
      await manageAvailabilityOverride();
    }),

    vscode.commands.registerCommand("headsdown.bootstrapAgentFiles", async () => {
      await bootstrapAgentFiles();
    }),

    vscode.commands.registerCommand("headsdown.copyStatusSnapshot", async () => {
      await copyStatusSnapshot();
    }),

    vscode.commands.registerCommand("headsdown.openControlCenter", async () => {
      await openControlCenter();
    }),

    vscode.commands.registerCommand("headsdown.generatePromptResources", async () => {
      await generatePromptResources();
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
  controlCenterPanel?.dispose();
  controlCenterPanel = null;
  // VS Code disposes subscriptions automatically, but be explicit
  statusBar?.dispose();
  logger?.dispose();
}

// === Authenticated state ===

async function refreshAuthenticatedState(): Promise<void> {
  const client = authManager.getClient();
  if (!client) return;

  try {
    const actorClient = withActorContext(client, "status.refresh");
    const { contract, schedule } = await actorClient.getAvailability();
    statusBar.update(contract, schedule);
    logger.log(formatContractLog(contract));
    statusBar.startTimer();
    statusBar.setSyncState("unknown");
    updateControlCenter();
    startRealtimeUpdates(client);
  } catch (error) {
    logger.log(
      `Failed to fetch availability: ${error instanceof Error ? error.message : String(error)}`,
    );
    statusBar.showApiUnreachable();

    // Poll so we can auto-recover even if initial subscription connection fails
    statusBar.startTimer();
    statusBar.setSyncState("polling");
    const intervalMs = settingsManager.get("pollingIntervalSeconds") * 1000;
    statusBar.startPolling(withActorContext(client, "status.polling_fallback"), intervalMs);
    updateControlCenter();
  }
}

function startRealtimeUpdates(client: HeadsDownClient): void {
  availabilitySubscription?.stop();

  const token = authManager.getApiKey();
  if (!token) {
    logger.log("Subscriptions: missing API token, using polling fallback.");
    statusBar.setSyncState("polling");
    const intervalMs = settingsManager.get("pollingIntervalSeconds") * 1000;
    statusBar.startPolling(withActorContext(client, "status.polling_no_token"), intervalMs);
    return;
  }

  availabilitySubscription = new AvailabilitySubscription(
    logger,
    () => settingsManager.get("apiBaseUrl"),
    () => authManager.getApiKey(),
    {
      onConnected: () => {
        logger.log("Subscriptions: connected (graphql-transport-ws)");
        statusBar.setSyncState("realtime");
        statusBar.stopPolling();
        updateControlCenter();
      },
      onDisconnected: (reason) => {
        logger.log(`Subscriptions: disconnected (${reason}), enabling polling fallback.`);
        statusBar.setSyncState("polling");
        const intervalMs = settingsManager.get("pollingIntervalSeconds") * 1000;
        statusBar.startPolling(withActorContext(client, "status.polling_disconnect"), intervalMs);
        updateControlCenter();
      },
      onContractChanged: () => {
        void (async () => {
          try {
            const actorClient = withActorContext(client, "status.subscription_refresh");
            const { contract, schedule } = await actorClient.getAvailability();
            statusBar.update(contract, schedule);
            logger.log(formatContractLog(contract));
            updateControlCenter();
          } catch (error) {
            logger.log(
              `Subscription refresh failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        })();
      },
      onError: (message) => {
        logger.log(`Subscriptions: ${message}`);
        statusBar.setSyncState("polling");
        const intervalMs = settingsManager.get("pollingIntervalSeconds") * 1000;
        statusBar.startPolling(withActorContext(client, "status.polling_error"), intervalMs);
        updateControlCenter();
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

  updateControlCenter();
}

// === Quick Picks ===

async function showAuthenticatedQuickPick(): Promise<void> {
  const profile = authManager.getProfile();
  const items: vscode.QuickPickItem[] = [
    {
      label: "$(shield) Manage Temporary Override",
      description: "Set, view, or clear temporary availability overrides",
    },
    {
      label: "$(organization) Manage Delegation Grants",
      description: "List, create, and revoke delegation grants",
    },
    {
      label: "$(sign-out) Sign Out",
      description: profile ? `Signed in as ${profile.name ?? profile.email}` : undefined,
    },
    {
      label: "$(graph) Open Control Center",
      description: "Open a focused HeadsDown dashboard",
    },
    {
      label: "$(copy) Copy Status Snapshot",
      description: "Copy current mode, timing, and policy context",
    },
    {
      label: "$(output) Show Logs",
      description: "View HeadsDown output channel",
    },
    {
      label: "$(file-add) Bootstrap Agent Files",
      description: "Scaffold Cursor, Claude, and Copilot files",
    },
    {
      label: "$(sparkle) Generate Prompt Resources",
      description: "Create experimental HeadsDown prompt files",
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

  if (selected.label.includes("Temporary Override")) {
    await vscode.commands.executeCommand("headsdown.manageAvailabilityOverride");
  } else if (selected.label.includes("Delegation Grants")) {
    await vscode.commands.executeCommand("headsdown.manageDelegationGrants");
  } else if (selected.label.includes("Sign Out")) {
    await vscode.commands.executeCommand("headsdown.signOut");
  } else if (selected.label.includes("Open Control Center")) {
    await vscode.commands.executeCommand("headsdown.openControlCenter");
  } else if (selected.label.includes("Copy Status Snapshot")) {
    await vscode.commands.executeCommand("headsdown.copyStatusSnapshot");
  } else if (selected.label.includes("Show Logs")) {
    logger.show();
  } else if (selected.label.includes("Bootstrap Agent Files")) {
    await vscode.commands.executeCommand("headsdown.bootstrapAgentFiles");
  } else if (selected.label.includes("Generate Prompt Resources")) {
    await vscode.commands.executeCommand("headsdown.generatePromptResources");
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
      label: "$(file-add) Bootstrap Agent Files",
      description: "Scaffold Cursor, Claude, and Copilot files",
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
  } else if (selected.label.includes("Bootstrap Agent Files")) {
    await vscode.commands.executeCommand("headsdown.bootstrapAgentFiles");
  } else if (selected.label.includes("Settings")) {
    await vscode.commands.executeCommand("workbench.action.openSettings", "headsdown");
  }
}

async function manageDelegationGrants(): Promise<void> {
  const client = authManager.getClient();
  if (!client) {
    vscode.window.showErrorMessage("HeadsDown: Sign in first to manage delegation grants.");
    return;
  }

  const actorClient = withActorContext(client, "grants.manage");
  const action = await vscode.window.showQuickPick(
    [
      { label: "List Active Grants", value: "list_active" as const },
      { label: "List Grants (Filtered)", value: "list" as const },
      { label: "Create Delegation Grant", value: "create" as const },
      { label: "Revoke Delegation Grant", value: "revoke" as const },
      { label: "Revoke Grants in Bulk", value: "revoke_many" as const },
    ],
    {
      title: "HeadsDown Delegation Grants",
      placeHolder: "Select an action",
    },
  );

  if (!action) return;

  try {
    if (action.value === "list_active") {
      const grants = await actorClient.listActiveDelegationGrants();
      await showGrantsQuickPick("Active delegation grants", grants);
      return;
    }

    if (action.value === "list") {
      const filter = await promptDelegationGrantFilter();
      if (filter === null) return;
      const grants = await actorClient.listDelegationGrants(filter);
      await showGrantsQuickPick("Delegation grants", grants);
      return;
    }

    if (action.value === "create") {
      const input = await promptCreateDelegationGrantInput();
      if (!input) return;
      const grant = await actorClient.createDelegationGrant(input);
      logger.log(`Created delegation grant ${grant.id} (${grant.scope}).`);
      vscode.window.showInformationMessage(`HeadsDown: created delegation grant ${grant.id}.`);
      await refreshAuthenticatedState();
      return;
    }

    if (action.value === "revoke") {
      const grants = await actorClient.listDelegationGrants();
      if (grants.length === 0) {
        vscode.window.showInformationMessage("HeadsDown: no delegation grants found.");
        return;
      }

      const selected = await vscode.window.showQuickPick(
        grants.map((grant) => ({
          label: `${grant.scope} · ${grant.id}`,
          description: formatGrantDescription(grant),
          grant,
        })),
        {
          title: "Revoke delegation grant",
          placeHolder: "Select a grant to revoke",
        },
      );
      if (!selected) return;

      const revoked = await actorClient.revokeDelegationGrant(selected.grant.id);
      logger.log(`Revoked delegation grant ${revoked.id}.`);
      vscode.window.showInformationMessage(`HeadsDown: revoked delegation grant ${revoked.id}.`);
      await refreshAuthenticatedState();
      return;
    }

    const filter = await promptDelegationGrantFilter();
    if (filter === null) return;
    const confirmation = await vscode.window.showWarningMessage(
      "HeadsDown: revoke all matching delegation grants?",
      { modal: true },
      "Revoke",
    );
    if (confirmation !== "Revoke") return;

    const result = await actorClient.revokeDelegationGrants(filter);
    logger.log(`Bulk revoked ${result.revokedCount} delegation grants.`);
    vscode.window.showInformationMessage(
      `HeadsDown: revoked ${result.revokedCount} delegation grant${result.revokedCount === 1 ? "" : "s"}.`,
    );
    await refreshAuthenticatedState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.log(`Delegation grant operation failed: ${message}`);
    vscode.window.showErrorMessage(`HeadsDown: ${mapDelegationGrantErrorMessage(message)}`);
  }
}

async function manageAvailabilityOverride(): Promise<void> {
  const client = authManager.getClient();
  if (!client) {
    vscode.window.showErrorMessage("HeadsDown: Sign in first to manage temporary overrides.");
    return;
  }

  const actorClient = withActorContext(client, "override.manage");
  const action = await vscode.window.showQuickPick(
    [
      { label: "View Active Override", value: "get" as const },
      { label: "Set Temporary Override", value: "set" as const },
      { label: "Clear Active Override", value: "clear" as const },
    ],
    {
      title: "HeadsDown Temporary Override",
      placeHolder: "Select an action",
    },
  );

  if (!action) return;

  try {
    if (action.value === "get") {
      const override = await getActiveAvailabilityOverrideCompat(actorClient);
      if (!override) {
        vscode.window.showInformationMessage("HeadsDown: no active temporary override.");
        return;
      }
      vscode.window.showInformationMessage(
        `HeadsDown override: ${override.mode} (${formatOverrideExpiry(override.expiresAt)}).`,
      );
      return;
    }

    if (action.value === "set") {
      const input = await promptAvailabilityOverrideInput();
      if (!input) return;
      const override = await createAvailabilityOverrideCompat(actorClient, input);
      logger.log(`Created availability override ${override.id} (${override.mode}).`);
      vscode.window.showInformationMessage(
        `HeadsDown: temporary override set to ${override.mode} (${formatOverrideExpiry(override.expiresAt)}).`,
      );
      await refreshAuthenticatedState();
      return;
    }

    const active = await getActiveAvailabilityOverrideCompat(actorClient);
    if (!active) {
      vscode.window.showInformationMessage("HeadsDown: no active temporary override to clear.");
      return;
    }

    const reasonInput = await vscode.window.showInputBox({
      title: "Clear temporary override",
      prompt: "Optional reason",
      placeHolder: "Done with focus block",
    });

    const cancelled = await cancelAvailabilityOverrideCompat(
      actorClient,
      active.id,
      reasonInput?.trim() ? reasonInput.trim() : undefined,
    );
    logger.log(`Cancelled availability override ${cancelled.id}.`);
    vscode.window.showInformationMessage("HeadsDown: temporary override cleared.");
    await refreshAuthenticatedState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.log(`Availability override operation failed: ${message}`);
    vscode.window.showErrorMessage(`HeadsDown: ${message}`);
  }
}

async function showGrantsQuickPick(title: string, grants: DelegationGrant[]): Promise<void> {
  if (grants.length === 0) {
    vscode.window.showInformationMessage("HeadsDown: no matching delegation grants.");
    return;
  }

  await vscode.window.showQuickPick(
    grants.map((grant) => ({
      label: `${grant.scope} · ${grant.id}`,
      description: formatGrantDescription(grant),
    })),
    {
      title,
      placeHolder: `${grants.length} grant${grants.length === 1 ? "" : "s"}`,
    },
  );
}

function formatGrantDescription(grant: DelegationGrant): string {
  const permissions = grant.permissions.join(", ");
  const state = grant.revokedAt ? "revoked" : grant.expiredAt ? "expired" : "active";
  return `${permissions} · ${state} · expires ${grant.expiresAt}`;
}

async function promptDelegationGrantFilter(): Promise<DelegationGrantFilterInput | null> {
  type ScopeChoice = DelegationGrantScope | undefined;

  const scope = await new Promise<ScopeChoice | null>((resolve) => {
    const quickPick = vscode.window.createQuickPick<{
      label: string;
      description?: string;
      value: ScopeChoice;
    }>();

    const activeOnlyButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("check"),
      tooltip: "Active only",
      location: vscode.QuickInputButtonLocation.Inline,
      toggle: { checked: false },
    };

    const inactiveOnlyButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("circle-slash"),
      tooltip: "Inactive only",
      location: vscode.QuickInputButtonLocation.Inline,
      toggle: { checked: false },
    };

    quickPick.title = "Delegation grant filters";
    quickPick.placeholder = "Pick a scope, then press Enter";
    quickPick.items = [
      { label: "Any scope", value: undefined },
      { label: "Session", description: "Current session", value: "session" },
      { label: "Workspace", description: "Current workspace", value: "workspace" },
      { label: "Agent", description: "Agent-scoped grants", value: "agent" },
    ];
    quickPick.buttons = [activeOnlyButton, inactiveOnlyButton];

    let resolved = false;

    quickPick.onDidTriggerButton((button) => {
      if (button === activeOnlyButton && activeOnlyButton.toggle?.checked) {
        if (inactiveOnlyButton.toggle) {
          inactiveOnlyButton.toggle.checked = false;
        }
      }

      if (button === inactiveOnlyButton && inactiveOnlyButton.toggle?.checked) {
        if (activeOnlyButton.toggle) {
          activeOnlyButton.toggle.checked = false;
        }
      }

      quickPick.buttons = [activeOnlyButton, inactiveOnlyButton];
    });

    quickPick.onDidAccept(() => {
      resolved = true;
      const selected = quickPick.selectedItems[0];
      quickPick.hide();
      resolve(selected?.value ?? undefined);
    });

    quickPick.onDidHide(() => {
      if (!resolved) {
        resolve(null);
      }
      quickPick.dispose();
    });

    quickPick.show();
  });

  if (scope === null) return null;

  const active = await new Promise<boolean | undefined | null>((resolve) => {
    const quickPick = vscode.window.createQuickPick<{
      label: string;
      value: boolean | undefined;
    }>();

    quickPick.title = "Delegation grant active-state filter";
    quickPick.placeholder = "Pick active-state filter";
    quickPick.items = [
      { label: "All", value: undefined },
      { label: "Active only", value: true },
      { label: "Inactive only", value: false },
    ];

    let resolved = false;

    quickPick.onDidAccept(() => {
      resolved = true;
      const selected = quickPick.selectedItems[0];
      quickPick.hide();
      resolve(selected?.value ?? undefined);
    });

    quickPick.onDidHide(() => {
      if (!resolved) {
        resolve(null);
      }
      quickPick.dispose();
    });

    quickPick.show();
  });

  if (active === null) return null;

  return {
    active,
    scope,
    sessionId: scope === "session" ? vscode.env.sessionId : undefined,
    workspaceRef: scope === "workspace" ? getWorkspaceRef() : undefined,
  };
}

async function promptCreateDelegationGrantInput(): Promise<DelegationGrantInput | null> {
  const scopeChoice = await vscode.window.showQuickPick(
    [
      { label: "Session scope", value: "session" as const },
      { label: "Workspace scope", value: "workspace" as const },
      { label: "Agent scope", value: "agent" as const },
    ],
    {
      title: "Delegation grant scope",
      placeHolder: "Choose scope",
    },
  );
  if (!scopeChoice) return null;

  const permissionChoices = await vscode.window.showQuickPick(
    [
      { label: "Create availability overrides", value: "availability_override_create" as const },
      { label: "Cancel availability overrides", value: "availability_override_cancel" as const },
      { label: "Apply presets", value: "preset_apply" as const },
    ],
    {
      title: "Delegation permissions",
      canPickMany: true,
      placeHolder: "Select one or more permissions",
    },
  );
  if (!permissionChoices || permissionChoices.length === 0) {
    vscode.window.showWarningMessage("HeadsDown: select at least one permission.");
    return null;
  }

  const durationInput = await vscode.window.showInputBox({
    title: "Delegation duration",
    prompt: "Duration in minutes (optional)",
    placeHolder: "60",
    validateInput: (value) => {
      if (!value.trim()) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? null : "Enter a positive number";
    },
  });
  if (durationInput === undefined) return null;

  const sourceInput = await vscode.window.showInputBox({
    title: "Delegation source",
    prompt: "Optional source label",
    placeHolder: "vscode",
    value: "vscode",
  });
  if (sourceInput === undefined) return null;

  const scope = scopeChoice.value;
  const sessionId = scope === "session" ? vscode.env.sessionId : undefined;
  const workspaceRef = scope === "workspace" ? getWorkspaceRef() : undefined;

  return {
    scope: scope as DelegationGrantScope,
    sessionId,
    workspaceRef,
    agentId: scope === "agent" ? "vscode-extension" : undefined,
    permissions: permissionChoices.map((choice) => choice.value) as DelegationGrantPermission[],
    durationMinutes: durationInput.trim() ? Number(durationInput.trim()) : undefined,
    source: sourceInput.trim() || "vscode",
  };
}

type AvailabilityOverrideInput = {
  mode: AvailabilityOverride["mode"];
  durationMinutes?: number;
  expiresAt?: string;
  reason?: string;
  source?: string;
};

async function promptAvailabilityOverrideInput(): Promise<AvailabilityOverrideInput | null> {
  const modeChoice = await vscode.window.showQuickPick(
    [
      { label: "Online", value: "online" as const },
      { label: "Busy", value: "busy" as const },
      { label: "Limited", value: "limited" as const },
      { label: "Offline", value: "offline" as const },
    ],
    {
      title: "Override mode",
      placeHolder: "Choose temporary mode",
    },
  );
  if (!modeChoice) return null;

  const durationInput = await vscode.window.showInputBox({
    title: "Override duration",
    prompt: "Duration in minutes (optional)",
    placeHolder: "30",
    validateInput: (value) => {
      if (!value.trim()) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? null : "Enter a positive number";
    },
  });
  if (durationInput === undefined) return null;

  const reasonInput = await vscode.window.showInputBox({
    title: "Override reason",
    prompt: "Optional reason",
    placeHolder: "Deep focus block",
  });
  if (reasonInput === undefined) return null;

  return {
    mode: modeChoice.value,
    durationMinutes: durationInput.trim() ? Number(durationInput.trim()) : undefined,
    reason: reasonInput.trim() || undefined,
    source: "vscode",
  };
}

function formatOverrideExpiry(expiresAt: string): string {
  const date = new Date(expiresAt);
  return date.toLocaleString([], {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

function getWorkspaceRef(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

function buildActorContext(feature: string): ActorContext {
  return {
    source: "vscode",
    agentId: `vscode:${feature}`,
    sessionId: vscode.env.sessionId,
    workspaceRef: getWorkspaceRef(),
  };
}

function withActorContext(client: HeadsDownClient, feature: string): HeadsDownClient {
  return client.withActor(buildActorContext(feature));
}

function isSessionTokenOnlyGrantError(message: string): boolean {
  return (
    message.includes("session-token auth path") ||
    message.includes("session-token auth") ||
    message.includes("Delegation grants require session-token auth")
  );
}

function mapDelegationGrantErrorMessage(message: string): string {
  if (isSessionTokenOnlyGrantError(message)) {
    return "Delegation grant management requires a session-token auth path and is unavailable for API-key clients.";
  }

  return message;
}

function getLowLevelGraphQLClient(client: HeadsDownClient): {
  request: (query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>;
} | null {
  const maybeGraphQL = (client as unknown as { graphql?: unknown }).graphql;
  if (!maybeGraphQL || typeof maybeGraphQL !== "object") return null;

  const request = (maybeGraphQL as { request?: unknown }).request;
  if (typeof request !== "function") return null;

  return {
    request: request.bind(maybeGraphQL) as (
      query: string,
      variables?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>,
  };
}

async function createAvailabilityOverrideCompat(
  client: HeadsDownClient,
  input: AvailabilityOverrideInput,
): Promise<AvailabilityOverride> {
  const nativeMethod = (
    client as unknown as {
      createAvailabilityOverride?: (
        value: AvailabilityOverrideInput,
      ) => Promise<AvailabilityOverride>;
    }
  ).createAvailabilityOverride;

  if (typeof nativeMethod === "function") {
    return nativeMethod(input);
  }

  const graphql = getLowLevelGraphQLClient(client);
  if (!graphql) {
    throw new Error("Availability override APIs are unavailable in this @headsdown/sdk version.");
  }

  const data = await graphql.request(CREATE_AVAILABILITY_OVERRIDE_MUTATION, { input });
  const override =
    (data.createAvailabilityOverride as AvailabilityOverride | null | undefined) ?? null;
  if (!override) {
    throw new Error("HeadsDown API returned no availability override data.");
  }

  return override;
}

async function getActiveAvailabilityOverrideCompat(
  client: HeadsDownClient,
): Promise<AvailabilityOverride | null> {
  const nativeMethod = (
    client as unknown as {
      getActiveAvailabilityOverride?: () => Promise<AvailabilityOverride | null>;
    }
  ).getActiveAvailabilityOverride;

  if (typeof nativeMethod === "function") {
    return nativeMethod();
  }

  const graphql = getLowLevelGraphQLClient(client);
  if (!graphql) {
    throw new Error("Availability override APIs are unavailable in this @headsdown/sdk version.");
  }

  const data = await graphql.request(ACTIVE_AVAILABILITY_OVERRIDE_QUERY);
  return (data.activeAvailabilityOverride as AvailabilityOverride | null | undefined) ?? null;
}

async function cancelAvailabilityOverrideCompat(
  client: HeadsDownClient,
  id: string,
  reason?: string,
): Promise<AvailabilityOverride> {
  const nativeMethod = (
    client as unknown as {
      cancelAvailabilityOverride?: (
        value: string,
        reason?: string,
      ) => Promise<AvailabilityOverride>;
    }
  ).cancelAvailabilityOverride;

  if (typeof nativeMethod === "function") {
    return nativeMethod(id, reason);
  }

  const graphql = getLowLevelGraphQLClient(client);
  if (!graphql) {
    throw new Error("Availability override APIs are unavailable in this @headsdown/sdk version.");
  }

  const data = await graphql.request(CANCEL_AVAILABILITY_OVERRIDE_MUTATION, {
    id,
    reason,
    source: "vscode",
  });
  const override =
    (data.cancelAvailabilityOverride as AvailabilityOverride | null | undefined) ?? null;
  if (!override) {
    throw new Error("HeadsDown API returned no cancelled availability override data.");
  }

  return override;
}

type AgentBootstrapTemplate = {
  label: string;
  targetPath: string;
  templatePath: string;
  appendWhenExists?: boolean;
};

const AGENT_BOOTSTRAP_TEMPLATES: AgentBootstrapTemplate[] = [
  {
    label: "Cursor rule (.cursor/rules/headsdown.mdc)",
    targetPath: ".cursor/rules/headsdown.mdc",
    templatePath: "templates/cursor/headsdown.mdc",
  },
  {
    label: "Claude guidance (.claude/HEADSDOWN.md)",
    targetPath: ".claude/HEADSDOWN.md",
    templatePath: "templates/claude/HEADSDOWN.md",
  },
  {
    label: "Copilot instructions (.github/copilot-instructions.md)",
    targetPath: ".github/copilot-instructions.md",
    templatePath: "templates/copilot/copilot-instructions.md",
    appendWhenExists: true,
  },
  {
    label: "Hooks sample (.vscode/headsdown-hooks.sample.json)",
    targetPath: ".vscode/headsdown-hooks.sample.json",
    templatePath: "templates/hooks/headsdown-hooks.sample.json",
  },
];

const PROMPT_RESOURCE_TEMPLATES: AgentBootstrapTemplate[] = [
  {
    label: "Status snapshot prompt (.github/prompts/headsdown-status.prompt.md)",
    targetPath: ".github/prompts/headsdown-status.prompt.md",
    templatePath: "templates/prompts/headsdown-status.prompt.md",
  },
  {
    label: "Proposal prompt (.github/prompts/headsdown-propose.prompt.md)",
    targetPath: ".github/prompts/headsdown-propose.prompt.md",
    templatePath: "templates/prompts/headsdown-propose.prompt.md",
  },
];

async function bootstrapAgentFiles(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage(
      "HeadsDown: open a workspace folder before bootstrapping files.",
    );
    return;
  }

  if (!extensionContext) {
    vscode.window.showErrorMessage("HeadsDown: extension context unavailable.");
    return;
  }

  const choices = await vscode.window.showQuickPick(
    AGENT_BOOTSTRAP_TEMPLATES.map((template) => ({ label: template.label, template })),
    {
      title: "HeadsDown bootstrap",
      placeHolder: "Select files to scaffold",
      canPickMany: true,
    },
  );

  if (!choices || choices.length === 0) return;

  const created: string[] = [];
  const skipped: string[] = [];

  for (const choice of choices) {
    const template = choice.template;
    const templatePath = join(extensionContext.extensionPath, template.templatePath);
    const targetPath = join(folder.uri.fsPath, template.targetPath);

    try {
      const templateContent = await readFile(templatePath, "utf-8");
      await mkdir(dirname(targetPath), { recursive: true });

      if (await fileExists(targetPath)) {
        if (!template.appendWhenExists) {
          skipped.push(template.targetPath);
          continue;
        }

        const existing = await readFile(targetPath, "utf-8");
        if (existing.includes("HeadsDown policy") || existing.includes("HeadsDown Integration")) {
          skipped.push(template.targetPath);
          continue;
        }

        const merged = `${existing.trimEnd()}\n\n${templateContent.trim()}\n`;
        await writeFile(targetPath, merged, "utf-8");
        created.push(`${template.targetPath} (appended)`);
        continue;
      }

      await writeFile(targetPath, templateContent, "utf-8");
      created.push(template.targetPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.log(`Bootstrap failed for ${template.targetPath}: ${message}`);
      vscode.window.showErrorMessage(
        `HeadsDown bootstrap failed for ${template.targetPath}: ${message}`,
      );
    }
  }

  const summary = `HeadsDown bootstrap: ${created.length} created, ${skipped.length} skipped.`;
  logger.log(summary);
  vscode.window.showInformationMessage(summary);
  updateControlCenter();
}

async function generatePromptResources(): Promise<void> {
  if (!settingsManager.get("experimentalEnablePromptResources")) {
    const selection = await vscode.window.showInformationMessage(
      "HeadsDown prompt resources are experimental. Enable headsdown.experimental.enablePromptResources to continue.",
      "Open Settings",
    );
    if (selection === "Open Settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "headsdown.experimental.enablePromptResources",
      );
    }
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage(
      "HeadsDown: open a workspace folder before generating prompt resources.",
    );
    return;
  }

  if (!extensionContext) {
    vscode.window.showErrorMessage("HeadsDown: extension context unavailable.");
    return;
  }

  for (const template of PROMPT_RESOURCE_TEMPLATES) {
    const templatePath = join(extensionContext.extensionPath, template.templatePath);
    const targetPath = join(folder.uri.fsPath, template.targetPath);

    const templateContent = await readFile(templatePath, "utf-8");
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, templateContent, "utf-8");
  }

  vscode.window.showInformationMessage("HeadsDown: prompt resources generated in .github/prompts.");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copyStatusSnapshot(): Promise<void> {
  const snapshot = statusBar.getStatusSnapshot();
  await vscode.env.clipboard.writeText(JSON.stringify(snapshot, null, 2));
  vscode.window.showInformationMessage("HeadsDown: copied status snapshot to clipboard.");
}

async function openControlCenter(): Promise<void> {
  if (controlCenterPanel) {
    controlCenterPanel.reveal(vscode.ViewColumn.One);
    updateControlCenter();
    return;
  }

  controlCenterPanel = vscode.window.createWebviewPanel(
    "headsdown.controlCenter",
    "HeadsDown Control Center",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );
  controlCenterPanel.iconPath = new vscode.ThemeIcon("shield");

  controlCenterPanel.onDidDispose(() => {
    controlCenterPanel = null;
  });

  controlCenterPanel.webview.onDidReceiveMessage((message: { action?: string }) => {
    if (message.action === "refresh") {
      void refreshAuthenticatedState();
      return;
    }
    if (message.action === "quick-actions") {
      void vscode.commands.executeCommand("headsdown.quickAction");
      return;
    }
    if (message.action === "manage-override") {
      void vscode.commands.executeCommand("headsdown.manageAvailabilityOverride");
      return;
    }
    if (message.action === "manage-grants") {
      void vscode.commands.executeCommand("headsdown.manageDelegationGrants");
      return;
    }
    if (message.action === "copy-snapshot") {
      void vscode.commands.executeCommand("headsdown.copyStatusSnapshot");
    }
  });

  renderControlCenter();
}

function updateControlCenter(): void {
  if (!controlCenterPanel) return;
  const snapshot = statusBar.getStatusSnapshot();
  void controlCenterPanel.webview.postMessage({
    type: "snapshot",
    snapshot,
    profile: authManager.getProfile(),
  });
}

function renderControlCenter(): void {
  if (!controlCenterPanel) return;

  const nonce = Math.random().toString(36).slice(2);
  const snapshot = statusBar.getStatusSnapshot();
  const profile = authManager.getProfile();
  const snapshotJson = JSON.stringify({ snapshot, profile }, null, 2);

  controlCenterPanel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${controlCenterPanel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>HeadsDown Control Center</title>
  <style>
    body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); }
    .buttons { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 16px; }
    button { padding: 8px 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 6px; cursor: pointer; }
    pre { background: var(--vscode-editor-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; padding: 12px; overflow: auto; max-height: 60vh; }
  </style>
</head>
<body>
  <h2>HeadsDown Control Center</h2>
  <div class="buttons">
    <button data-action="refresh">Refresh</button>
    <button data-action="quick-actions">Quick Actions</button>
    <button data-action="manage-override">Manage Override</button>
    <button data-action="manage-grants">Manage Grants</button>
    <button data-action="copy-snapshot">Copy Snapshot</button>
  </div>
  <pre id="snapshot"></pre>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initial = ${JSON.stringify(snapshotJson)};
    const snapshotEl = document.getElementById('snapshot');
    snapshotEl.textContent = initial;

    window.addEventListener('message', (event) => {
      if (event.data?.type === 'snapshot') {
        snapshotEl.textContent = JSON.stringify({ snapshot: event.data.snapshot, profile: event.data.profile }, null, 2);
      }
    });

    for (const button of document.querySelectorAll('button[data-action]')) {
      button.addEventListener('click', () => {
        vscode.postMessage({ action: button.getAttribute('data-action') });
      });
    }
  </script>
</body>
</html>`;
}

export const __internal = {
  buildActorContext,
  withActorContext,
  getLowLevelGraphQLClient,
  createAvailabilityOverrideCompat,
  getActiveAvailabilityOverrideCompat,
  cancelAvailabilityOverrideCompat,
  formatGrantDescription,
  mapDelegationGrantErrorMessage,
};

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
