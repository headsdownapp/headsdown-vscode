# HeadsDown for VS Code

Focus mode awareness for VS Code and Cursor. Shows your availability status in the status bar, protects deep work, and gives AI agents awareness of your focus mode.

## Features

- **Status bar indicator** showing your current availability mode, status text, and time remaining
- **Device Flow authentication** with one-click browser sign-in
- **Local coding timer** that works before you sign in, so you see value immediately
- **Real-time subscriptions** with polling fallback to keep your status in sync across tools
- **Sync transport visibility** in tooltip, so you can see Realtime vs Polling fallback
- **AI agent awareness** so tools like Cursor, Copilot, and Claude Code can respect your focus time
- **Delegation grant controls** to list/create/revoke actor-scoped permissions
- **Temporary override controls** to set/view/clear one-off availability overrides

## Getting Started

1. Install the extension from the VS Code Marketplace
2. You'll see a `$(shield) HeadsDown` indicator in your status bar right away
3. Start coding, and the extension tracks your session locally
4. When you're ready, click the status bar item and sign in to sync your availability across all your tools

## Install from GitHub

### Option 1: Install a release `.vsix` from GitHub

1. Open the [GitHub Releases page](https://github.com/headsdownapp/headsdown-vscode/releases)
2. Download the latest `.vsix` asset
3. In VS Code or Cursor, open the Extensions view, click the `...` menu, and select **Install from VSIX...**
4. Pick the downloaded `.vsix` file

CLI alternative:

```bash
code --install-extension headsdown-vscode-<version>.vsix
```

### Option 2: Build and install from source

```bash
git clone https://github.com/headsdownapp/headsdown-vscode.git
cd headsdown-vscode
npm install
npm run package
code --install-extension headsdown-vscode-*.vsix
```

## Status Bar States

### Authenticated

| State | Example |
|-------|---------|
| Online | `● Online` |
| Online with status | `● Online · ☕ Taking a break` |
| Focused with timer | `● Focused · 47m` |
| Focused, locked | `●🔒 Focused · 47m` |
| Away | `● Away · 22m` |
| Offline | `○ Offline` |
| No contract | `● HeadsDown` |
| API unreachable | `☁ HeadsDown` |

### Unauthenticated

| State | Example |
|-------|---------|
| No activity | `🛡 HeadsDown` |
| Coding detected | `🛡 HeadsDown · coding 23m` |

## Settings

All settings are available in VS Code's Settings UI under "HeadsDown":

| Setting | Default | Description |
|---------|---------|-------------|
| `headsdown.trustLevel` | `advisory` | How aggressively HeadsDown gates AI agent file writes |
| `headsdown.sensitivePaths` | `[]` | Additional glob patterns for files that always require confirmation |
| `headsdown.notifications.enabled` | `true` | Show notifications for expiring focus blocks |
| `headsdown.notifications.expiryWarningMinutes` | `5` | Minutes before expiry to warn |
| `headsdown.statusBar.showTimeRemaining` | `true` | Show countdown timer in status bar |
| `headsdown.polling.intervalSeconds` | `300` | API polling interval (60-900 seconds) |
| `headsdown.autoDetect.enabled` | `true` | Detect sustained coding and offer to set status |
| `headsdown.autoDetect.thresholdMinutes` | `20` | Minutes of coding before prompting |
| `headsdown.api.baseUrl` | `https://headsdown.app` | API base URL (for self-hosted or dev) |
| `headsdown.experimental.enablePromptResources` | `false` | Enable experimental prompt resource scaffolding commands |

Settings also fall back to `~/.config/headsdown/config.json` when VS Code settings are at their defaults. This shared config file is used by the HeadsDown CLI and SDK, so settings stay consistent across tools.

## Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| `HeadsDown: Sign In` | | Authenticate via Device Flow |
| `HeadsDown: Sign Out` | | Clear credentials |
| `HeadsDown: Quick Actions` | `Cmd+Shift+H` / `Ctrl+Shift+H` | Open the quick action menu |
| `HeadsDown: Show Logs` | | Show the output channel |
| `HeadsDown: Manage Delegation Grants` | | List/create/revoke delegation grants |
| `HeadsDown: Manage Temporary Override` | | View/set/clear temporary availability override |
| `HeadsDown: Open Control Center` | | Open a focused status, policy, and actions dashboard |
| `HeadsDown: Copy Status Snapshot` | | Copy current mode, timing, and wrap-up context as JSON |
| `HeadsDown: Bootstrap Agent Files` | | Scaffold Cursor, Claude, and Copilot integration files |
| `HeadsDown: Generate Prompt Resources (Experimental)` | | Generate `.github/prompts` HeadsDown prompt templates |

## Cursor Integration

If you use [Cursor](https://cursor.sh), add this rule file so the AI agent checks your availability before starting work.

Automated setup (macOS/Linux):

```bash
mkdir -p .cursor/rules
curl -fsSL https://raw.githubusercontent.com/headsdownapp/headsdown-vscode/main/templates/cursor/headsdown.mdc -o .cursor/rules/headsdown.mdc
```

Automated setup (PowerShell):

```powershell
New-Item -ItemType Directory -Force .cursor/rules | Out-Null
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/headsdownapp/headsdown-vscode/main/templates/cursor/headsdown.mdc" -OutFile ".cursor/rules/headsdown.mdc"
```

If you cloned this repo locally, you can also copy the file directly:

```bash
mkdir -p .cursor/rules
cp templates/cursor/headsdown.mdc .cursor/rules/headsdown.mdc
```

Rule file source: `templates/cursor/headsdown.mdc`

This template is updated for modern Cursor workflows (Cursor 3 agent workspace + CLI usage), including guidance for proposal verdict handling, wrap-up behavior, optional canvas summaries, and CLI commands like `/debug` and `/btw` when running in terminal mode.

## Agent Workflow Bootstrap

Use `HeadsDown: Bootstrap Agent Files` to scaffold:

- `.cursor/rules/headsdown.mdc`
- `.claude/HEADSDOWN.md`
- `.github/copilot-instructions.md`
- `.vscode/headsdown-hooks.sample.json`

Use `HeadsDown: Copy Status Snapshot` to share a structured JSON snapshot with any agent flow.

For experimental prompt-resource scaffolding, enable `headsdown.experimental.enablePromptResources` and run `HeadsDown: Generate Prompt Resources (Experimental)`.

## Bundling and Runtime Dependencies

The extension is bundled into a single CommonJS file at `dist/extension.js` using esbuild.

- `vscode` stays external because the VS Code extension host provides it at runtime.
- `@headsdown/sdk` is a build-time dependency and is inlined into the bundle, so the published extension does not need it installed as a separate runtime package.

Build command:

```bash
esbuild src/extension.ts --bundle --platform=node --format=cjs --outfile=dist/extension.js --external:vscode
```

## Release Automation (Maintainers)

This repo uses [Release Please](https://github.com/googleapis/release-please) to automate releases.

- Merges to `main` create or update a release PR with version bumps and changelog entries
- Merging the release PR creates the Git tag and GitHub release
- Publishing then runs automatically and:
  - builds, tests, and lints
  - packages a `.vsix`
  - uploads the `.vsix` to the GitHub release
  - publishes to VS Marketplace and Open VSX

Required repository secrets:

- `VSCE_PAT`: Visual Studio Marketplace Personal Access Token
- `OVSX_PAT`: Open VSX Personal Access Token

Tip: use conventional commit prefixes (`feat:`, `fix:`, `chore:`) so release notes and semantic versioning stay clean.

## Dependency update automation

This repo uses Renovate to keep `@headsdown/sdk` and other routine dependencies current. New SDK releases open bot PRs automatically, and eligible updates can automerge after required CI checks pass. In normal maintenance flow, do not manually edit `@headsdown/sdk` versions unless you are intentionally overriding Renovate behavior.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run watch

# Run unit tests
npm run test:unit

# Run integration tests (requires VS Code)
npm run test:integration

# Package as .vsix
npm run package
```

## License

MIT
