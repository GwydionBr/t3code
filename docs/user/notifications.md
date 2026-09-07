# Desktop notifications

The desktop app can raise a native OS notification when a thread needs you and
the T3 Code window is in the background, so you can step away from a running
agent without watching the window. Clicking a notification brings T3 Code to the
front and opens the thread that raised it.

Notifications only fire while the window is **unfocused** — you are never
interrupted about a thread you are already looking at.

## Turning it on

Settings → General → Notifications. A master switch enables the feature, and
four moments can be toggled independently:

- **Approval needed** — an agent is blocked waiting for you to approve an action.
- **Input needed** — an agent is waiting for your input to continue.
- **Agent finished** — a turn completed. Off by default, as the noisiest moment.
- **Agent failed** — an agent run or its provider failed.

By default the master switch and every moment except **Agent finished** are on.
Turn the master switch off to silence everything without losing your per-moment
choices.

## Notes

- Desktop only. The web app and mobile handle notifications separately (mobile
  has its own push notifications).
- Preferences are stored on this machine and are not synced to other devices, so
  each desktop install can be tuned on its own.
- Works fully locally — no account or cloud connection is required. If you are
  connected to a remote host, you are notified on the machine you are working at,
  not on the host.
