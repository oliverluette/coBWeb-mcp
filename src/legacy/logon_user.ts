// Based on bw-modeling-mcp (https://github.com/dnic-dev/bw-modeling-mcp),
// Copyright (c) 2026 dnic-dev, MIT License (see NOTICE).
// Kept close to the original on purpose: the proven runtime, reporting and transport paths.
// Changes for coBWeb are marked "coBWeb:". The tools in src/tools/runtime.ts call into this module.

import { BwClient } from '../bw/client.js';
import { queryTable } from './metadata_sql.js';

const resolved = new WeakMap<BwClient, Promise<string>>();

/**
 * The user the backend sees for this client, for the `responsible` of a new object.
 *
 * BW_USER only exists with basic authentication. Behind a BTP destination — principal
 * propagation or a technical user — it is unset, and a create that writes an empty
 * `adtcore:responsible` is refused for some object types (a transformation answers
 * "model deserialization failed"), while others accept it. So the name is asked from the
 * system: the ADT system information carries it on BW/4HANA, and `sy-uname` through ADT
 * DataPreview covers a classic release, where that resource does not exist. Resolved once
 * per client, because under principal propagation every user has a client of their own.
 */
export function resolveLogonUser(client: BwClient): Promise<string> {
  const configured = process.env.BW_USER?.trim();
  if (configured) return Promise.resolve(configured.toUpperCase());
  let pending = resolved.get(client);
  if (!pending) {
    pending = lookUpLogonUser(client);
    resolved.set(client, pending);
  }
  return pending;
}

async function lookUpLogonUser(client: BwClient): Promise<string> {
  try {
    const { body } = await client.rawGet('/sap/bc/adt/core/http/systeminformation', {
      Accept: 'application/vnd.sap.adt.core.http.systeminformation.v1+json',
    });
    const name = (JSON.parse(body) as { userName?: unknown }).userName;
    if (typeof name === 'string' && name.trim()) return name.trim().toUpperCase();
  } catch {
    // Not published on a classic release; fall through to DataPreview.
  }
  try {
    const rows = await queryTable(client, 'SELECT bname FROM usr01 WHERE bname = @sy-uname', 1);
    const name = rows[0]?.BNAME?.trim();
    if (name) return name.toUpperCase();
  } catch {
    // No DataPreview access either.
  }
  return '';
}
