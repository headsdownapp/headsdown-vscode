## HeadsDown Integration

Before starting non-trivial work:

1. Call `headsdown_status` when available.
2. Call `headsdown_propose` for multi-file or risky tasks.
3. Respect verdicts exactly:
   - `APPROVED`: continue.
   - `DEFERRED`: stop or shrink scope and confirm with user.
4. If work started via an approved proposal, call `headsdown_report` at completion.

Mode expectations:
- `online`: normal pace.
- `busy`: narrow scope, minimize interruptions.
- `limited`: smaller slices.
- `offline`: no non-urgent work unless asked.
