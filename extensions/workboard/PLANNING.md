# Planning columns

A board can display its existing cards in **Planning** or **Execution status** mode.
The global Workboard continues to group cards by execution status. A board without
saved planning settings initially opens in execution mode; a configured board
initially opens in planning mode. Switching modes does not copy cards.

In planning mode, **Edit board** changes column names, widths (200–800 px), and
column order, or adds/removes columns. Changes are saved together. Removing a
column requires a remaining destination for its cards. The stable `inbox` column
can be renamed and resized but cannot be removed. New or unassigned cards appear
there. Column edges support pointer resizing and left/right arrow keys. Cards can
be dragged between columns or moved with the labelled planning-column selector.

## Storage and compatibility

The plugin owns two additive tables in its existing Workboard SQLite database:
`workboard_planning_boards` stores the board revision and column definitions;
`workboard_planning_cards` stores card placement. Planning never changes a card's
execution `status`, execution `position`, or history. Moving a card to another
board through the existing card API clears its planning placement. Deleting a
card removes its placement through the existing foreign-key cleanup.

The Gateway provides:

- `workboard.planning.get`: `{ boardId }`, requiring `operator.read`.
- `workboard.planning.update`: `{ boardId, expectedRevision, columns,
deletedColumnDestinations? }`, requiring `operator.write`.
- `workboard.planning.move`: `{ boardId, expectedRevision, cardId, columnId,
order }`, requiring `operator.write`.

Each response contains `{ planning }`. Column identifiers are stable across
renames. A move treats `order` as the requested insertion position; the returned
snapshot contains the canonical column order after spacing is normalized. Writes compare the expected revision inside a synchronous transaction;
removing columns and relocating their cards is atomic. A conflict returns
`workboard_conflict` with `WORKBOARD_PLANNING_CONFLICT` in its details. The UI
preserves the edit draft and requires explicit reload after a failed write rather
than retrying it against a newer revision. Successful writes publish the existing
Workboard change event.

An unconfigured board has a virtual inbox and revision zero; reading it does not
persist a configuration. Reads use the existing immediate-transaction helper to
obtain a consistent snapshot, which acquires a reserved write lock. Existing
readers and dispatchers can ignore the additive tables and retain their current
execution semantics.
