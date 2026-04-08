# HeadsDown for VS Code

Focus mode awareness for VS Code and Cursor. Shows your availability status in the status bar, protects deep work, and gives AI agents awareness of your focus mode.

## Features

- **Status bar indicator** showing your current availability mode, status text, and time remaining
- **Device Flow authentication** with one-click browser sign-in
- **Local coding timer** that works before you sign in, so you see value immediately
- **Real-time subscriptions** with polling fallback to keep your status in sync across tools
- **Sync transport visibility** in tooltip, so you can see Realtime vs Polling fallback
- **AI agent awareness** so tools like Cursor, Copilot, and Claude Code can respect your focus time

## Getting Started

1. Install the extension from the VS Code Marketplace
2. You'll see a `$(shield) HeadsDown` indicator in your status bar right away
3. Start coding, and the extension tracks your session locally
4. When you're ready, click the status bar item and sign in to sync your availability across all your tools

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

Settings also fall back to `~/.config/headsdown/config.json` when VS Code settings are at their defaults. This shared config file is used by the HeadsDown CLI and SDK, so settings stay consistent across tools.

## Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| `HeadsDown: Sign In` | | Authenticate via Device Flow |
| `HeadsDown: Sign Out` | | Clear credentials |
| `HeadsDown: Quick Actions` | `Cmd+Shift+H` / `Ctrl+Shift+H` | Open the quick action menu |
| `HeadsDown: Show Logs` | | Show the output channel |

## Cursor Integration

If you use [Cursor](https://cursor.sh), add this rule file so the AI agent checks your availability before starting work:

Create `.cursor/rules/headsdown.mdc`:

```markdown
---
description: Check user availability before starting work via HeadsDown
globs:
alwaysApply: true
---

Before starting any multi-file change or task that takes more than a few minutes:

1. If you have access to the `headsdown_status` tool, call it first
2. If `headsdown_propose` is available, submit a proposal for non-trivial work and follow the verdict
3. If no HeadsDown tools are available, check the status bar indicator

Mode behavior:
- **online**: Proceed normally
- **busy** (focused): Deep focus. Prefer small, focused changes. Ask before large refactors.
- **limited** (away): Reduce scope. One file at a time.
- **offline**: User is away. Only make changes if explicitly asked.

If status shows locked, do not attempt to work around it.
```

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
