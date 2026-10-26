# Architecture

coBWeb is a TypeScript MCP server (stdio) for one BW system per process.

## Request flow

1. **Surface** (`src/server/surface.ts`): at start the server builds the tool list from the
   catalog, the profile, the flags and `COBWEB_DENY_ACTIONS`. Tools and actions that are not
   allowed are not offered. The list does not change while the server runs.
2. **Validation** (`src/format/validate.ts`): every call is checked against the same schema the
   tool list shows; unknown parameters are refused with the allowed ones.
3. **Policy** (`src/policy/policy.ts`): one table assigns each tool action an operation class
   (read, data, write, execute, transport) and checks it against the flags, packages and
   InfoAreas.
4. **Handler** (`src/tools/`): one module per tool group.
5. **Result** (`src/format/`): errors become tool results with a cause and a hint; every result
   is cut at `COBWEB_MAX_RESULT_CHARS` with a note on how to read the rest.

## Modules

| Folder | Content |
|---|---|
| `src/catalog/` | tool definitions and object type codes |
| `src/server/` | MCP server, tool surface, handshake instructions, audit log |
| `src/policy/` | operation classes, allow and deny rules |
| `src/tools/` | handlers: search, read, context, describe, write, activate, data, monitor, run, transport, system |
| `src/engine/` | the write flow: dependency order, lock, save, activate, unlock, where-used checks, `validate_only` |
| `src/objects/` | one adapter per object type: spec check, read summary, create, update, delete |
| `src/legacy/` | the BW REST paths for modeling, reporting, runtime and transports |
| `src/bw/` | HTTP client (sessions, CSRF, locks, retries), platform and media type discovery |
| `src/transport/` | stdio entry point |

## Object adapters

Each type has an adapter (`src/objects/<type>.ts`) with the same interface:

- `describe(action)`: the spec format `bw_describe` returns;
- `check(action, name, spec)`: a strict check before any BW access;
- `dependsOn`, `targetInfoArea`: what the write engine needs for ordering and the InfoArea rule;
- `locate`, `read`: existence and the compact summary for `bw_read`;
- `create`, `update`, `delete`: the changes, through `src/legacy/`.

`update` compares the spec with the current object and writes only what differs, so a repeated
spec is `unchanged`.

## Write flow

`bw_write` resolves every object (exists or not, package, InfoArea), checks the specs, orders
the objects by dependency (InfoArea, InfoObjects, providers, transformations, DTPs, process
chains, queries) and then, per object: lock, save, activate, unlock. A failure stops only the
objects that depend on it. Deletes run in reverse order of use after a where-used check.
`validate_only` runs every check without writing.

## Safety

- Read-only without flags; writes, data and runtime actions are separate flags.
- Writes only into allowed packages (default `$TMP`) and InfoAreas.
- Secrets come from the environment and are never logged or returned.
- Logs go to stderr; stdout carries only the MCP protocol.
- Optional audit log of every written object (`COBWEB_AUDIT_FILE`).
