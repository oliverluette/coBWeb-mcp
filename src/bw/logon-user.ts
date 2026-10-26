/**
 * The user BW sees for a client, written as the responsible of new objects.
 *
 * BW_USER is set only with user and password. With a cookie file it is not, and a create with
 * an empty responsible is refused for some types (a transformation fails with "model
 * deserialization failed"). The name then comes from the ADT system information, once per client.
 */
import type { BwClient } from './client.js';

const cache = new WeakMap<BwClient, Promise<string>>();

export function logonUser(client: BwClient): Promise<string> {
  const configured = process.env.BW_USER?.trim();
  if (configured) return Promise.resolve(configured.toUpperCase());
  let pending = cache.get(client);
  if (!pending) {
    pending = askSystem(client);
    cache.set(client, pending);
  }
  return pending;
}

async function askSystem(client: BwClient): Promise<string> {
  try {
    const { body } = await client.rawGet('/sap/bc/adt/core/http/systeminformation', {
      Accept: 'application/vnd.sap.adt.core.http.systeminformation.v1+json',
    });
    const name = (JSON.parse(body) as { userName?: unknown }).userName;
    return typeof name === 'string' ? name.trim().toUpperCase() : '';
  } catch {
    return '';
  }
}
