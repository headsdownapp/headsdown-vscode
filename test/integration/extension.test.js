const assert = require("node:assert");
const vscode = require("vscode");

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
    assert.ok(commands.includes("headsdown.quickAction"), "quickAction command should be registered");
    assert.ok(commands.includes("headsdown.showOutput"), "showOutput command should be registered");
    assert.ok(
      commands.includes("headsdown.manageDelegationGrants"),
      "manageDelegationGrants command should be registered",
    );
    assert.ok(
      commands.includes("headsdown.manageAvailabilityOverride"),
      "manageAvailabilityOverride command should be registered",
    );
    assert.ok(commands.includes("headsdown.openControlCenter"), "openControlCenter should be registered");
    assert.ok(commands.includes("headsdown.copyStatusSnapshot"), "copyStatusSnapshot should be registered");
    assert.ok(commands.includes("headsdown.bootstrapAgentFiles"), "bootstrapAgentFiles should be registered");
  });

  test("commands execute without errors", async () => {
    await vscode.commands.executeCommand("headsdown.showOutput");
    await vscode.commands.executeCommand("headsdown.openControlCenter");
    await vscode.commands.executeCommand("headsdown.copyStatusSnapshot");
    assert.ok(true);
  });
});
