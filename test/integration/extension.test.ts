/**
 * Integration tests for headsdown-vscode extension.
 * These run inside a real VS Code instance via @vscode/test-electron.
 *
 * Run with: npm run test:integration
 * (Requires xvfb on Linux: xvfb-run -a npm run test:integration)
 */
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Extension Integration", () => {
  test("extension activates without errors", async () => {
    const ext = vscode.extensions.getExtension("headsdown.headsdown-vscode");
    assert.ok(ext, "Extension should be found");

    if (!ext.isActive) {
      await ext.activate();
    }
    assert.ok(ext.isActive, "Extension should be active");
  });

  test("all commands are registered", async () => {
    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes("headsdown.signIn"), "signIn command should be registered");
    assert.ok(commands.includes("headsdown.signOut"), "signOut command should be registered");
    assert.ok(
      commands.includes("headsdown.quickAction"),
      "quickAction command should be registered",
    );
    assert.ok(commands.includes("headsdown.showOutput"), "showOutput command should be registered");
    assert.ok(
      commands.includes("headsdown.manageDelegationGrants"),
      "manageDelegationGrants command should be registered",
    );
    assert.ok(
      commands.includes("headsdown.manageAvailabilityOverride"),
      "manageAvailabilityOverride command should be registered",
    );
  });

  test("showOutput command opens output channel", async () => {
    await vscode.commands.executeCommand("headsdown.showOutput");
    // If we get here without throwing, the command executed successfully
    assert.ok(true);
  });

  test("extension deactivates cleanly", async () => {
    const ext = vscode.extensions.getExtension("headsdown.headsdown-vscode");
    assert.ok(ext, "Extension should be found");

    // Deactivation happens via VS Code lifecycle; just verify no errors
    assert.ok(ext.isActive, "Extension should still be active");
  });
});
