# Context

Domain glossary for T3 Code. Definitions only — no implementation detail. See
`AGENTS.md` for the broader vocabulary (user, agent, provider, client, thread,
turn, environment, project).

## Branch group

A contiguous block of active **threads** that share the same real git branch
within one project. It exists only in the active section of the sidebar.

A branch group is a **hard block**: its members always sit together, in a fixed
outer position relative to other groups and to standalone threads. A thread's
branch is real git state, so a thread cannot be moved out of its group by
reordering — dragging a member only permutes order _within_ the group, and
dragging the group's header moves the whole block as a unit. A group only
surfaces as a labelled, collapsible unit when it holds more than one thread; a
lone thread on a branch is just a standalone row.

Branch grouping does not exist in the pinned or settled sections: moving a group
there dissolves it into independent rows.
