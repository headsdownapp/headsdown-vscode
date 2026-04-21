import * as vscode from "vscode";
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
    const actorClient = withActorContext(client, "status.refresh");
    const { contract, schedule } = await actorClient.getAvailability();
    statusBar.update(contract, schedule);
    logger.log(formatContractLog(contract));
    statusBar.startTimer();
    statusBar.setSyncState("unknown");
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
      },
      onDisconnected: (reason) => {
        logger.log(`Subscriptions: disconnected (${reason}), enabling polling fallback.`);
        statusBar.setSyncState("polling");
        const intervalMs = settingsManager.get("pollingIntervalSeconds") * 1000;
        statusBar.startPolling(withActorContext(client, "status.polling_disconnect"), intervalMs);
      },
      onContractChanged: () => {
        void (async () => {
          try {
            const actorClient = withActorContext(client, "status.subscription_refresh");
            const { contract, schedule } = await actorClient.getAvailability();
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
        statusBar.setSyncState("polling");
        const intervalMs = settingsManager.get("pollingIntervalSeconds") * 1000;
        statusBar.startPolling(withActorContext(client, "status.polling_error"), intervalMs);
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

  if (selected.label.includes("Temporary Override")) {
    await vscode.commands.executeCommand("headsdown.manageAvailabilityOverride");
  } else if (selected.label.includes("Delegation Grants")) {
    await vscode.commands.executeCommand("headsdown.manageDelegationGrants");
  } else if (selected.label.includes("Sign Out")) {
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
    vscode.window.showErrorMessage(`HeadsDown: ${message}`);
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
  const activeChoice = await vscode.window.showQuickPick(
    [
      { label: "All", value: undefined },
      { label: "Active only", value: true },
      { label: "Inactive only", value: false },
    ],
    { title: "Filter by active state" },
  );
  if (!activeChoice) return null;

  const scopeChoice = await vscode.window.showQuickPick(
    [
      { label: "Any scope", value: undefined },
      { label: "Session", value: "session" as const },
      { label: "Workspace", value: "workspace" as const },
      { label: "Agent", value: "agent" as const },
    ],
    { title: "Filter by scope" },
  );
  if (!scopeChoice) return null;

  return {
    active: activeChoice.value,
    scope: scopeChoice.value,
    sessionId: scopeChoice.value === "session" ? vscode.env.sessionId : undefined,
    workspaceRef: scopeChoice.value === "workspace" ? getWorkspaceRef() : undefined,
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

export const __internal = {
  buildActorContext,
  withActorContext,
  getLowLevelGraphQLClient,
  createAvailabilityOverrideCompat,
  getActiveAvailabilityOverrideCompat,
  cancelAvailabilityOverrideCompat,
  formatGrantDescription,
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
