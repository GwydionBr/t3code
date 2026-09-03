import { describe, expect, it } from "vite-plus/test";

import {
  groupActiveThreadsByBranch,
  planPinnedMove,
  resolveSettledThreadTimestamp,
  sortActiveThreadsByBranch,
  sortPinnedThreadsByOrderKey,
  sortThreads,
  type ThreadSortInput,
} from "./threadSort.ts";

type TestThread = { readonly id: string } & ThreadSortInput;

function makeThread(overrides: Partial<TestThread> = {}): TestThread {
  return {
    id: "thread-1",
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    messages: [],
    latestUserMessageAt: null,
    ...overrides,
  };
}

describe("resolveSettledThreadTimestamp", () => {
  it("prefers the persisted settlement stamp over later activity", () => {
    expect(
      resolveSettledThreadTimestamp({
        settledAt: "2026-03-09T10:00:00.000Z",
        latestUserMessageAt: "2026-03-09T11:00:00.000Z",
        latestTurn: null,
        updatedAt: "2026-03-09T12:00:00.000Z",
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("falls back to the latest activity when the stamp is missing or malformed", () => {
    expect(
      resolveSettledThreadTimestamp({
        settledAt: "invalid",
        latestUserMessageAt: "2026-03-09T11:00:00.000Z",
        latestTurn: null,
        updatedAt: "2026-03-09T12:00:00.000Z",
      }),
    ).toBe("2026-03-09T11:00:00.000Z");
    expect(
      resolveSettledThreadTimestamp({
        settledAt: null,
        latestUserMessageAt: null,
        latestTurn: null,
        updatedAt: "2026-03-09T12:00:00.000Z",
      }),
    ).toBe("2026-03-09T12:00:00.000Z");
  });
});

describe("sortThreads", () => {
  it("falls back to updatedAt and createdAt when latestUserMessageAt is invalid and there are no messages", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: "thread-1",
          latestUserMessageAt: "not-a-date",
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
        makeThread({
          id: "thread-2",
          latestUserMessageAt: "still-not-a-date",
          createdAt: "invalid-created-at",
          updatedAt: "invalid-updated-at",
        }),
        makeThread({
          id: "thread-3",
          latestUserMessageAt: "invalid-latest-user-message-at",
          createdAt: "2026-03-09T10:06:00.000Z",
          updatedAt: "invalid-updated-at",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual(["thread-3", "thread-1", "thread-2"]);
  });

  it("falls back to the latest valid user message when latestUserMessageAt is invalid", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: "thread-1",
          latestUserMessageAt: "invalid-latest-user-message-at",
          updatedAt: "2026-03-09T10:00:00.000Z",
          messages: [
            { role: "user", createdAt: "2026-03-09T10:05:00.000Z" },
            { role: "assistant", createdAt: "2026-03-09T10:30:00.000Z" },
            { role: "user", createdAt: "2026-03-09T10:20:00.000Z" },
          ],
        }),
        makeThread({
          id: "thread-2",
          createdAt: "2026-03-09T10:15:00.000Z",
          updatedAt: "2026-03-09T10:15:00.000Z",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual(["thread-1", "thread-2"]);
  });
});

describe("planPinnedMove", () => {
  it("moves a thread up with a single key write", () => {
    const assignments = planPinnedMove({
      orderedIds: ["a", "b", "c"],
      keysById: new Map([
        ["a", "f"],
        ["b", "m"],
        ["c", "t"],
      ]),
      movedId: "c",
      direction: "up",
    });
    expect(assignments).toHaveLength(1);
    expect(assignments![0]!.id).toBe("c");
    expect(assignments![0]!.orderKey > "f" && assignments![0]!.orderKey < "m").toBe(true);
  });

  it("returns null when the move falls off the end of the list", () => {
    const input = {
      orderedIds: ["a", "b"],
      keysById: new Map([
        ["a", "f"],
        ["b", "m"],
      ]),
    };
    expect(planPinnedMove({ ...input, movedId: "a", direction: "up" })).toBeNull();
    expect(planPinnedMove({ ...input, movedId: "b", direction: "down" })).toBeNull();
  });

  it("materializes keys for the whole section when a neighbor is keyless", () => {
    const assignments = planPinnedMove({
      orderedIds: ["a", "b", "c"],
      keysById: new Map([
        ["a", null],
        ["b", "m"],
        ["c", null],
      ]),
      movedId: "b",
      direction: "up",
    });
    expect(assignments).not.toBeNull();
    const keys = assignments!.map((entry) => entry.orderKey);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe("groupActiveThreadsByBranch", () => {
  type BranchThread = {
    readonly id: string;
    readonly environmentId: string;
    readonly projectId: string;
    readonly branch: string | null;
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
  };

  function makeBranchThread(overrides: Partial<BranchThread> = {}): BranchThread {
    return {
      id: "thread-1",
      environmentId: "env-1",
      projectId: "project-1",
      branch: "main",
      createdAt: "2026-03-09T10:00:00.000Z",
      ...overrides,
    };
  }

  it("keeps identical branch names independent across environments and projects", () => {
    const groups = groupActiveThreadsByBranch([
      makeBranchThread({
        id: "a",
        environmentId: "env-1",
        projectId: "project-1",
        branch: "feature",
        createdAt: "2026-03-09T10:00:00.000Z",
      }),
      makeBranchThread({
        id: "b",
        environmentId: "env-1",
        projectId: "project-2",
        branch: "feature",
        createdAt: "2026-03-09T10:01:00.000Z",
      }),
      makeBranchThread({
        id: "c",
        environmentId: "env-2",
        projectId: "project-1",
        branch: "feature",
        createdAt: "2026-03-09T10:02:00.000Z",
      }),
    ]);

    // Same branch name, but each environment/project pair is its own group.
    expect(groups).toHaveLength(3);
    for (const group of groups) {
      expect(group.branch).toBe("feature");
      expect(group.threads).toHaveLength(1);
    }
  });

  it("merges threads sharing an environment, project, and branch into one group, newest first", () => {
    const groups = groupActiveThreadsByBranch([
      makeBranchThread({ id: "older", branch: "feature", createdAt: "2026-03-09T10:00:00.000Z" }),
      makeBranchThread({ id: "newer", branch: "feature", createdAt: "2026-03-09T11:00:00.000Z" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.threads.map((thread) => thread.id)).toEqual(["newer", "older"]);
  });

  it("keeps branchless threads independent instead of forming a shared group", () => {
    const groups = groupActiveThreadsByBranch([
      makeBranchThread({ id: "a", branch: null }),
      makeBranchThread({ id: "b", branch: null }),
    ]);

    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group.branch).toBeNull();
      expect(group.threads).toHaveLength(1);
    }
  });

  it("orders groups by their newest thread and keeps grouped rows contiguous", () => {
    const flattened = sortActiveThreadsByBranch([
      makeBranchThread({
        id: "feat-old",
        branch: "feature",
        createdAt: "2026-03-09T10:00:00.000Z",
      }),
      makeBranchThread({ id: "solo", branch: null, createdAt: "2026-03-09T10:30:00.000Z" }),
      makeBranchThread({
        id: "feat-new",
        branch: "feature",
        createdAt: "2026-03-09T11:00:00.000Z",
      }),
    ]);

    // The feature group anchors to feat-new (newest), so both feature rows lead
    // and stay contiguous ahead of the older branchless thread.
    expect(flattened.map((thread) => thread.id)).toEqual(["feat-new", "feat-old", "solo"]);
  });
});

describe("sortPinnedThreadsByOrderKey", () => {
  it("breaks equal keys by id THEN environment so merged lists are stable everywhere", () => {
    const sorted = sortPinnedThreadsByOrderKey([
      {
        id: "thread-1",
        createdAt: "2026-03-09T10:00:00.000Z",
        pinOrderKey: "m",
        environmentId: "env-b",
      },
      {
        id: "thread-1",
        createdAt: "2026-03-09T11:00:00.000Z",
        pinOrderKey: "m",
        environmentId: "env-a",
      },
    ]);
    expect(sorted.map((thread) => thread.environmentId)).toEqual(["env-a", "env-b"]);
  });
});
