import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import * as React from "react";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { defaultAnimateLayoutChanges, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import type { ContextMenuItem, EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import type { AsyncResult } from "effect/unstable/reactivity";
import {
  planContiguousBlockReorder,
  planPinnedReorder,
} from "@t3tools/client-runtime/state/thread-sort";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  sortActiveThreadsByBranch,
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";
import { cn } from "../lib/utils";
import { isLatestRunSettled } from "../session-logic";
import { resolveServerBackedAppStageLabel } from "../branding.logic";

export function shouldNavigateAfterThreadPark(input: {
  readonly threadKey: string;
  readonly currentThreadKey: string | null;
  readonly action: "settle" | "snooze";
  readonly now: string;
  readonly thread: (ThreadSnoozeShell & Pick<SidebarThreadSummary, "settledOverride">) | null;
}): boolean {
  return (
    input.threadKey === input.currentThreadKey &&
    input.thread !== null &&
    (input.action === "settle"
      ? input.thread.settledOverride === "settled"
      : effectiveSnoozed(input.thread, { now: input.now }))
  );
}

const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 200;

export function resolveSidebarRowAccessibility(input: {
  readonly title: string;
  readonly statusLabel: string | null;
  readonly projectDisplayName: string | null;
  readonly isActive: boolean;
}): { readonly label: string; readonly current: "page" | undefined } {
  return {
    // The title is the row's identity and must lead when users scan tasks.
    // Only static context belongs here; nested action labels remain separate controls.
    label: [input.title, input.statusLabel, input.projectDisplayName].filter(Boolean).join(", "),
    current: input.isActive ? "page" : undefined,
  };
}

// Visible sidebar rows are prewarmed into the thread-detail cache so opening a
// nearby thread usually reuses an already-hot subscription. Each prewarmed
// thread holds a live, fully hydrated detail subscription (all messages and
// activities, growing as agents work) for as long as the row stays visible,
// so this limit is a direct renderer-heap and server-load multiplier — keep
// it small; cold opens still render instantly from the cached snapshot.
const SIDEBAR_THREAD_PREWARM_LIMIT = 3;
// A small buffer keeps the next few rows warm without leasing every row that
// content-visibility leaves mounted below the scroll viewport.
const SIDEBAR_ROW_SUBSCRIPTION_OVERSCAN_PX = 160;

export function useSidebarRowSubscriptionLease(isActive: boolean): {
  readonly leaseLiveStatus: boolean;
  readonly rowRef: React.Dispatch<React.SetStateAction<HTMLElement | null>>;
} {
  const [row, setRow] = React.useState<HTMLElement | null>(null);
  const [isNearViewport, setIsNearViewport] = React.useState(isActive);

  React.useEffect(() => {
    if (isActive) {
      setIsNearViewport(true);
      return;
    }
    if (row === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setIsNearViewport(true);
      return;
    }

    const scrollRoot = row.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const observer = new IntersectionObserver(
      ([entry]) => setIsNearViewport(entry?.isIntersecting === true),
      {
        root: scrollRoot,
        rootMargin: `${SIDEBAR_ROW_SUBSCRIPTION_OVERSCAN_PX}px 0px`,
      },
    );
    observer.observe(row);
    return () => observer.disconnect();
  }, [isActive, row]);

  return {
    leaseLiveStatus: isActive || isNearViewport,
    rowRef: setRow,
  };
}

// A row keeps the last live value it rendered so a released lease never
// blanks its badge. The value is bound to `key`, so a different worktree or
// linked pull request cannot reuse the previous one.
export function useRetainedValue<T>(key: string | null, value: T | null): T | null {
  const retained = React.useRef<{ readonly key: string; readonly value: T } | null>(null);
  if (key !== null && value !== null) {
    retained.current = { key, value };
  }
  if (value !== null) return value;
  return key !== null && retained.current?.key === key ? retained.current.value : null;
}

// Sidebar.motion handles ordinary section changes. Sortable transforms own
// dragging; replaying their committed DOM order would animate the drop twice.
export const animateSidebarLayoutChanges: AnimateLayoutChanges = (args) =>
  args.isSorting ? defaultAnimateLayoutChanges(args) : false;

// Rows and section markers share one sortable list. The separators resolve
// the lifecycle action; Sidebar.drag previews the resulting layout. Pinned
// and active threads keep the dragged position; settled threads use time
// order. Snoozed rows can leave the shelf, but dropping into it is not
// supported because snoozing requires a wake time. The Working shelf (beta)
// follows live status, so it is neither a drag source nor a destination.

export type SidebarSection = "pinned" | "active" | "working" | "snoozed" | "settled";

/** Resolve the shelf a visible thread belongs to. Snooze is temporary and
 * wins until its wake boundary; settlement then wins over a stale pin. */
export function resolveSidebarThreadSection(input: {
  readonly snoozed: boolean;
  readonly settled: boolean;
  readonly pinned: boolean;
}): SidebarSection {
  if (input.snoozed) return "snoozed";
  if (input.settled) return "settled";
  if (input.pinned) return "pinned";
  return "active";
}

/** Sortable ids: thread rows use their scoped key; structural items use a
    colon-free prefix: scoped thread keys always contain a colon. */
const SIDEBAR_MARKER_PREFIX = "sidebar-marker-";

export type SidebarListMarker =
  /** The top boundary is also a landing target when there are no pins. */
  | "pinned-header"
  /** Stand-in rows so an empty section has somewhere for the gap to open. */
  | "active-placeholder"
  | "settled-placeholder"
  /** The boundary between pinned and active rows. */
  | "pinned-divider"
  | "working-header"
  | "snoozed-header"
  | "settled-header";

export function sidebarMarkerId(marker: SidebarListMarker): string {
  return `${SIDEBAR_MARKER_PREFIX}${marker}`;
}

/** Prefix for branch-group header slots. Colon-free like the marker prefix so
    it never collides with a scoped thread key (those always contain a colon).
    The group key trailing it is opaque here — nothing parses past the prefix. */
const SIDEBAR_BRANCH_HEADER_PREFIX = "sidebar-branch-";

export function sidebarBranchHeaderId(groupKey: string): string {
  return `${SIDEBAR_BRANCH_HEADER_PREFIX}${groupKey}`;
}

/** The group key inside a branch-header sortable id, or null for any other id
    (thread keys, markers). Lets the drag handlers tell a whole-group header
    drag from an ordinary thread-row drag. */
export function parseSidebarBranchHeaderId(id: string): string | null {
  return id.startsWith(SIDEBAR_BRANCH_HEADER_PREFIX)
    ? id.slice(SIDEBAR_BRANCH_HEADER_PREFIX.length)
    : null;
}

export type SidebarListItem =
  | { readonly kind: "thread"; readonly key: string; readonly section: SidebarSection }
  | { readonly kind: "marker"; readonly marker: SidebarListMarker }
  /** A collapsible branch-group header sitting inside the active run. Sortable
      and used as the drag handle for moving the whole group. */
  | { readonly kind: "branch-header"; readonly groupKey: string };

export function sidebarListItemId(item: SidebarListItem): string {
  if (item.kind === "thread") return item.key;
  if (item.kind === "branch-header") return sidebarBranchHeaderId(item.groupKey);
  return sidebarMarkerId(item.marker);
}

/** The section a slot belongs to, read off the markers around it: from
    the top down, everything before the pinned divider is pinned, then the
    inbox until the first shelf header, each shelf until the next header,
    then settled. */
function sectionAtSidebarSlot(items: readonly SidebarListItem[], index: number): SidebarSection {
  let section: SidebarSection = "pinned";
  for (let i = 0; i < index && i < items.length; i += 1) {
    const item = items[i]!;
    if (item.kind !== "marker") continue;
    if (item.marker === "pinned-divider") section = "active";
    else if (item.marker === "working-header") section = "working";
    else if (item.marker === "snoozed-header") section = "snoozed";
    else if (item.marker === "settled-header") section = "settled";
  }
  return section;
}

/** Resolve the destination section and manual order from an arrayMove across
 * the separators. The working and snoozed shelves are never destinations. */
export type SidebarDropTarget = {
  readonly section: "pinned" | "active" | "settled";
  readonly pinnedOrder: readonly string[];
  readonly activeOrder: readonly string[];
};

function sidebarDropTargetFromItems(
  items: readonly SidebarListItem[],
  movedIndex: number,
): SidebarDropTarget | null {
  const section = sectionAtSidebarSlot(items, movedIndex);
  if (section === "working" || section === "snoozed") return null;
  const pinnedOrder: string[] = [];
  const activeOrder: string[] = [];
  let currentSection: SidebarSection = "pinned";
  for (const item of items) {
    if (item.kind === "marker") {
      if (item.marker === "pinned-divider") currentSection = "active";
      else if (
        item.marker === "working-header" ||
        item.marker === "snoozed-header" ||
        item.marker === "settled-header"
      )
        break;
      continue;
    }
    if (item.kind !== "thread") continue;
    if (currentSection === "pinned") pinnedOrder.push(item.key);
    else activeOrder.push(item.key);
  }
  return { section, pinnedOrder, activeOrder };
}

export function resolveSidebarDropTarget(
  items: readonly SidebarListItem[],
  activeKey: string,
  overId: string,
): SidebarDropTarget | null {
  const activeIndex = items.findIndex((item) => sidebarListItemId(item) === activeKey);
  const overIndex = items.findIndex((item) => sidebarListItemId(item) === overId);
  if (activeIndex === -1 || overIndex === -1 || items[activeIndex]?.kind !== "thread") return null;
  const moved = items.filter((_, index) => index !== activeIndex);
  moved.splice(overIndex, 0, items[activeIndex]!);
  return sidebarDropTargetFromItems(moved, overIndex);
}

export type SidebarThreadDropPlan =
  | { readonly kind: "none" }
  /** Within the pinned block: the existing key writes. */
  | {
      readonly kind: "reorder-pinned";
      readonly order: readonly string[];
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  /** From another section into the pinned block. Fresh pins take `orderKey`
      on the pin command. `extraAssignments` land afterward, including the
      moved row when it was already pinned beneath a snooze. */
  | {
      readonly kind: "pin";
      readonly order: readonly string[];
      readonly orderKey: string | undefined;
      readonly extraAssignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  | {
      readonly kind: "move-active";
      /** Null when the inbox is time-ordered: the drop has no placement. */
      readonly order: readonly string[] | null;
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
      readonly unpin: boolean;
      readonly unsettle: boolean;
      readonly unsnooze: boolean;
    }
  | { readonly kind: "settle" };

/** What dropping in `to` does to a thread lifted from `from`, for the badge
    on the lifted row. Null while reordering inside one section and for the
    working and snoozed shelves, which cannot be drop targets. */
export type SidebarDropVerb = "pin" | "unpin" | "settle" | "unsettle" | "wake";

export function resolveSidebarDropVerb(
  from: SidebarSection,
  to: SidebarSection | null,
): SidebarDropVerb | null {
  if (to === null || to === from || to === "working" || to === "snoozed") return null;
  if (to === "pinned") return "pin";
  if (to === "settled") return "settle";
  if (from === "pinned") return "unpin";
  if (from === "settled") return "unsettle";
  return "wake";
}

/** True when every branch group in `order` stays a single contiguous run.
    This is how active drag-and-drop enforces "branch groups are blocks": a drop
    is allowed only if it neither splits a group nor interleaves two. Callers map
    each active thread key to its group key (branchless threads get a unique key,
    so they never merge and a singleton can still move where it splits nothing).
    Keys absent from the map are hidden/filtered rows and are ignored. */
export function activeOrderKeepsBranchGroupsContiguous(
  order: readonly string[],
  branchKeyById: ReadonlyMap<string, string>,
): boolean {
  const closed = new Set<string>();
  let current: string | undefined;
  for (const id of order) {
    const key = branchKeyById.get(id);
    if (key === undefined) continue;
    if (key === current) continue;
    if (closed.has(key)) return false;
    if (current !== undefined) closed.add(current);
    current = key;
  }
  return true;
}

/** Reinsert members omitted only because their branch group is collapsed.
    The sortable layout stays visual, while ordering plans always operate on
    the complete active order. */
function restoreCollapsedBranchGroupMembers(
  visibleOrder: readonly string[],
  activeOrder: readonly string[],
  branchKeyById: ReadonlyMap<string, string> | undefined,
): readonly string[] {
  if (branchKeyById === undefined) return visibleOrder;
  const visible = new Set(visibleOrder);
  const membersByGroup = new Map<string, string[]>();
  for (const id of activeOrder) {
    const groupKey = branchKeyById.get(id);
    if (groupKey === undefined) continue;
    const members = membersByGroup.get(groupKey);
    if (members) members.push(id);
    else membersByGroup.set(groupKey, [id]);
  }
  const restored: string[] = [];
  const restoredGroups = new Set<string>();
  for (const id of visibleOrder) {
    restored.push(id);
    const groupKey = branchKeyById.get(id);
    if (groupKey === undefined || restoredGroups.has(groupKey)) continue;
    restoredGroups.add(groupKey);
    for (const member of membersByGroup.get(groupKey) ?? []) {
      if (!visible.has(member)) restored.push(member);
    }
  }
  return restored;
}

function activeBranchBlockOrder(
  order: readonly string[],
  branchKeyById: ReadonlyMap<string, string>,
): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const groupKey = branchKeyById.get(id) ?? `missing:${id}`;
    if (seen.has(groupKey)) continue;
    seen.add(groupKey);
    result.push(groupKey);
  }
  return result;
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function planSidebarThreadDrop(input: {
  readonly activeKey: string;
  readonly activeSection: SidebarSection;
  /** Snoozed threads can retain pinning and settlement beneath the shelf. */
  readonly activePinned?: boolean;
  readonly activeSettled?: boolean;
  readonly supportsSettlement?: boolean;
  readonly target: SidebarDropTarget;
  /** All pinned keys in displayed order before the drop. */
  readonly pinnedOrder: readonly string[];
  readonly pinnedKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly reorderableKeys?: ReadonlySet<string>;
  readonly activeOrder: readonly string[];
  readonly activeKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly activeReorderableKeys?: ReadonlySet<string>;
  /** Active thread key → branch group key. When present, active drops that
      would break group contiguity resolve to `none`. */
  readonly activeBranchKeyById?: ReadonlyMap<string, string>;
  /** Working beta: the inbox sorts by time, so drops only change lifecycle. */
  readonly activeTimeOrdered?: boolean;
}): SidebarThreadDropPlan {
  const {
    activeKey,
    activeSection,
    activePinned = activeSection === "pinned",
    activeSettled = activeSection === "settled",
    target,
    pinnedOrder,
    pinnedKeysById,
    reorderableKeys,
    activeOrder,
    activeKeysById,
    activeReorderableKeys,
  } = input;
  const activeGroupKey = input.activeBranchKeyById?.get(activeKey);
  const activeGroupSize =
    activeGroupKey === undefined
      ? 0
      : activeOrder.filter((id) => input.activeBranchKeyById?.get(id) === activeGroupKey).length;
  if (activeSection === "active" && activeGroupSize > 1 && target.section !== "active") {
    return { kind: "none" };
  }
  if (input.supportsSettlement === false && (target.section === "settled" || activeSettled)) {
    return { kind: "none" };
  }
  switch (target.section) {
    case "active": {
      // Like the settled tail: threads can enter a time-ordered inbox, but
      // not be arranged inside it.
      if (input.activeTimeOrdered) {
        return activeSection === "active"
          ? { kind: "none" }
          : {
              kind: "move-active",
              order: null,
              assignments: [],
              unpin: activePinned,
              unsettle: activeSettled,
              unsnooze: activeSection === "snoozed",
            };
      }
      const order = restoreCollapsedBranchGroupMembers(
        target.activeOrder,
        activeOrder,
        input.activeBranchKeyById,
      );
      if (
        activeSection === "active" &&
        activeGroupSize > 1 &&
        input.activeBranchKeyById &&
        !sameOrder(
          activeBranchBlockOrder(activeOrder, input.activeBranchKeyById),
          activeBranchBlockOrder(order, input.activeBranchKeyById),
        )
      ) {
        return { kind: "none" };
      }
      if (activeSection === "active" && sameOrder(order, activeOrder)) {
        return { kind: "none" };
      }
      // Branch groups stay whole: reject any active drop that would split a
      // group or interleave two, so drag-sorting only reorders within a group.
      if (
        input.activeBranchKeyById &&
        !activeOrderKeepsBranchGroupsContiguous(order, input.activeBranchKeyById)
      ) {
        return { kind: "none" };
      }
      const assignments = planPinnedReorder({
        orderedIds: order,
        keysById: activeKeysById,
        movedId: activeKey,
      });
      if (activeReorderableKeys && assignments.some(({ id }) => !activeReorderableKeys.has(id))) {
        return { kind: "none" };
      }
      return {
        kind: "move-active",
        order,
        assignments,
        unpin: activePinned,
        unsettle: activeSettled,
        unsnooze: activeSection === "snoozed",
      };
    }
    case "settled":
      return activeSection === "settled" ? { kind: "none" } : { kind: "settle" };
    case "pinned": {
      const order = target.pinnedOrder;
      // Dropped back where it started: nothing to write.
      if (
        activeSection === "pinned" &&
        order.length === pinnedOrder.length &&
        order.every((key, index) => key === pinnedOrder[index])
      ) {
        return { kind: "none" };
      }
      const assignments = planPinnedReorder({
        orderedIds: order,
        keysById: pinnedKeysById,
        movedId: activeKey,
      });
      if (reorderableKeys && assignments.some(({ id }) => !reorderableKeys.has(id))) {
        return { kind: "none" };
      }
      if (activeSection === "pinned") {
        return assignments.length === 0
          ? { kind: "none" }
          : { kind: "reorder-pinned", order, assignments };
      }
      return {
        kind: "pin",
        order,
        orderKey: assignments.find((assignment) => assignment.id === activeKey)?.orderKey,
        extraAssignments: activePinned
          ? assignments
          : assignments.filter((assignment) => assignment.id !== activeKey),
      };
    }
  }
}

/** Where a whole branch group lands when its header is dragged onto `overId`.
    The group's member rows and its header slot lift out together; the block is
    re-inserted in its existing member order at the over position, then the
    destination section and the resulting pinned/active orders are read back.
    Null when the drop lands on the group's own rows or in the snoozed shelf. */
export function resolveSidebarGroupDropTarget(
  items: readonly SidebarListItem[],
  groupKey: string,
  memberKeys: readonly string[],
  overId: string,
): SidebarDropTarget | null {
  const memberSet = new Set(memberKeys);
  const isMoving = (item: SidebarListItem) =>
    (item.kind === "thread" && memberSet.has(item.key)) ||
    (item.kind === "branch-header" && item.groupKey === groupKey);
  const firstMovingIndex = items.findIndex(isMoving);
  const originalOverIndex = items.findIndex((item) => sidebarListItemId(item) === overId);
  const reduced = items.filter((item) => !isMoving(item));
  const reducedOverIndex = reduced.findIndex((item) => sidebarListItemId(item) === overId);
  // overId is unknown, or it is one of the lifted rows — a no-op either way.
  if (reducedOverIndex === -1) return null;
  const insertionIndex =
    originalOverIndex > firstMovingIndex ? reducedOverIndex + 1 : reducedOverIndex;
  const block: SidebarListItem[] = memberKeys.map((key) => ({
    kind: "thread",
    key,
    section: "active",
  }));
  const moved = [...reduced];
  moved.splice(insertionIndex, 0, ...block);
  return sidebarDropTargetFromItems(moved, insertionIndex);
}

/** A whole-group move: the block stays together and either reorders within the
    active run or dissolves into an adjacent run of independent rows in the
    pinned or settled section (grouping is active-only — ADR 0001). The caller
    presents this as one action and rolls reversible writes back on failure. */
export type SidebarGroupDropPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "reorder-active-group";
      readonly order: readonly string[];
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  | {
      readonly kind: "pin-group";
      readonly members: readonly string[];
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  | { readonly kind: "settle-group"; readonly members: readonly string[] };

export function planSidebarGroupDrop(input: {
  /** The moved group's member keys, in their current (contiguous) order. */
  readonly memberKeys: readonly string[];
  readonly supportsSettlement?: boolean;
  readonly target: SidebarDropTarget;
  readonly pinnedKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly reorderableKeys?: ReadonlySet<string>;
  readonly activeOrder: readonly string[];
  readonly activeKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly activeReorderableKeys?: ReadonlySet<string>;
  /** Active thread key → branch group key, so a block move that would split a
   *different* group resolves to `none` (members stay contiguous by build). */
  readonly activeBranchKeyById?: ReadonlyMap<string, string>;
}): SidebarGroupDropPlan {
  const {
    memberKeys,
    target,
    pinnedKeysById,
    reorderableKeys,
    activeOrder,
    activeKeysById,
    activeReorderableKeys,
  } = input;
  if (memberKeys.length === 0) return { kind: "none" };
  switch (target.section) {
    case "active": {
      const order = restoreCollapsedBranchGroupMembers(
        target.activeOrder,
        activeOrder,
        input.activeBranchKeyById,
      );
      if (sameOrder(order, activeOrder)) {
        return { kind: "none" };
      }
      if (
        input.activeBranchKeyById &&
        !activeOrderKeepsBranchGroupsContiguous(order, input.activeBranchKeyById)
      ) {
        return { kind: "none" };
      }
      const assignments = planContiguousBlockReorder({
        orderedIds: order,
        keysById: activeKeysById,
        movedIds: memberKeys,
      });
      if (activeReorderableKeys && assignments.some(({ id }) => !activeReorderableKeys.has(id))) {
        return { kind: "none" };
      }
      return { kind: "reorder-active-group", order, assignments };
    }
    case "settled":
      return input.supportsSettlement === false
        ? { kind: "none" }
        : { kind: "settle-group", members: memberKeys };
    case "pinned": {
      const assignments = planContiguousBlockReorder({
        orderedIds: target.pinnedOrder,
        keysById: pinnedKeysById,
        movedIds: memberKeys,
      });
      if (reorderableKeys && assignments.some(({ id }) => !reorderableKeys.has(id))) {
        return { kind: "none" };
      }
      return { kind: "pin-group", members: memberKeys, assignments };
    }
  }
}

export interface SidebarGroupDropOperation {
  readonly apply: () => Promise<AtomCommandResult<unknown, unknown>>;
  readonly revert: (() => Promise<AtomCommandResult<unknown, unknown>>) | null;
}

export function buildSidebarGroupDropOperations<TRef>(input: {
  readonly plan: Exclude<SidebarGroupDropPlan, { readonly kind: "none" }>;
  readonly memberKeys: readonly string[];
  readonly resolve: (key: string) => {
    readonly ref: TRef;
    readonly activeOrderKey: string | null;
    readonly pinOrderKey: string | null;
  } | null;
  readonly actions: {
    readonly reorderActive: (
      ref: TRef,
      orderKey: string,
    ) => Promise<AtomCommandResult<unknown, unknown>>;
    readonly reorderPinned: (
      ref: TRef,
      orderKey: string,
    ) => Promise<AtomCommandResult<unknown, unknown>>;
    readonly pin: (ref: TRef, orderKey: string) => Promise<AtomCommandResult<unknown, unknown>>;
    readonly unpin: (ref: TRef) => Promise<AtomCommandResult<unknown, unknown>>;
    readonly settle: (ref: TRef) => Promise<AtomCommandResult<unknown, unknown>>;
    readonly unsettle: (ref: TRef) => Promise<AtomCommandResult<unknown, unknown>>;
  };
}): SidebarGroupDropOperation[] {
  const { plan, resolve, actions } = input;
  const operations: SidebarGroupDropOperation[] = [];
  if (plan.kind === "reorder-active-group") {
    for (const assignment of plan.assignments) {
      const resolved = resolve(assignment.id);
      if (resolved === null) continue;
      const originalOrderKey = resolved.activeOrderKey;
      operations.push({
        apply: () => actions.reorderActive(resolved.ref, assignment.orderKey),
        revert:
          originalOrderKey === null
            ? null
            : () => actions.reorderActive(resolved.ref, originalOrderKey),
      });
    }
    return operations;
  }
  if (plan.kind === "pin-group") {
    const memberSet = new Set(input.memberKeys);
    for (const assignment of plan.assignments) {
      const resolved = resolve(assignment.id);
      if (resolved === null) continue;
      const originalOrderKey = resolved.pinOrderKey;
      operations.push(
        memberSet.has(assignment.id)
          ? {
              apply: () => actions.pin(resolved.ref, assignment.orderKey),
              revert: () => actions.unpin(resolved.ref),
            }
          : {
              apply: () => actions.reorderPinned(resolved.ref, assignment.orderKey),
              revert:
                originalOrderKey === null
                  ? null
                  : () => actions.reorderPinned(resolved.ref, originalOrderKey),
            },
      );
    }
    return operations;
  }
  for (const key of plan.members) {
    const resolved = resolve(key);
    if (resolved === null) continue;
    operations.push({
      apply: () => actions.settle(resolved.ref),
      revert: () => actions.unsettle(resolved.ref),
    });
  }
  return operations;
}

export async function executeSidebarGroupDropOperations(
  operations: readonly SidebarGroupDropOperation[],
): Promise<
  | { readonly status: "success" }
  | { readonly status: "interrupted" }
  | {
      readonly status: "failure";
      readonly failure: AsyncResult.Failure<unknown, unknown>;
    }
> {
  const applied: SidebarGroupDropOperation[] = [];
  for (const operation of operations) {
    const result = await operation.apply();
    if (result._tag === "Success") {
      applied.push(operation);
      continue;
    }
    for (const completed of applied.toReversed()) {
      if (completed.revert) await completed.revert();
    }
    return isAtomCommandInterrupted(result)
      ? { status: "interrupted" }
      : { status: "failure", failure: result };
  }
  return { status: "success" };
}

/** Project a drop's lifecycle fields before sorting its destination. Reusing
    the server's re-entry rules keeps the preview in place when events arrive. */
export function applySidebarThreadDrop<
  T extends Pick<
    SidebarThreadSummary,
    | "pinnedAt"
    | "pinOrderKey"
    | "activeOrderKey"
    | "snoozedAt"
    | "snoozedUntil"
    | "settledAt"
    | "settledOverride"
    | "unsettledAt"
  >,
>(thread: T, section: "pinned" | "active" | "settled", now: string, orderKey?: string): T {
  const wasSettled = thread.settledOverride === "settled";
  const awake = { ...thread, snoozedAt: null, snoozedUntil: null };
  if (section === "settled") {
    return {
      ...awake,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      settledOverride: "settled",
      settledAt: wasSettled ? (thread.settledAt ?? now) : now,
      unsettledAt: null,
    };
  }
  const resumed = wasSettled
    ? { ...awake, settledOverride: "active" as const, settledAt: null, unsettledAt: now }
    : awake;
  return {
    ...resumed,
    pinnedAt: section === "pinned" ? (thread.pinnedAt ?? now) : null,
    pinOrderKey: section === "pinned" ? (orderKey ?? thread.pinOrderKey) : null,
    ...(section === "active" && orderKey !== undefined ? { activeOrderKey: orderKey } : {}),
  };
}

type SidebarProject = {
  id: string;
  title: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

type ScopedSidebarProject = SidebarProject & {
  environmentId: string;
};

type ScopedSidebarThread = ThreadSortInput & {
  environmentId: string;
  projectId: string;
  archivedAt: string | null;
};

type LogicalSidebarProject = SidebarProject & {
  projectKey: string;
  memberProjectRefs: readonly {
    environmentId: string;
    projectId: string;
  }[];
};

export type ThreadTraversalDirection = "previous" | "next";

/**
 * Shared-worktree checks must exclude only successful deletions, never the
 * whole batch. A null result skips an entry that the caller can no longer find.
 */
export async function deleteSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
>(input: {
  entries: readonly TEntry[];
  delete: (
    entry: TEntry,
    deletedThreadKeys: ReadonlySet<string>,
  ) => Promise<AtomCommandResult<unknown, unknown> | null>;
}) {
  const deletedThreadKeys = new Set<string>();
  let firstFailure: AsyncResult.Failure<unknown, unknown> | null = null;

  for (const entry of input.entries) {
    const result = await input.delete(entry, deletedThreadKeys);
    if (result === null) continue;
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) break;
      firstFailure ??= result;
      continue;
    }
    deletedThreadKeys.add(entry.threadKey);
  }

  return { deletedThreadKeys, firstFailure };
}

export async function archiveSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
  TResult extends { readonly _tag: "Success" | "Failure" },
>(input: {
  entries: readonly TEntry[];
  archive: (entry: TEntry, onArchived: () => void) => Promise<TResult>;
}): Promise<{
  archivedThreadKeys: readonly string[];
  mutationFailure: Extract<TResult, { readonly _tag: "Failure" }> | null;
  followupFailures: readonly Extract<TResult, { readonly _tag: "Failure" }>[];
}> {
  const archivedThreadKeys: string[] = [];
  const followupFailures: Extract<TResult, { readonly _tag: "Failure" }>[] = [];

  for (const entry of input.entries) {
    let didArchive = false;
    const result = await input.archive(entry, () => {
      didArchive = true;
    });
    if (didArchive || result._tag === "Success") archivedThreadKeys.push(entry.threadKey);
    if (result._tag === "Success") continue;
    const failure = result as Extract<TResult, { readonly _tag: "Failure" }>;
    if (didArchive) {
      followupFailures.push(failure);
      continue;
    }
    return { archivedThreadKeys, mutationFailure: failure, followupFailures };
  }

  return { archivedThreadKeys, mutationFailure: null, followupFailures };
}

export function buildMultiSelectThreadContextMenuItems(input: {
  count: number;
  hasRunningThread: boolean;
}): readonly ContextMenuItem<"mark-unread" | "archive" | "delete">[] {
  return [
    { id: "mark-unread", label: `Mark unread (${input.count})` },
    {
      id: "archive",
      label: `Archive (${input.count})`,
      disabled: input.hasRunningThread,
    },
    { id: "delete", label: `Delete (${input.count})`, destructive: true },
  ];
}

export function isSidebarSubagentThread(thread: Pick<SidebarThreadSummary, "lineage">): boolean {
  return thread.lineage.relationshipToParent === "subagent";
}

export function filterSidebarV2VisibleThreads<
  T extends Pick<SidebarThreadSummary, "archivedAt" | "lineage"> & {
    environmentId: string;
    projectId: string;
  },
>(threads: readonly T[], scopedProjectKeys: ReadonlySet<string> | null): T[] {
  return threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      !isSidebarSubagentThread(thread) &&
      (scopedProjectKeys === null ||
        scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  );
}

export function getSidebarForkParentThreadId(
  thread: Pick<SidebarThreadSummary, "forkedFrom" | "lineage">,
) {
  if (thread.lineage.relationshipToParent !== "fork") {
    return null;
  }
  return thread.forkedFrom?.type === "run"
    ? thread.forkedFrom.threadId
    : thread.lineage.parentThreadId;
}

export function buildBulkTitleRegenerationContextMenuItem(input: {
  supportedCount: number;
  actionableCount: number;
}): ContextMenuItem<"regenerate-title"> | null {
  if (input.supportedCount === 0) return null;
  if (input.actionableCount === 0) {
    return {
      id: "regenerate-title",
      label: `Regenerating… (${input.supportedCount})`,
      disabled: true,
    };
  }
  return {
    id: "regenerate-title",
    label: `Regenerate titles (${input.actionableCount})`,
  };
}

/**
 * Bulk unpin follows the same "count only what the action will touch" rule
 * as title regeneration: on a mixed selection the label counts the pinned
 * rows alone, and the item disappears when nothing selected is pinned.
 */
export function buildBulkUnpinContextMenuItem(input: {
  pinnedCount: number;
}): ContextMenuItem<"unpin"> | null {
  if (input.pinnedCount === 0) return null;
  return { id: "unpin", label: `Unpin (${input.pinnedCount})` };
}

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Waiting"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  Working: 3,
  Connecting: 3,
  Waiting: 2.5,
  "Plan Ready": 2,
  Completed: 1,
};

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestRun"
  | "runtime"
> & {
  lastVisitedAt?: string | null | undefined;
  pendingBackgroundTasks?: SidebarThreadSummary["pendingBackgroundTasks"] | undefined;
};

export interface ThreadJumpHintVisibilityController {
  sync: (shouldShow: boolean) => void;
  dispose: () => void;
}

export function resolveSidebarStageBadgeLabel(input: {
  primaryServerVersion: string | null | undefined;
  fallbackStageLabel: string;
}): string {
  return resolveServerBackedAppStageLabel(input);
}

export function createThreadJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): ThreadJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let isVisible = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const clearPendingShow = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeoutFn(timeoutId);
    timeoutId = null;
  };

  return {
    sync: (shouldShow) => {
      if (!shouldShow) {
        clearPendingShow();
        if (isVisible) {
          isVisible = false;
          input.onVisibilityChange(false);
        }
        return;
      }

      if (isVisible || timeoutId !== null) {
        return;
      }

      timeoutId = setTimeoutFn(() => {
        timeoutId = null;
        isVisible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: () => {
      clearPendingShow();
    },
  };
}

export function useThreadJumpHintVisibility(): {
  showThreadJumpHints: boolean;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showThreadJumpHints, setShowThreadJumpHints] = React.useState(false);
  const controllerRef = React.useRef<ThreadJumpHintVisibilityController | null>(null);

  React.useEffect(() => {
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        setShowThreadJumpHints(visible);
      },
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const updateThreadJumpHintsVisibility = React.useCallback((shouldShow: boolean) => {
    controllerRef.current?.sync(shouldShow);
  }, []);

  return {
    showThreadJumpHints,
    updateThreadJumpHintsVisibility,
  };
}

/**
 * Effective visited watermark for a thread. Servers with visited tracking
 * project `lastVisitedAt` on the shell and are authoritative — that value is
 * shared across every device connected to the environment. Pre-tracking
 * servers omit the field, and the browser's locally persisted watermark keeps
 * working as before.
 */
export function resolveThreadLastVisitedAt(
  serverLastVisitedAt: string | null | undefined,
  localLastVisitedAt: string | undefined,
): string | undefined {
  // When the server tracks visits it is authoritative — including explicit
  // rewinds from mark-unread, which a newer browser-local watermark must not
  // mask. The local value only carries servers without visited tracking.
  if (serverLastVisitedAt === undefined) return localLastVisitedAt;
  return serverLastVisitedAt ?? undefined;
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestRun?.completedAt) return false;
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

// A double-click dispatches two `click` events before `dblclick`: the first has
// `detail === 1`, the second `detail === 2`. The second click must not run the
// row's single-click navigation, otherwise double-click-to-rename would also
// navigate. `MouseEvent.detail` is 0 for synthetic/keyboard activations, which
// still count as a normal single activation.
export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1;
}

function nodeClosest(node: object | null, selector: string): unknown {
  if (node === null || !("closest" in node) || typeof node.closest !== "function") return null;
  return node.closest(selector);
}

/** Clicks on a nested link keep the link's meaning. The row must not treat them as multi-select. */
export function isSidebarNestedLinkClick(target: EventTarget | null): boolean {
  if (target == null || typeof target !== "object") return false;
  if (nodeClosest(target, "a[href]") !== null) return true;
  const parent =
    "parentElement" in target &&
    target.parentElement !== null &&
    typeof target.parentElement === "object"
      ? target.parentElement
      : null;
  return nodeClosest(parent, "a[href]") !== null;
}

// Shift+click on the new thread button creates directly in the current
// project, skipping the command palette's project picker. With a single
// project there is nothing to pick, so a plain click already creates
// immediately and the modifier changes nothing.
export function shouldCreateNewThreadInCurrentProject(
  shiftKey: boolean,
  projectGroupCount: number,
): boolean {
  return shiftKey || projectGroupCount <= 1;
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
  getPreferenceIds?: (item: TItem) => readonly TId[];
}): TItem[] {
  const { getId, getPreferenceIds, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const indexesByPreferenceId = new Map<TId, number[]>();
  for (const [index, item] of items.entries()) {
    const preferenceIds = getPreferenceIds?.(item) ?? [getId(item)];
    for (const preferenceId of new Set(preferenceIds)) {
      const indexes = indexesByPreferenceId.get(preferenceId);
      if (indexes) {
        indexes.push(index);
      } else {
        indexesByPreferenceId.set(preferenceId, [index]);
      }
    }
  }

  const emittedIndexes = new Set<number>();
  const ordered = preferredIds.flatMap((id) => {
    const index = indexesByPreferenceId
      .get(id)
      ?.find((candidate) => !emittedIndexes.has(candidate));
    if (index === undefined) {
      return [];
    }
    emittedIndexes.add(index);
    return [items[index]!];
  });
  const remaining = items.filter((_, index) => !emittedIndexes.has(index));
  return [...ordered, ...remaining];
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-8 w-full translate-x-0 cursor-pointer justify-start rounded-md px-2 text-left text-sm select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-sidebar-row-active text-sidebar-foreground font-medium hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-sidebar-row-selected text-sidebar-foreground hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-sidebar-row-active text-sidebar-foreground font-medium hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  return cn(
    baseClassName,
    "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
  );
}

// ── Sidebar v2 status model ─────────────────────────────────────────
// Six visual states, three colors: color is reserved for "act now"
// (approval), "in motion" (working), and "broken" (failed). Ready is the
// unlabeled resting state — the agent stopped and is waiting on the user,
// whether it finished, asked a question, or proposed a plan. Waiting
// (runtime status "idle") is the agent stopped with background tasks still
// open: not the user's turn yet, so it renders grey like working, not as a
// false Done.
// Unread completion is tracked separately: it describes whether a ready
// thread needs attention, not what the thread is currently doing.
export type SidebarThreadStatus =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export function shouldRecedeSidebarThread(input: {
  status: SidebarThreadStatus;
  isUnread: boolean;
  isWoke: boolean;
  isActive: boolean;
  isSelected: boolean;
}): boolean {
  if (input.isActive || input.isSelected || input.status === "input") return false;
  if (input.status === "working" || input.status === "waiting") return true;
  if (input.status === "ready" || input.status === "approval") {
    return !input.isUnread && !input.isWoke;
  }
  return false;
}

type SidebarThreadStatusInput = Pick<
  SidebarThreadSummary,
  "hasPendingApprovals" | "hasPendingUserInput" | "runtime"
>;

export function resolveSidebarThreadStatus(thread: SidebarThreadStatusInput): SidebarThreadStatus {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

export type SidebarBranchStatus = "approval" | "input" | "failed" | "active";

export interface SidebarBranchStatusCount {
  readonly status: SidebarBranchStatus;
  readonly count: number;
}

/** Summarizes the live states a collapsed branch would otherwise hide.
    Working and waiting share one calm active-work indicator at group level. */
export function resolveSidebarBranchStatusSummary(
  threads: ReadonlyArray<SidebarThreadStatusInput>,
): SidebarBranchStatusCount[] {
  const counts: Record<SidebarBranchStatus, number> = {
    approval: 0,
    input: 0,
    failed: 0,
    active: 0,
  };

  for (const thread of threads) {
    const status = resolveSidebarThreadStatus(thread);
    if (status === "working" || status === "waiting") counts.active += 1;
    else if (status === "limited") counts.failed += 1;
    else if (status !== "ready") counts[status] += 1;
  }

  return (["approval", "input", "failed", "active"] as const).flatMap((status) =>
    counts[status] === 0 ? [] : [{ status, count: counts[status] }],
  );
}

export interface SidebarBranchTerminalSession {
  readonly target: { readonly threadId: string };
  readonly state: { readonly hasRunningSubprocess: boolean };
}

/** Counts threads in the group that currently have a running terminal subprocess.
    Multiple terminals on one thread still count as one thread. */
export function countThreadsWithRunningTerminals(
  threads: ReadonlyArray<{ readonly id: string }>,
  sessions: ReadonlyArray<SidebarBranchTerminalSession>,
): number {
  if (threads.length === 0) return 0;
  const groupIds = new Set(threads.map((thread) => thread.id));
  const running = new Set<string>();
  for (const session of sessions) {
    if (!session.state.hasRunningSubprocess) continue;
    const threadId = session.target.threadId;
    if (groupIds.has(threadId)) running.add(threadId);
  }
  return running.size;
}

export type SidebarV2TopStatusKind =
  | "approval"
  | "done"
  | "failed"
  | "limited"
  | "input"
  | "waiting"
  | "woke"
  | "working";

export function resolveSidebarV2TopStatus(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
}): SidebarV2TopStatusKind | null {
  if (input.status === "working") {
    return "working";
  }
  if (input.status === "waiting") {
    return "waiting";
  }
  if (input.status === "approval") {
    return "approval";
  }
  if (input.status === "input") {
    return "input";
  }
  if (input.status === "failed" || input.status === "limited") {
    return input.status;
  }
  if (input.isWoke) {
    return "woke";
  }
  return input.isUnread ? "done" : null;
}

export function shouldShowSidebarV2Duration(status: SidebarThreadStatus): boolean {
  return status === "working";
}

/** Working beta: threads busy with work that does not need the user fold into
    the Working shelf: a running run, or one stopped with background tasks
    still open. Approvals, questions, plan prompts, and failures stay in the
    inbox. */
export function isSidebarThreadWorking(thread: ThreadStatusInput): boolean {
  const status = resolveSidebarThreadStatus(thread);
  if (status !== "working" && status !== "waiting") return false;
  // A plan prompt outranks lingering background work: the user has to act on it.
  return !(
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    isLatestRunSettled(thread.latestRun, thread.runtime)
  );
}

/** First VALID timestamp wins: `a ?? b` falls through on null, but a present-
    yet-malformed string must also fall through to the next candidate rather
    than sink the row to the epoch. */
export function firstValidTimestampMs(
  ...candidates: ReadonlyArray<string | null | undefined>
): number {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

// Sidebar sort: new and reopened threads lead the persisted active order,
// then threads on the same workspace branch are kept together. Activity does
// not reorder the list. Web and mobile share this exact ordering.
export function sortThreadsForSidebar<
  T extends {
    readonly id: string;
    readonly environmentId?: string | undefined;
    readonly projectId?: string | undefined;
    readonly branch?: string | null | undefined;
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
    readonly activeOrderKey?: string | null | undefined;
  },
>(threads: readonly T[]): T[] {
  return sortActiveThreadsByBranch(threads);
}

// Pinned-reorder key math and the keyed sort live in client-runtime
// (state/thread-sort) so web and mobile compute identical pinned orders.
export { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
export { sortPinnedThreadsByOrderKey as sortPinnedThreadsForSidebar } from "@t3tools/client-runtime/state/thread-sort";

const EMPTY_CONTENT_MATCH_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * Search the already-ordered sidebar thread collection by title or linked PR,
 * plus any thread whose messages the server matched (`contentMatchKeys`, keyed
 * by `threadSearchMatchKey`). Keeping the input order means lifecycle ordering
 * (active, snoozed, settled) remains stable while the user narrows the list.
 */
export function searchSidebarThreads<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly title: string;
  } & Parameters<typeof threadPullRequestSearchTerms>[0],
>(
  threads: readonly T[],
  query: string,
  contentMatchKeys: ReadonlySet<string> = EMPTY_CONTENT_MATCH_KEYS,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return [];
  const titleMatches: T[] = [];
  const contentMatches: T[] = [];
  for (const thread of threads) {
    const matchesTitle = [thread.title, ...threadPullRequestSearchTerms(thread)].some((term) =>
      term.toLowerCase().includes(normalizedQuery),
    );
    if (matchesTitle) {
      titleMatches.push(thread);
    } else if (
      contentMatchKeys.size > 0 &&
      contentMatchKeys.has(
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      )
    ) {
      contentMatches.push(thread);
    }
  }
  return [...titleMatches, ...contentMatches];
}

export function filterSidebarProjectScopeItems<TItem extends { readonly value: string }>(input: {
  items: readonly TItem[];
  query: string;
  matches: (item: TItem, query: string) => boolean;
}): readonly TItem[] {
  const query = input.query.trim();
  if (query.length === 0) return input.items;
  return input.items.filter((item) => item.value !== "all" && input.matches(item, query));
}

export interface SidebarProjectScopeMenuState {
  readonly open: boolean;
  readonly query: string;
}

export type SidebarProjectScopeMenuAction =
  | { readonly type: "query-changed"; readonly query: string }
  | { readonly type: "open-changed"; readonly open: boolean }
  | { readonly type: "project-settings-opened" };

export function reduceSidebarProjectScopeMenuState(
  state: SidebarProjectScopeMenuState,
  action: SidebarProjectScopeMenuAction,
): SidebarProjectScopeMenuState {
  switch (action.type) {
    case "query-changed":
      return { ...state, query: action.query };
    case "open-changed":
      return { open: action.open, query: "" };
    case "project-settings-opened":
      return { open: false, query: "" };
  }
}

/** Working beta: the inbox lists threads newest first by when each last came
    back to the user, so a thread that leaves the Working shelf lands on top.
    `observedReturnAt` adds returns the server does not stamp, such as an
    approval request mid-turn or background work ending. */
export function sortInboxThreadsByReturn<
  T extends Pick<
    SidebarThreadSummary,
    "id" | "environmentId" | "createdAt" | "unsettledAt" | "latestRun"
  >,
>(threads: readonly T[], observedReturnAt?: (thread: T) => number | undefined): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.requestedAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.completedAt ?? undefined) ?? 0,
        observedReturnAt?.(thread) ?? 0,
      ),
    ]),
  );
  return [...threads].sort(
    (left, right) =>
      timestamps.get(right)! - timestamps.get(left)! ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId),
  );
}

/** The timestamp a working thread's elapsed label counts from: the running
    turn's start (request time until adoption), falling back to the session's
    last transition when the turn projection lags behind. Malformed
    timestamps fall through to the next candidate, not just missing ones. */
export function resolveWorkingStartedAt(
  thread: Pick<SidebarThreadSummary, "latestRun" | "runtime">,
): string | null {
  return resolveThreadWorkingStartedAt(thread);
}

export function formatWorkingDurationLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (thread.runtime?.status === "running" || thread.runtime?.status === "waiting") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    thread.runtime?.status === "preparing" ||
    thread.runtime?.status === "starting" ||
    thread.runtime?.status === "queued"
  ) {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if ((thread.pendingBackgroundTasks?.length ?? 0) > 0) {
    return {
      label: "Waiting",
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestRunSettled(thread.latestRun, thread.runtime) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}
export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly ThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

function sortProjectsByActivity<TProject extends SidebarProject>(
  projects: readonly TProject[],
  sortOrder: SidebarProjectSortOrder,
  getProjectThreads: (project: TProject) => readonly ThreadSortInput[],
  compareTies: (left: TProject, right: TProject) => number,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  // Each project's timestamp walks all of its threads, so compute it once
  // per project instead of once per comparison.
  return projects
    .map((project) => ({
      project,
      timestamp: getProjectSortTimestamp(project, getProjectThreads(project), sortOrder),
    }))
    .sort((left, right) => {
      const byTimestamp =
        right.timestamp === left.timestamp ? 0 : right.timestamp > left.timestamp ? 1 : -1;
      return byTimestamp || compareTies(left.project, right.project);
    })
    .map(({ project }) => project);
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectId.get(project.id) ?? [],
    (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
  );
}

export function sortLogicalProjectsForSidebar<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const groupKeyByProjectRef = new Map(
    projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (projectRef) =>
          [`${projectRef.environmentId}\0${projectRef.projectId}`, project.projectKey] as const,
      ),
    ),
  );
  const threadsByProjectKey = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const projectKey = groupKeyByProjectRef.get(`${thread.environmentId}\0${thread.projectId}`);
    if (!projectKey) continue;
    const existing = threadsByProjectKey.get(projectKey);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProjectKey.set(projectKey, [thread]);
    }
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectKey.get(project.projectKey) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) || left.projectKey.localeCompare(right.projectKey),
  );
}

export function sortSidebarV2ProjectGroups<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread & Pick<SidebarThreadSummary, "lineage">,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  return sortLogicalProjectsForSidebar(
    projects,
    filterSidebarV2VisibleThreads(threads, null),
    sortOrder,
  );
}

/**
 * Sorts the cross-environment project collection used by landing surfaces.
 * Project ids are only unique within an environment, and archived threads
 * must not make a project appear recently active.
 */
export function sortScopedProjectsForSidebar<
  TProject extends ScopedSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const scopedKey = (environmentId: string, projectId: string) =>
    `${environmentId}\u0000${projectId}`;
  const threadsByProject = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) {
      continue;
    }
    const key = scopedKey(thread.environmentId, thread.projectId);
    const existing = threadsByProject.get(key) ?? [];
    existing.push(thread);
    threadsByProject.set(key, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProject.get(scopedKey(project.environmentId, project.id)) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) ||
      left.environmentId.localeCompare(right.environmentId) ||
      left.id.localeCompare(right.id),
  );
}
