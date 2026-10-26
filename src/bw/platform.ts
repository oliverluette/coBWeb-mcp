// Based on bw-modeling-mcp (https://github.com/dnic-dev/bw-modeling-mcp),
// Copyright (c) 2026 dnic-dev, MIT License (see NOTICE). Changes for coBWeb are marked "coBWeb:".

/**
 * Platform detection and platform-dependent tool filtering.
 *
 * One instance of this server fronts exactly one BW system, and that system is either
 * BW/4HANA or a classic release (7.5 and below). The two do not publish the same APIs:
 * transformations, DTPs and process chains have no REST resource on classic, and the whole
 * BW/4HANA family outside `/sap/bw/modeling` — the manage API behind the request monitor,
 * push, process variants, the monitoring OData services — does not exist there at all.
 *
 * Without this module the model saw the full BW/4HANA surface on a classic system, called
 * those tools first because their descriptions promise they work, and got an ICF HTTP 404
 * back. A hint in the prompt does not compete with a tool list, so the tool list is what
 * this module corrects: what a system cannot do is not offered.
 *
 * Availability is derived from the system itself wherever the system states it — the
 * discovery document lists the collections it publishes, so a tool that needs `trfn` is
 * offered exactly where `trfn` is published. Two things discovery cannot answer, and both
 * fall back to the platform verdict:
 *
 *   - APIs outside `/sap/bw/modeling` (the `/sap/bw4/…` paths, the OData services). They
 *     are not in the document, so their absence cannot be read from it.
 *   - Everything, when discovery itself could not be read.
 *
 * The scope filter in scopes.ts is independent of this and stays untouched: scopes decide
 * what a caller may invoke, this decides what the system can answer. A read-only caller on
 * a classic system sees the intersection.
 */
import type { BwClient } from './client.js'; // coBWeb: renamed from bw-client.js

export type Platform = 'bw4' | 'classic';

export interface PlatformProfile {
  platform: Platform;
  /**
   * Collection keys published by the discovery document (last path segment of each href),
   * lower case. Empty when discovery could not be read — then the platform verdict alone
   * decides, and collection-based checks fall back to the static catalog.
   */
  collections: Set<string>;
  /** Did detection actually succeed, or is this the fail-open default? */
  detected: boolean;
  /**
   * Is the platform filter active at all? `BW_PLATFORM=bw4` turns it off outright — the
   * deliberate escape hatch for an operator who needs a tool this module misjudges, which
   * no amount of care in the catalog below makes unnecessary.
   */
  filterEnabled: boolean;
  /** Where the verdict came from, for `bw_system_profile` and the log. */
  source: 'systeminfo' | 'discovery' | 'env' | 'fallback';
  /** One line explaining the verdict, shown by `bw_system_profile`. */
  detail: string;
}

// ── Detection ────────────────────────────────────────────────────────────────

/** `bw.b4hanamode = STRICT` is BW/4HANA; `STANDARD` (or absent) is a classic release. */
export function platformFromSystemInfo(props: Record<string, string>): Platform {
  return (props['bw.b4hanamode'] ?? '').toUpperCase() === 'STRICT' ? 'bw4' : 'classic';
}

export function parseSysProps(xml: string): Record<string, string> {
  const props: Record<string, string> = {};
  const re = /<sysInfo:property\s+name="([^"]+)"\s+value="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) props[m[1]] = m[2];
  return props;
}

/**
 * Collection keys published by the discovery document, mapped to the versioned XML media
 * type the system serves for them. The media type is needed to probe with a version this
 * system actually accepts — probing with a hardcoded one draws an HTTP 415 on any system
 * that has moved on.
 */
export function parseDiscoveryCollections(xml: string): Map<string, string | undefined> {
  const collections = new Map<string, string | undefined>();
  for (const segment of xml.split(/(?=<app:collection\s)/)) {
    const href = segment.match(/^<app:collection\b[^>]*?\shref="([^"]+)"/)?.[1];
    if (!href) continue;
    const key = href.split('/').pop()?.toLowerCase();
    if (!key) continue;
    const versioned = [...segment.matchAll(/<app:accept>([^<]+)<\/app:accept>/g)]
      .map((a) => a[1].trim())
      .find((mt) => /-v\d+_\d+_\d+\+xml$/.test(mt));
    if (!collections.has(key) || versioned) collections.set(key, versioned);
  }
  return collections;
}

/** `BW_PLATFORM=auto|bw4|classic`, `auto` being the default. */
function configuredPlatform(): Platform | undefined {
  const raw = (process.env.BW_PLATFORM ?? 'auto').trim().toLowerCase();
  if (raw === 'bw4' || raw === 'classic') return raw;
  return undefined;
}

/** Fail open: an undetectable system gets the full surface, never an empty one. */
function fallbackProfile(detail: string): PlatformProfile {
  return {
    platform: configuredPlatform() ?? 'bw4',
    collections: new Set(),
    detected: false,
    filterEnabled: configuredPlatform() !== 'bw4',
    source: configuredPlatform() ? 'env' : 'fallback',
    detail,
  };
}

/**
 * Upper bound on detection. Two GETs sit in front of the first tool call and of the stdio
 * handshake, and axios has no timeout of its own: an unreachable host would otherwise hold
 * both for as long as the OS takes to give up on the connection.
 */
const DETECT_TIMEOUT_MS = 15_000;

let detection: Promise<PlatformProfile> | null = null;
let cached: PlatformProfile | null = null;

/**
 * Detect the platform once per process and cache it.
 *
 * Module level rather than per server: the HTTP transport builds a fresh `Server` for every
 * request (http.ts), so anything held by `createServer()` would be re-detected on each call.
 * The platform of an instance cannot change while the process runs, and both reads are
 * read-only system metadata, identical for every caller — under principal propagation the
 * first caller's client happens to run them, which is unproblematic for that reason.
 *
 * Cleared on failure, like the media type discovery: one transient error during the first
 * request must not fix a wrong verdict for the life of the process.
 */
export function ensurePlatform(client: BwClient): Promise<PlatformProfile> {
  if (!detection) {
    let timer: NodeJS.Timeout;
    const bounded = new Promise<PlatformProfile>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${DETECT_TIMEOUT_MS} ms`)), DETECT_TIMEOUT_MS);
      timer.unref?.();
    });
    detection = Promise.race([detect(client), bounded])
      .finally(() => clearTimeout(timer))
      .then((profile) => {
        cached = profile;
        return profile;
      })
      .catch((err) => {
        detection = null;
        const profile = fallbackProfile(`detection failed (${err}) — full tool surface offered`);
        cached = profile;
        process.stderr.write(
          `[cobweb] Warning: platform detection failed (${err}); offering the full ` +
            `tool surface. Set BW_PLATFORM=classic if this system is a classic BW release.\n`,
        );
        return profile;
      });
  }
  return detection;
}

/** The cached verdict, or undefined before the first detection. Never triggers a call. */
export function cachedPlatform(): PlatformProfile | undefined {
  return cached ?? undefined;
}

/** Test seam: drop the cache so a test can detect against another system in-process. */
export function resetPlatformCache(): void {
  detection = null;
  cached = null;
}

async function detect(client: BwClient): Promise<PlatformProfile> {
  const forced = configuredPlatform();

  const [sysinfo, discovery] = await Promise.allSettled([
    client.get('/sap/bw/modeling/repo/is/systeminfo', 'application/xml'),
    client.get('/sap/bw/modeling/discovery', 'application/atomsvc+xml'),
  ]);

  const collections =
    discovery.status === 'fulfilled'
      ? new Set(parseDiscoveryCollections(discovery.value.body).keys())
      : new Set<string>();

  if (sysinfo.status === 'rejected' && collections.size === 0) {
    throw sysinfo.reason;
  }

  // systeminfo states the platform outright; discovery only corroborates it. `trfn` is the
  // discriminator there: no classic release publishes it, and no BW/4HANA system omits it.
  const fromSysInfo =
    sysinfo.status === 'fulfilled'
      ? platformFromSystemInfo(parseSysProps(sysinfo.value.body))
      : undefined;
  const fromDiscovery: Platform | undefined =
    collections.size > 0 ? (collections.has('trfn') ? 'bw4' : 'classic') : undefined;

  const detectedPlatform = fromSysInfo ?? fromDiscovery!;
  const agreement =
    fromSysInfo && fromDiscovery && fromSysInfo !== fromDiscovery
      ? ` (discovery suggests ${fromDiscovery}; going with b4hanamode)`
      : '';

  const platform = forced ?? detectedPlatform;
  const overridden = forced && forced !== detectedPlatform ? ` — BW_PLATFORM=${forced} overrides` : '';

  return {
    platform,
    collections,
    detected: true,
    filterEnabled: forced !== 'bw4',
    source: forced ? 'env' : fromSysInfo ? 'systeminfo' : 'discovery',
    detail:
      `${platform === 'bw4' ? 'SAP BW/4HANA' : 'classic SAP BW (7.5 or lower)'}, from ` +
      `${fromSysInfo ? 'bw.b4hanamode' : 'the published collections'}${agreement}${overridden}` +
      ` — ${collections.size} collections published` +
      `${forced === 'bw4' ? '; platform filtering off (BW_PLATFORM=bw4)' : ''}`,
  };
}
