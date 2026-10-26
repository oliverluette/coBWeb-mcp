// Based on bw-modeling-mcp (https://github.com/dnic-dev/bw-modeling-mcp),
// Copyright (c) 2026 dnic-dev, MIT License (see NOTICE).
// Kept close to the original on purpose: the proven runtime, reporting and transport paths.
// Changes for coBWeb are marked "coBWeb:". The tools in src/tools/runtime.ts call into this module.

import { BwClient } from '../bw/client.js';
import { bwGetDatasource } from './datasource.js';

export interface ChangePackageArgs {
  objectName: string;
  objectType: string;
  package: string;
  transport?: string;
  sourceSystem?: string;
}

const CTO_MEDIA_TYPE = 'application/vnd.sap.bw.modeling.cto-v1_1_0+xml';

/**
 * Build the transport object name (TADIR OBJ_NAME) for a CTO write.
 *
 * Most TLOGO types use the plain uppercase technical name. RSDS (DataSource) is the
 * exception: its key is compound, and TADIR stores it as the DataSource name padded to
 * 30 characters followed by the source system (source system at offset 31). Passing the
 * bare DataSource name — or the name with a single space before the source system —
 * produces an orphan TADIR entry that cto/write happily reports as written while the real
 * DataSource's package stays empty. See payloads/change_package.md and the RSDS notes.
 */
function buildTransportName(typeUpper: string, nameUpper: string, sourceSystemUpper?: string): string {
  if (typeUpper === 'RSDS') {
    return `${nameUpper.padEnd(30, ' ')}${sourceSystemUpper ?? ''}`;
  }
  return nameUpper;
}

/**
 * bw_change_package — reassign an object to a package and record it on a transport.
 * Endpoint, body and response shape: see payloads/change_package.md.
 *
 * Does not lock, does not activate, and does not change the object version. This is a pure
 * TADIR/transport assignment (operation="I"): the object stays in its current state (an
 * active object remains active), so no re-activation is required. Verified for ADSO, TRFN
 * and DTPA. Re-activating a TRFN here would be not just unnecessary but risky — an
 * activation with a stale lock can regenerate the AMDP method body.
 */
export async function bwChangePackage(
  client: BwClient,
  args: ChangePackageArgs
): Promise<string> {
  const nameUpper = args.objectName.toUpperCase();
  const typeUpper = args.objectType.toUpperCase();
  const sourceSystemUpper = args.sourceSystem?.toUpperCase();

  // RSDS (DataSource) has a compound key — the source system is mandatory, mirroring
  // bw_activate's handling of object_type "rsds".
  if (typeUpper === 'RSDS' && !sourceSystemUpper) {
    return JSON.stringify(
      {
        success: false,
        object_name: nameUpper,
        object_type: typeUpper,
        message:
          'object_type "RSDS" requires source_system (a DataSource is identified by DataSource name plus source system).',
      },
      null,
      2
    );
  }

  const transportName = buildTransportName(typeUpper, nameUpper, sourceSystemUpper);

  const params = new URLSearchParams();
  // Transport param is "corrnum" on this endpoint, not "corrNr" (see payload doc).
  if (args.transport) {
    params.set('corrnum', args.transport);
  }
  params.set('package', args.package);
  params.set('simulate', 'false');
  params.set('allmsgs', 'true');

  const path = `/sap/bw/modeling/cto/write?${params.toString()}`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bwCTO:transport xmlns:bwCTO="http://www.sap.com/bw/cto"><objects><object name="${transportName}" altName="${nameUpper}" isTransportName="true" type="${typeUpper}" pgmid="R3TR" operation="I" genflag=""></object></objects></bwCTO:transport>`;

  const response = await client.postRaw(path, xml, CTO_MEDIA_TYPE);

  const writeResultMatch = response.match(/writeResult="([^"]*)"/);
  const writeResult = writeResultMatch ? writeResultMatch[1] : '';
  const writeOk = writeResult === 'S';

  const messages: Array<{ text: string; type: string }> = [];
  const msgRegex = /<message\b[^>]*\btxt="([^"]*)"[^>]*\btype="([^"]*)"[^>]*\/?>/g;
  let mm: RegExpExecArray | null;
  while ((mm = msgRegex.exec(response)) !== null) {
    messages.push({ text: mm[1], type: mm[2] });
  }
  const hasErrorMessage = messages.some((m) => m.type === 'E');

  // writeResult="S" alone is not proof the package was applied to the real object:
  // a wrong key (notably a mis-built RSDS key) produces an orphan TADIR entry that
  // still reports success. Verify by re-reading the object and confirming the package
  // actually landed. The re-read is type-specific, so currently only RSDS is verified.
  let verifiedPackage: string | null = null;
  let resolved: boolean | null = null;
  if (writeOk && typeUpper === 'RSDS') {
    try {
      const raw = await bwGetDatasource(client, nameUpper, sourceSystemUpper!, 'raw');
      verifiedPackage =
        raw.match(/<adtcore:packageRef\b[\s\S]*?\badtcore:name="([^"]*)"/)?.[1]?.trim() || '';
      resolved = verifiedPackage.toUpperCase() === args.package.toUpperCase();
    } catch {
      // The DataSource key did not resolve to an existing object at all.
      resolved = false;
      verifiedPackage = '';
    }
  }

  const success = writeOk && !hasErrorMessage && resolved !== false;

  const result: Record<string, unknown> = {
    success,
    object_name: nameUpper,
    object_type: typeUpper,
    package: args.package,
    transport: args.transport ?? null,
    write_result: writeResult,
  };
  if (sourceSystemUpper) {
    result['source_system'] = sourceSystemUpper;
  }
  if (messages.length > 0) {
    result['messages'] = messages;
  }

  if (writeOk && resolved === false) {
    // The endpoint reported success but the package never reached the real object.
    result['verified_package'] = verifiedPackage;
    result['message'] =
      typeUpper === 'RSDS'
        ? `cto/write returned writeResult="S" but the DataSource "${nameUpper}" / source system "${sourceSystemUpper}" still has package "${verifiedPackage}". ` +
          'The transport key likely did not resolve to the real DataSource (an orphan TADIR entry may have been created). ' +
          'No package change was applied — assign the package manually via RSA1 and remove any orphan entry from the transport.'
        : `cto/write returned writeResult="S" but the package was not applied to "${nameUpper}".`;
  } else if (success) {
    if (verifiedPackage !== null) {
      result['verified_package'] = verifiedPackage;
    }
    result['next_step'] =
      'Object remains active — a package/transport reassignment does not change the object ' +
      'version, so no re-activation is required. Do not re-activate a TRFN here: an ' +
      'activation with a stale lock can regenerate the AMDP method body.';
  }

  return JSON.stringify(result, null, 2);
}

export interface ListChangeableTransportsArgs {
  ownOnly: boolean;
  modifiableOnly: boolean;
  includeObjects: boolean;
}

function ctoAttr(attrs: string, name: string): string {
  return attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '';
}

/**
 * bw_list_changeable_transports — list transport requests via cto/check.
 * Endpoint, query params and response shape: see payloads/list_changeable_transports.md.
 */
export async function bwListChangeableTransports(
  client: BwClient,
  args: ListChangeableTransportsArgs
): Promise<string> {
  const path =
    `/sap/bw/modeling/cto/check?rddetails=all&rdprops=true` +
    `&ownonly=${args.ownOnly ? 'true' : 'false'}&allmsgs=true`;

  const { body } = await client.rawGet(path, { Accept: CTO_MEDIA_TYPE });

  // System changeability flags.
  const properties: Record<string, string> = {};
  const propRe = /<property\b([^>]*)\/>/g;
  let pm: RegExpExecArray | null;
  while ((pm = propRe.exec(body)) !== null) {
    const n = ctoAttr(pm[1], 'name');
    if (n) properties[n] = ctoAttr(pm[1], 'value');
  }

  // Requests, each with nested tasks and (optionally) objects.
  const requests: Array<Record<string, unknown>> = [];
  const reqRe = /<request\b([^>]*?)(?:\/>|>([\s\S]*?)<\/request>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = reqRe.exec(body)) !== null) {
    const reqAttrs = rm[1];
    const reqInner = rm[2] ?? '';
    const status = ctoAttr(reqAttrs, 'status');
    if (args.modifiableOnly && status !== 'D') continue;

    const tasks: Array<Record<string, unknown>> = [];
    const taskRe = /<task\b([^>]*?)(?:\/>|>([\s\S]*?)<\/task>)/g;
    let tm: RegExpExecArray | null;
    while ((tm = taskRe.exec(reqInner)) !== null) {
      const taskAttrs = tm[1];
      const taskInner = tm[2] ?? '';
      const task: Record<string, unknown> = {
        corrnum: ctoAttr(taskAttrs, 'corrnum'),
        owner: ctoAttr(taskAttrs, 'user'),
        function: ctoAttr(taskAttrs, 'function'),
        status: ctoAttr(taskAttrs, 'status'),
      };
      if (args.includeObjects) {
        const objects: Array<Record<string, unknown>> = [];
        const objRe = /<object\b([^>]*)\/>/g;
        let om: RegExpExecArray | null;
        while ((om = objRe.exec(taskInner)) !== null) {
          objects.push({
            pgmid: ctoAttr(om[1], 'pgmid'),
            type: ctoAttr(om[1], 'type'),
            name: ctoAttr(om[1], 'name'),
            locked: ctoAttr(om[1], 'locked') === 'true',
          });
        }
        task['objects'] = objects;
      }
      tasks.push(task);
    }

    requests.push({
      corrnum: ctoAttr(reqAttrs, 'corrnum'),
      text: ctoAttr(reqAttrs, 'txt'),
      owner: ctoAttr(reqAttrs, 'user'),
      function: ctoAttr(reqAttrs, 'function'),
      status,
      status_label: status === 'D' ? 'modifiable' : status === 'R' ? 'released' : status,
      target: ctoAttr(reqAttrs, 'target'),
      date: ctoAttr(reqAttrs, 'date'),
      time: ctoAttr(reqAttrs, 'time'),
      tasks,
    });
  }

  // coBWeb: text, one line per request and per task.
  const day = (d: unknown) => (/^\d{8}$/.test(String(d)) ? `${String(d).slice(0, 4)}-${String(d).slice(4, 6)}-${String(d).slice(6)}` : String(d ?? ''));
  const lines = [
    `Transport requests: ${requests.length}${properties['transportsChangeable'] === 'true' ? '' : ' · transports are not changeable in this system'}${properties['bwChangeable'] === 'true' ? '' : ' · BW objects are not changeable'}`,
  ];
  for (const r of requests) {
    lines.push(`  ${r['corrnum']}  ${r['status_label']}  ${r['owner']}  ${day(r['date'])}  "${r['text']}"${r['target'] ? `  → ${r['target']}` : ''}`);
    for (const t of r['tasks'] as Array<Record<string, unknown>>) {
      lines.push(`    task ${t['corrnum']}  ${t['owner']}${t['status'] !== 'D' ? `  ${t['status'] === 'R' ? 'released' : t['status']}` : ''}`);
      for (const o of (t['objects'] as Array<Record<string, unknown>> | undefined) ?? []) lines.push(`      ${o['pgmid']} ${o['type']} ${o['name']}${o['locked'] ? '  (locked)' : ''}`);
    }
  }
  return lines.join('\n');
}
