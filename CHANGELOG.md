# Changelog

All notable changes to coBWeb. Versions follow [Semantic Versioning](https://semver.org/).

## 1.2.0 – 2026-11-05

### Added

- **Reference characteristics:** `reference` in the IOBJ create spec. Type, length,
  conversion, master data and texts come from the referenced characteristic, which must be
  active or created in the same call; conflicting properties are refused before writing.
  `bw_read` shows the reference. The reference cannot change later.
- **Text types:** `texts` also takes `{short, medium, long, language_dependent}`; `texts: true`
  stays short texts only. The language dependency is always written explicitly. An update can
  change the text types as far as BW allows. `bw_read` shows the text types.
- **Description in queries:** `description_display` (`short` | `long`) and
  `short_description` (max 20 characters) for characteristics and key figures, on create and
  update. BW stores the choice in TXTDEF (`bexDescription` 0 = short, 1 = long).
- **Moving to another InfoArea:** an update with `info_area` moves an InfoObject, DataStore
  object or CompositeProvider; the object stays active. The target InfoArea must be allowed.
- **Checks before writing** (`validate_only` and every write): currencies against TCURC,
  units against T006, the key rules of the ADSO presets and whether an ADSO can be an input of
  a CompositeProvider. `bw_describe(type="ADSO")` lists the rules per preset:
  key required for `standard`, `staging_compress`, `staging_reporting`; no key for
  `staging_inbound_only`, `datamart`; optional for `direct_update`; not an input of a
  CompositeProvider: `staging_inbound_only`, `staging_compress`.
- `bw_describe(type="QUERY")` documents the text type of a characteristic
  (`characteristics[].text`); `bw_read` shows display and text type in the layout.
- `bw_data`: date values of variables given as YYYYMMDD or YYYY-MM-DD are converted to the logon
  user's date format; values BW does not accept are reported as an input error with the formats
  it takes, not as a backend error.

### Changed

- `texts: true` now writes `languageDependentTextAvailable="false"` explicitly (before, BW kept
  its own value).
- A standard, compressing or reporting staging ADSO without key, and an inbound-only staging or
  data mart ADSO with key, are refused before writing instead of failing on activation.

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
