# HeadsDown Integration

Use HeadsDown context to shape task scope and depth.

## Core workflow

1. Call `headsdown_status` before non-trivial work.
2. For non-trivial tasks, call `headsdown_propose` with scope and estimate.
3. Follow verdict strictly:
   - `APPROVED`: proceed with approved scope.
   - `DEFERRED`: pause or reduce scope and ask before continuing.
4. If task was approved through `headsdown_propose`, call `headsdown_report` when done.

## Mode behavior

- `online`: proceed normally.
- `busy`: keep edits tightly scoped.
- `limited`: reduce scope and prefer one-file slices.
- `offline`: avoid non-urgent work unless explicitly requested.

## Wrap-Up guidance

If `wrapUpGuidance.active` is true, follow execution policy for `selectedMode` (`wrap_up`, `full_depth`, `auto`) and incorporate `remainingMinutes`, `reason`, and `hints`.
