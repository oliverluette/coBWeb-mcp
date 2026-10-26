// Based on bw-modeling-mcp (https://github.com/dnic-dev/bw-modeling-mcp),
// Copyright (c) 2026 dnic-dev, MIT License (see NOTICE).
// Kept close to the original on purpose: the proven runtime, reporting and transport paths.
// Changes for coBWeb are marked "coBWeb:". The tools in src/tools/runtime.ts call into this module.

import { BwClient, bwSeg } from '../bw/client.js';

const MONITORING = '/sap/bc/http/sap/bw4/v1/monitoring';
const POLL_INTERVAL_MS = 5000;
export const MAX_WAIT_SECONDS = 600;

export interface ChainRunStatus {
  processChain: string;
  logid: string;
  status: string;
  statusType: string;
  manuallyAborted: boolean;
  messages: { severity: string; text: string; id: string }[];
}

export function parseStartResponse(body: string): { processChain: string; logid: string } {
  let parsed: { processChain?: string; logid?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`The start was accepted but the answer carries no run: ${body.slice(0, 300)}`);
  }
  if (!parsed.logid) throw new Error(`The start was accepted but the answer names no log ID: ${body.slice(0, 300)}`);
  return { processChain: parsed.processChain ?? '', logid: parsed.logid };
}

export function parseRunStatus(body: string): ChainRunStatus {
  const j = JSON.parse(body) as {
    processChain?: string; logid?: string; status?: string; statusType?: string;
    manuallyAborted?: boolean;
    aMsg?: { severity?: string; text?: string; class?: string; number?: string }[];
  };
  return {
    processChain: j.processChain ?? '',
    logid: j.logid ?? '',
    status: j.status ?? '',
    statusType: j.statusType ?? '',
    manuallyAborted: j.manuallyAborted === true,
    messages: (j.aMsg ?? []).map((m) => ({
      severity: m.severity ?? '',
      text: m.text ?? '',
      id: `${m.class ?? ''}${m.number ?? ''}`,
    })),
  };
}

export function isRunning(s: ChainRunStatus): boolean {
  return s.statusType.toUpperCase() === 'ACTIVE';
}

async function readStatus(client: BwClient, logid: string, query: string): Promise<ChainRunStatus> {
  const res = await client.rawGet(`${MONITORING}/processchainlogs/${bwSeg(logid)}/status${query}`, {
    Accept: '*/*',
    'X-Requested-With': 'XMLHttpRequest',
  });
  return parseRunStatus(res.body);
}

/**
 * Start a process chain once, now, as the BW/4HANA Cockpit does with "Execute" →
 * "Asynchronous": the run goes to the background under the chain's technical user, and its
 * scheduling is left as it is.
 *
 * The synchronous variant of the same resource is not offered. It runs the chain inside the
 * HTTP work process, where an abort message of a step cannot be shown: the request ends in
 * HTTP 500 and the run is left reading "active" in the monitor.
 *
 * The answer to the start is JSON labelled text/html, so it is parsed from the body rather
 * than trusted by its content type.
 */
export async function bwStartProcessChain(
  client: BwClient,
  name: string,
  waitSeconds = 0,
): Promise<string> {
  if (!name?.trim()) throw new Error('name is required');
  const chain = name.trim().toUpperCase();
  const wait = Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(waitSeconds)));

  client.clearCsrfToken();
  const csrf = await client.getCsrfToken();
  const res = await client
    // An empty Buffer, not '': axios serialises an empty string under a JSON content type as
    // `""`, and the handler reads any body as a callback target ("no HTTP destination found").
    .rawPost(`${MONITORING}/processchains/${bwSeg(chain)}/start`, Buffer.alloc(0), {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'x-csrf-token': csrf,
      'X-Requested-With': 'XMLHttpRequest',
    })
    .catch((err: Error) => {
      throw new Error(`Start process chain '${chain}': ${err.message}`);
    });
  client.clearCsrfToken();
  const { logid } = parseStartResponse(res.body);

  let status = await readStatus(client, logid, '?nopoll=true&noupdate=true');
  const started = Date.now();
  while (wait > 0 && isRunning(status) && Date.now() - started < wait * 1000) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    status = await readStatus(client, logid, '');
  }
  return formatStartResult(chain, logid, status, wait, Math.round((Date.now() - started) / 1000));
}

export function formatStartResult(
  chain: string,
  logid: string,
  status: ChainRunStatus,
  waitSeconds: number,
  waitedSeconds: number,
): string {
  const lines = [
    `Process chain ${chain} started (asynchronous, in the background).`,
    `Log ID: ${logid}`,
    `Status: ${status.status} (${status.statusType})${status.manuallyAborted ? ', aborted manually' : ''}`,
  ];
  if (waitSeconds > 0) {
    lines.push(
      isRunning(status)
        ? `Still running after ${waitedSeconds} s of the ${waitSeconds} s waited.`
        : `Finished within ${waitedSeconds} s.`,
    );
  }
  // RSPC 009 as a warning is a step the run has not reached yet ("status undefined"); listing
  // every one of them buries the step that matters.
  const relevant = status.messages.filter((m) => !(m.id === 'RSPC009' && m.severity === 'W'));
  if (relevant.length > 0) {
    lines.push('', 'Messages:');
    for (const m of relevant) lines.push(`  ${m.severity} ${m.text}`);
  }
  lines.push(
    '',
    `Step details: bw_monitor(what="chain_run", name="${chain}", id="${logid}").`,
  );
  if (isRunning(status)) {
    lines.push('The run continues in the background; follow it with bw_monitor(what="chain_run" or "chain_status").');
  }
  return lines.join('\n');
}
