/** Activation through the legacy path, which knows the retries and session rules per type. */
import type { BwClient } from '../bw/client.js';
import { bwActivate } from '../legacy/activation.js';
import type { ActivationResult } from './write.js';

export async function activateObject(
  client: BwClient,
  type: string,
  name: string,
  lockHandle: string,
  transport?: string,
  sourceSystem?: string,
): Promise<ActivationResult> {
  const r = JSON.parse(await bwActivate(client, type, name.toLowerCase(), lockHandle, transport, sourceSystem)) as {
    success?: boolean;
    message?: string;
    messages?: string[];
    dtps_deactivated_by_impact_analysis?: string[];
  };
  return {
    ok: r.success === true,
    messages: r.messages ?? (r.message ? [r.message] : []),
    deactivated: r.dtps_deactivated_by_impact_analysis ?? [],
  };
}
