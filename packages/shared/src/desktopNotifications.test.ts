import { describe, expect, it } from "@effect/vitest";

import type { DesktopNotificationSettings, EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { AgentAwarenessPhase, AgentAwarenessState } from "./agentAwareness.ts";
import { resolveDesktopNotification } from "./desktopNotifications.ts";

const NOW = "2026-05-22T12:00:00.000Z";

function awareness(
  phase: AgentAwarenessPhase,
  overrides: Partial<AgentAwarenessState> = {},
): AgentAwarenessState {
  return {
    environmentId: "env-1" as EnvironmentId,
    threadId: "thread-1" as ThreadId,
    projectTitle: "t3code",
    threadTitle: "Fix failing CI",
    phase,
    headline: `headline:${phase}`,
    modelTitle: "gpt-5.4",
    updatedAt: NOW,
    deepLink: "/threads/env-1/thread-1",
    ...overrides,
  };
}

function settings(
  overrides: Partial<DesktopNotificationSettings> = {},
): DesktopNotificationSettings {
  return {
    enabled: true,
    approvalNeeded: true,
    inputNeeded: true,
    finished: true,
    failed: true,
    ...overrides,
  };
}

const WATCHED: ReadonlyArray<[AgentAwarenessPhase, keyof DesktopNotificationSettings]> = [
  ["waiting_for_approval", "approvalNeeded"],
  ["waiting_for_input", "inputNeeded"],
  ["completed", "finished"],
  ["failed", "failed"],
];

const UNWATCHED: ReadonlyArray<AgentAwarenessPhase> = ["starting", "running", "stale"];

describe("resolveDesktopNotification", () => {
  for (const [phase, toggle] of WATCHED) {
    it(`fires on a transition into ${phase} when unfocused and ${toggle} is on`, () => {
      const intent = resolveDesktopNotification({
        previousPhase: "running",
        current: awareness(phase),
        windowFocused: false,
        settings: settings(),
      });
      expect(intent).toEqual({
        environmentId: "env-1",
        threadId: "thread-1",
        title: `headline:${phase}`,
        body: "Fix failing CI · t3code",
      });
    });

    it(`does not fire on a transition into ${phase} when the window is focused`, () => {
      expect(
        resolveDesktopNotification({
          previousPhase: "running",
          current: awareness(phase),
          windowFocused: true,
          settings: settings(),
        }),
      ).toBeNull();
    });

    it(`does not fire into ${phase} when its ${toggle} toggle is off`, () => {
      expect(
        resolveDesktopNotification({
          previousPhase: "running",
          current: awareness(phase),
          windowFocused: false,
          settings: settings({ [toggle]: false }),
        }),
      ).toBeNull();
    });

    it(`does not fire into ${phase} when the master switch is off`, () => {
      expect(
        resolveDesktopNotification({
          previousPhase: "running",
          current: awareness(phase),
          windowFocused: false,
          settings: settings({ enabled: false }),
        }),
      ).toBeNull();
    });

    it(`does not fire while ${phase} persists (no transition)`, () => {
      expect(
        resolveDesktopNotification({
          previousPhase: phase,
          current: awareness(phase),
          windowFocused: false,
          settings: settings(),
        }),
      ).toBeNull();
    });

    it(`seeds silently on first observation of ${phase} (null previous phase)`, () => {
      expect(
        resolveDesktopNotification({
          previousPhase: null,
          current: awareness(phase),
          windowFocused: false,
          settings: settings(),
        }),
      ).toBeNull();
    });
  }

  for (const phase of UNWATCHED) {
    it(`never fires for the non-watched phase ${phase}`, () => {
      expect(
        resolveDesktopNotification({
          previousPhase: "running",
          current: awareness(phase),
          windowFocused: false,
          settings: settings(),
        }),
      ).toBeNull();
    });
  }

  it("returns null when there is no current awareness state", () => {
    expect(
      resolveDesktopNotification({
        previousPhase: "running",
        current: null,
        windowFocused: false,
        settings: settings(),
      }),
    ).toBeNull();
  });

  it("falls back to the project title when the thread has no title", () => {
    const intent = resolveDesktopNotification({
      previousPhase: "running",
      current: awareness("completed", { threadTitle: "   " }),
      windowFocused: false,
      settings: settings(),
    });
    expect(intent?.body).toBe("t3code");
  });
});
