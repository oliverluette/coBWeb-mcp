<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/cobweb-icon-dark.svg">
    <img src="docs/assets/cobweb-icon.svg" alt="coBWeb logo: a data cube in a net" width="120">
  </picture>
</p>

# coBWeb

An MCP server for modeling in SAP BW/4HANA. coBWeb talks to the REST interface of the BW
Modeling Tools (`/sap/bw/modeling/…`) and gives a language model eleven intent-based tools:
search, read, write, activate, data, monitoring, runtime actions and transports. It does not
offer one tool per object type and operation.

The design goal is a small, stable tool list that costs few input tokens on every step, and
writes that finish a task in few calls:

- **Few tools, small schemas.** The whole catalog has 11 tools and about 16,200 characters
  (roughly 4,600 tokens). The default profile `modeling` has 8 tools and about 10,600 characters.
- **One call per change.** `bw_write` takes several objects at once (InfoObjects, a DataStore
  object, a CompositeProvider, a transformation and its DTP), orders them by dependency, locks,
  saves, activates and unlocks. The model never handles lock handles or sessions.
- **Declarative specs.** An object is described by a spec; the same spec again reports
  `unchanged`. `bw_describe` returns the spec format of a type.
- **Compact answers.** Reads return a summary first; `detail` and `part` give more on request.
  Errors say what to change.
- **Safe by default.** Without flags the server only reads. Writes, data access and runtime
  actions are switched on separately and limited to packages and InfoAreas you allow.

## Tools

| Tool | Purpose |
|---|---|
| `bw_search` | find objects by name or description; list an InfoArea |
| `bw_read` | read one object: summary, full or raw; `part` for one section |
| `bw_context` | data flow and where-used of an object in one answer |
| `bw_describe` | the spec format `bw_write` expects for a type |
| `bw_write` | create, update, delete several objects and activate them in one call; `validate_only` checks without writing |
| `bw_activate` | check or activate inactive objects |
| `bw_data` | query data (rows, columns, filters, variables, hierarchy nodes), DataSource preview, characteristic values |
| `bw_monitor` | process chain runs, load requests, remodeling requests, query statistics |
| `bw_run` | run a DTP, start a process chain, activate or delete requests, remodeling, push data into an ADSO |
| `bw_transport` | changeable transport requests, transport tasks, package assignment, moving objects between InfoAreas |
| `bw_system` | system profile and active safety settings; release a lock after an aborted change |

Parameters and examples: [docs/TOOLS.md](docs/TOOLS.md).

## Object types

| Code | Object | Read | Write |
|---|---|---|---|
| `AREA` | InfoArea | ✔ | create, update, delete |
| `IOBJ` | InfoObject (characteristics, key figures, attributes, compounding, hierarchies) | ✔ | create, update, delete |
| `ADSO` | DataStore object (advanced) incl. fields without InfoObject, keys, settings, planning | ✔ | create, update, delete |
| `HCPR` | CompositeProvider (union, join), mappings, field groups | ✔ | create, update, delete |
| `TRCS` | InfoSource | ✔ | create, update, delete |
| `TRFN` | Transformation: rules, lookups, start, end and expert routines, runtime | ✔ | create, update, delete |
| `DTPA` | Data transfer process: mode, filters, filter routines, semantic groups | ✔ | create, update, delete |
| `RSDS` | DataSource: fields, delta | ✔ | create, update, delete |
| `LSYS` | Source system and its entities | ✔ | – |
| `RSPC` | Process chain: steps, decisions, scheduling; settings of each process variant | ✔ | create, update, delete |
| `QUERY` | Query: layout, filter, members, characteristics, settings, cells, roles | ✔ | create, update, delete |
| `VARIABLE`, `CKF`, `RKF`, `STRUCTURE` | Query components | ✔ | create, update, delete |
| `ALVL`, `FILTER`, `PLSE`, `PLSQ` | Aggregation level, planning filter, planning function, planning sequence | ✔ | create, update, delete |
| `HIER` | Hierarchy of a characteristic (`<characteristic>/<hierarchy>`) | ✔ | create, update, delete |
| `DEST` | Open Hub destination | ✔ | delete |
| `ROLE` | Roles and the queries published in them | ✔ | via the query (`roles_add`, `roles_remove`) |

coBWeb is developed and tested on SAP BW/4HANA 2.0 and later. The platform is detected at
start; classic BW 7.5 on HANA is recognized but not supported.

## Setup

Requirements: Node.js 22 or later; a BW/4HANA system with the BW Modeling Tools services active
and a user with modeling authorization.

```bash
git clone https://github.com/oliverluette/coBWeb-mcp.git
cd coBWeb-mcp
npm install
npm run build
```

### Configuration

All settings are environment variables of the server process.

Connection:

| Variable | Meaning |
|---|---|
| `BW_URL` | base URL of the BW system, e.g. `https://bw.example.com:44300` |
| `BW_USER`, `BW_PASSWORD` | logon (basic authentication) |
| `BW_CLIENT` | client, default `001` |
| `BW_COOKIE_FILE` | instead of user and password: cookies of a browser session (e.g. SAML) |
| `BW_PLATFORM` | `auto` (default) or `bw4` |

Tools and safety (all optional; without flags the server is read-only):

| Variable | Default | Meaning |
|---|---|---|
| `COBWEB_PROFILE` | `modeling` | tool set: `modeling`, `analysis`, `operations` or `full` |
| `COBWEB_TOOLS` | – | explicit tool list, overrides the profile |
| `COBWEB_TYPES` | all | allowed object types, e.g. `AREA,IOBJ,ADSO` |
| `COBWEB_ALLOW_WRITES` | `false` | create, change, delete, activate, transports, unlock |
| `COBWEB_ALLOW_DATA` | `false` | read business data (`bw_data`) |
| `COBWEB_ALLOW_EXECUTE` | `false` | runtime actions (`bw_run`) |
| `COBWEB_ALLOWED_PACKAGES` | `$TMP` | packages writes may go to; patterns with `*`, e.g. `$*,Z*` |
| `COBWEB_ALLOWED_INFOAREAS` | `*` | InfoAreas objects may be created in or changed |
| `COBWEB_DENY_ACTIONS` | – | single actions to refuse, e.g. `bw_write.delete,bw_run.delete_request` |
| `COBWEB_MAX_RESULT_CHARS` | `20000` | upper bound of every tool result |
| `COBWEB_AUDIT_FILE` | – | file for the audit log (one JSON line per written object) |
| `COBWEB_LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` (stderr) |

Profiles:

| Profile | Tools |
|---|---|
| `modeling` | search, read, context, describe, write, activate, transport, system |
| `analysis` | search, read, context, data |
| `operations` | search, read, monitor, run, system |
| `full` | all eleven |

Tools that a profile or the flags leave out are not offered at all, so the model never sees
them. `bw_system(action="profile")` shows the active settings.

### Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cobweb": {
      "command": "node",
      "args": ["/path/to/coBWeb-mcp/dist/transport/stdio.js"],
      "env": {
        "BW_URL": "https://…",
        "BW_USER": "…",
        "BW_PASSWORD": "…",
        "BW_CLIENT": "001",
        "COBWEB_PROFILE": "modeling",
        "COBWEB_ALLOW_WRITES": "true"
      }
    }
  }
}
```

Restart Claude Desktop after a change.

### Claude Code

```bash
claude mcp add cobweb --env BW_URL=https://… --env BW_USER=… --env BW_PASSWORD=… --env BW_CLIENT=001 \
  -- node /path/to/coBWeb-mcp/dist/transport/stdio.js
```

### Other MCP hosts

Any host that starts stdio servers works: command `node`, argument
`dist/transport/stdio.js`, and the environment variables above.

## Development

| Command | Purpose |
|---|---|
| `npm run build` | compile TypeScript to `dist/` |
| `npm run typecheck` | type check without output |
| `node scripts/tools-list.mjs [profile]` | print the tool list a profile offers (JSON) |
| `node scripts/dev-reload.mjs` | development launcher: runs the server as a child and restarts it before the next tool call when `dist/` changed |

For development, point the host's `args` at `scripts/dev-reload.mjs` instead of
`dist/transport/stdio.js`; a new build then takes effect without restarting the host. A changed
tool list is announced with `notifications/tools/list_changed`; hosts that do not read it again
need a restart for that.

How the server is built: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Origin

coBWeb started as a fork of [bw-modeling-mcp](https://github.com/dnic-dev/bw-modeling-mcp)
(MIT License). It keeps that project's BW client and its write, reporting and runtime paths
for the BW REST services (`src/legacy/`, parts of `src/bw/`), changed where needed; the tool
design, object adapters, write engine and policy are new. The details are in [NOTICE](NOTICE).

## License

MIT, see [LICENSE](LICENSE). Third-party parts: see [NOTICE](NOTICE).
