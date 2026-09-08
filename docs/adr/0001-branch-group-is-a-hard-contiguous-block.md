# 1. Branch group is a hard contiguous block

Date: 2026-09-08

## Status

Accepted

## Context

A main merge rewrote the sidebar into a single flat drag-sortable list (dnd-kit)
and dropped the earlier branch-group rendering, leaving same-branch threads
merely adjacent with no headers, collapse, or summaries. Reintegrating grouping
forced a decision about what a branch group _is_ once every row can, in
principle, be dragged anywhere.

A thread's branch is real git state. It cannot be reassigned by dragging a row
in the sidebar. That makes "drag a thread into another branch group" either
meaningless or a lie about what happened.

Two models were on the table:

- **Soft visual cluster.** Threads are only visually clustered by branch. A drag
  may pull a thread out of its cluster; the flat order wins and the cluster
  reforms or splits around it.
- **Hard contiguous block.** A branch group is an inseparable unit. Members stay
  together; only their order within the block, or the block's position as a
  whole, can change.

## Decision

A branch group is a **hard contiguous block**.

- Dragging a member reorders it only _within_ its own group; its order key stays
  inside the group's existing key range, so the block's outer position never
  shifts as a side effect. Illegal targets show no drop indicator mid-drag, and
  releasing outside the group is a no-op.
- The group **header is the drag handle** for the whole block. Moving it rewrites
  all member order keys to sit contiguously at the new position.
- A header-drag across a section boundary pins or settles **all** members
  together. Grouping does not exist in the pinned or settled sections, so the
  block dissolves there into independent rows placed as an adjacent run.
- A whole-group move is **all-or-nothing**: it issues one reorder per member and
  rolls the entire move back if any command fails, because a half-moved group
  violates the block invariant.
- Grouping applies to the active section on web only. Pinned stays ungrouped,
  mobile stays flat, keyboard DnD is out of scope — each is a separate future
  decision, not a promise.

## Consequences

- The flat dnd-kit list and grouping coexist via a contiguity guard: any active
  drop that would split or interleave a group is rejected, enforced during
  collision detection (not only at drop time) so illegality is visible mid-drag.
- Moving a group costs N reorder commands instead of the system's usual one key
  on one thread. Groups are small, so this is accepted; an atomic batch reorder
  command is a possible future contract addition if it becomes a problem.
- The layout snapshot is frozen for the duration of a drag; group membership is
  reconciled against live state on drop (a member settled mid-drag is dropped
  from the move; a group shrunk to one becomes a plain single-thread reorder).
- There is no way to scatter a branch's threads across the list. That is the
  point: the branch is the reason they belong together.
