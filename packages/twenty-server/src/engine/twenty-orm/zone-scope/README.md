# Zone scope (Macssen fork)

Restricts one role (for example "Vendedor") to the CRM records of the zones
assigned to each user. Written from scratch by Macssen and licensed AGPL-3.0,
like the rest of this repository's core. It does not use, copy or modify any
file marked `/* @license Enterprise */`, and it does not touch the license check.

## How it works

The whole feature hangs off the row-level permission hook of
`WorkspaceRepository` (`twenty-orm/repository/workspace-repository.ts`):

| Where | What we add |
|---|---|
| `applyRowLevelPermissionPredicateForAlias` | `applyZoneScope(...)`: one SQL predicate on the main table and on every join / relation-filter alias |
| `runInsert` | `enforceZoneScopeOnInsert(...)`: a seller can only create records in its zones |
| `runBatchUpdate`, `runMutation` | `enforceZoneScopeOnUpdate(...)`: a seller cannot move a record out of its zones |

Every select, count, aggregate, group-by, search, relation and update/delete
target goes through that hook, so they all inherit the filter. Internal jobs run
with `shouldBypassPermissionChecks` and are not restricted.

The predicate is pure SQL (the hook is synchronous):

```
NOT <caller holds the role ZONE_SCOPE_ROLE>          -- checked against core.role
OR <row is in one of the caller's zones>             -- subquery on the assignment object
```

- **Scoped objects** (`ZONE_SCOPE_OBJECTS`): `"<alias>"."zona" IN (zones of the member)`.
- **Dependent objects** (`ZONE_SCOPE_DEPENDENT_OBJECTS`): every MANY_TO_ONE pointing
  to a scoped object must be null or point to a visible record (timeline, note and
  task targets, attachments).
- **Linked objects** (`ZONE_SCOPE_LINKED_OBJECTS`, `parent:junction`): a note or task is
  hidden as soon as one of its targets points outside the member's zones.

Fails closed: a seller with no assignment, an API key with the seller role (no
member, so no zones), or a missing zone field / assignment object sees no scoped record.

## Data model expected in the workspace

- A SELECT field `zona` (same options everywhere) on every scoped object.
- A custom object `asignacionZona` with a MULTI_SELECT `zonas` and a MANY_TO_ONE
  relation `vendedor` to Workspace Member. One active row per seller.

## Configuration (env, server **and** worker)

| Variable | Default | |
|---|---|---|
| `ZONE_SCOPE_ROLE` | unset = feature off | Role label, e.g. `Vendedor` |
| `ZONE_SCOPE_OBJECTS` | `company,person,opportunity` | |
| `ZONE_SCOPE_FIELD` | `zona` | |
| `ZONE_SCOPE_ASSIGNMENT_OBJECT` | `asignacionZona` | |
| `ZONE_SCOPE_ASSIGNMENT_MEMBER_FIELD` | `vendedor` | |
| `ZONE_SCOPE_ASSIGNMENT_ZONES_FIELD` | `zonas` | |
| `ZONE_SCOPE_DEPENDENT_OBJECTS` | `timelineActivity,noteTarget,taskTarget,attachment` | |
| `ZONE_SCOPE_LINKED_OBJECTS` | `note:noteTarget,task:taskTarget` | |

Values are read once per process: restart after changing them.

## Behaviour worth knowing

- Creating a record without a zone: filled in with the seller's zone when it has
  exactly one; rejected when it has several (create from a view filtered by zone).
- Related records of another zone show as empty (a person of my zone whose company
  is in another zone shows no company).
- A note linked to my zone **and** another zone is hidden (conservative).

## Known gaps (not covered by this patch)

- Emails and calendar events (`message`, `calendarEvent`) are not zone-scoped. Do
  not enable mailbox sync for sellers until this is handled.
- Workflows run as the system and see everything; a workflow a seller can trigger
  could expose other zones through its output.
- Upsert matches existing rows without the filter, so a seller can learn that a
  record with a given unique value exists in another zone (it cannot read or change it).
- Database events (webhooks, timeline) for a blocked update by id may still be emitted
  with the before-snapshot of the hidden record (upstream behaviour of the event path).

## Tests

`test/integration/zone-scope/` covers the leak matrix (lists, findOne, counts,
aggregates, group-by, search, nested and filtered relations, REST, timeline, notes,
tasks, API key, writes and fail-closed). Run with:

```
ZONE_SCOPE_ROLE="Zone Scope Seller" NODE_ENV=test \
  npx jest --config ./jest-integration.config.ts test/integration/zone-scope
```

## Upgrading Twenty

Rebase `edel/*` on the new tag. If the hook moves, the integration tests fail.
If upstream relicenses the hook under the Enterprise license, stop and reevaluate.
