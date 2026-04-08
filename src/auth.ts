import * as vscode from "vscode";
import {
  HeadsDownClient,
  DeviceFlow,
  type DeviceAuthorization,
  type UserProfile,
} from "@headsdown/sdk";
import type { OutputLogger } from "./output.js";

/**
 * Manages Device Flow authentication within VS Code.
 * Uses vscode.SecretStorage for credential persistence and
 * vscode.window.withProgress for the approval flow UI.
 *
 * Credentials are stored exclusively in VS Code's SecretStorage,
 * not on disk. This avoids conflicts with the CLI credential store
 * and ensures credentials are scoped to the editor.
 */
export class AuthManager {
  private static readonly SECRET_KEY = "headsdown.apiKey";

  private client: HeadsDownClient | null = null;
  private profile: UserProfile | null = null;
  private apiKey: string | null = null;
  private abortController: AbortController | null = null;

  constructor(
    private readonly secretStorage: vscode.SecretStorage,
    private readonly logger: OutputLogger,
    private readonly getBaseUrl: () => string,
  ) {}

  /** Check if we have stored credentials and they're valid. */
  async initialize(): Promise<boolean> {
    const apiKey = await this.secretStorage.get(AuthManager.SECRET_KEY);
    if (!apiKey) {
      this.logger.log("No credentials found.");
      return false;
    }

    this.logger.log("Credentials found, validating...");

    try {
      this.client = new HeadsDownClient({
        apiKey,
        baseUrl: this.getBaseUrl(),
      });
      this.apiKey = apiKey;
      this.profile = await this.client.getProfile();
      this.logger.log(`Authenticated as ${this.profile.name ?? "unknown"} (${this.profile.email})`);
      return true;
    } catch (error) {
      this.logger.log(
        `Stored credentials invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.secretStorage.delete(AuthManager.SECRET_KEY);
      this.client = null;
      this.profile = null;
      this.apiKey = null;
      return false;
    }
  }

  /**
   * Start Device Flow authentication with browser auto-open and progress notification.
   *
   * Uses the SDK's DeviceFlow class directly rather than HeadsDownClient.authenticate()
   * so we can store the API key in VS Code's SecretStorage instead of on disk.
   */
  async signIn(): Promise<boolean> {
    this.abortController = new AbortController();
    const baseUrl = this.getBaseUrl();

    try {
      const apiKey = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "HeadsDown",
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            this.abortController?.abort();
          });

          progress.report({ message: "Starting authentication..." });

          const flow = new DeviceFlow({ baseUrl });
          const auth: DeviceAuthorization = await flow.start("headsdown-vscode");

          // Open browser for approval
          const uri = vscode.Uri.parse(auth.verificationUriComplete);
          await vscode.env.openExternal(uri);

          progress.report({
            message: `Waiting for authorization...\n\nA browser window has opened. Approve the request to connect HeadsDown.\n\nIf the browser didn't open, visit:\n${auth.verificationUri} and enter code: ${auth.userCode}`,
          });

          // Poll for approval, returns the raw API key
          return flow.poll(
            auth.deviceCode,
            auth.interval,
            auth.expiresIn,
            this.abortController!.signal,
          );
        },
      );

      if (!apiKey) {
        return false;
      }

      // Store API key in VS Code's SecretStorage
      await this.secretStorage.store(AuthManager.SECRET_KEY, apiKey);

      // Create authenticated client
      this.client = new HeadsDownClient({ apiKey, baseUrl });
      this.profile = await this.client.getProfile();
      this.apiKey = apiKey;

      this.logger.log(`Authenticated as ${this.profile.name ?? "unknown"} (${this.profile.email})`);
      vscode.window.showInformationMessage(
        `HeadsDown: Signed in as ${this.profile.name ?? this.profile.email}`,
      );

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("cancelled")) {
        this.logger.log("Authentication cancelled by user.");
        return false;
      }

      this.logger.log(`Authentication failed: ${message}`);

      const action = await vscode.window.showErrorMessage(
        `HeadsDown: Authentication failed. ${message}`,
        "Try Again",
      );

      if (action === "Try Again") {
        return this.signIn();
      }

      return false;
    } finally {
      this.abortController = null;
    }
  }

  /** Sign out: clear credentials and reset state. */
  async signOut(): Promise<void> {
    await this.secretStorage.delete(AuthManager.SECRET_KEY);
    this.client = null;
    this.profile = null;
    this.apiKey = null;
    this.logger.log("Signed out.");
    vscode.window.showInformationMessage("HeadsDown: Signed out.");
  }

  /** Get the authenticated API client. Returns null if not authenticated. */
  getClient(): HeadsDownClient | null {
    return this.client;
  }

  /** Get the authenticated user's profile. Returns null if not authenticated. */
  getProfile(): UserProfile | null {
    return this.profile;
  }

  /** Get the active API key token for GraphQL WebSocket auth. */
  getApiKey(): string | null {
    return this.apiKey;
  }

  /** Whether the user is currently authenticated. */
  isAuthenticated(): boolean {
    return this.client !== null;
  }
}
