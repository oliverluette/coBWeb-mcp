# Changelog

All notable changes to coBWeb. Versions follow [Semantic Versioning](https://semver.org/).

## 1.1.0 – 2026-11-04

### Added

- **Structured results for programs** (`COBWEB_STRUCTURED=true`, off by default). `bw_search`,
  `bw_read`, `bw_context` and `bw_system` then offer an `outputSchema` and answer with
  `structuredContent` next to the unchanged text: data flow and where-used as objects and edges
  with stable references, search hits with counts, the system profile, CompositeProviders,
  transformations, DTPs and object heads. Errors and text-only answers have their own envelope,
  so every answer matches the schema. The size limit applies to the text only. Details:
  [docs/TOOLS.md](docs/TOOLS.md#structured-results-cobweb_structuredtrue).
- `bw_read` with `part="head"` returns only the head line of an ADSO, InfoObject, DataSource or
  InfoSource.

### Unchanged

- Without `COBWEB_STRUCTURED` the tool list and every answer are the same as in 1.0.0.

## 1.0.0 – 2026-10-26

First public release.

- Eleven intent-based tools (`bw_search`, `bw_read`, `bw_context`, `bw_describe`, `bw_write`,
  `bw_activate`, `bw_data`, `bw_monitor`, `bw_run`, `bw_transport`, `bw_system`) and the
  profiles `modeling`, `analysis`, `operations` and `full`.
- Reading and writing of InfoAreas, InfoObjects, DataStore objects, CompositeProviders,
  InfoSources, transformations, DTPs, DataSources, process chains, queries and their components,
  planning objects and hierarchies; see the README for the full list.
- Read-only without flags; writes, data access and runtime actions are switched on separately
  and limited to allowed packages and InfoAreas.
