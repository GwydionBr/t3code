import type { DesktopNotificationIntent, DesktopNotificationSettings } from "@t3tools/contracts";

import type { AgentAwarenessPhase, AgentAwarenessState } from "./agentAwareness.ts";

export type { DesktopNotificationIntent };

// The four agent-awareness phases that surface as a user-facing notification,
// each mapped to the per-moment toggle that governs it. Phases absent here
// (`starting`, `running`, `stale`) never notify.
const WATCHED_PHASE_TOGGLE = {
  waiting_for_approval: "approvalNeeded",
  waiting_for_input: "inputNeeded",
  completed: "finished",
  failed: "failed",
} as const satisfies Partial<Record<AgentAwarenessPhase, keyof DesktopNotificationSettings>>;

export interface DesktopNotificationDecisionInput {
  /** The phase last observed for this thread, or null if never observed. */
  readonly previousPhase: AgentAwarenessPhase | null;
  /** The thread's current awareness state (from `projectThreadAwareness`). */
  readonly current: AgentAwarenessState | null;
  /** Whether the desktop window currently has OS focus. */
  readonly windowFocused: boolean;
  readonly settings: DesktopNotificationSettings;
}

/**
 * Decide whether an agent moment should raise a native desktop notification.
 * This is the sole behavior seam for the feature: it fires only on a transition
 * *into* a watched phase, only while the window is unfocused, and only when both
 * the master switch and that phase's toggle are on. Everything around it (the
 * observer, IPC, and Electron `Notification`) is thin glue.
 *
 * A `null` previousPhase means this is the first time the thread has been
 * observed — typically the initial hydration of threads that were already in a
 * watched phase before the client loaded — so it seeds silently rather than
 * announcing moments that happened while nobody was watching.
 */
export function resolveDesktopNotification(
  input: DesktopNotificationDecisionInput,
): DesktopNotificationIntent | null {
  const { previousPhase, current, windowFocused, settings } = input;

  // Do not interrupt the user about something already in front of them.
  if (windowFocused) return null;
  // Master switch.
  if (!settings.enabled) return null;
  // No active awareness state (idle thread) — nothing to announce.
  if (current === null) return null;

  const toggle = watchedToggleForPhase(current.phase);
  if (toggle === null) return null;
  // Fire once, on the transition into the watched phase — not while it persists,
  // and not on first observation (see the seeding note above).
  if (previousPhase === null || previousPhase === current.phase) return null;
  // Per-moment toggle.
  if (!settings[toggle]) return null;

  return {
    environmentId: current.environmentId,
    threadId: current.threadId,
    title: current.headline,
    body: buildBody(current),
  };
}

function watchedToggleForPhase(
  phase: AgentAwarenessPhase,
): (typeof WATCHED_PHASE_TOGGLE)[keyof typeof WATCHED_PHASE_TOGGLE] | null {
  return phase in WATCHED_PHASE_TOGGLE
    ? WATCHED_PHASE_TOGGLE[phase as keyof typeof WATCHED_PHASE_TOGGLE]
    : null;
}

// The title carries the phase headline; the body names which thread and project
// need attention so a user with several environments open can decide before
// switching context.
function buildBody(current: AgentAwarenessState): string {
  const threadTitle = current.threadTitle.trim();
  if (threadTitle.length === 0) return current.projectTitle;
  return `${threadTitle} · ${current.projectTitle}`;
}
