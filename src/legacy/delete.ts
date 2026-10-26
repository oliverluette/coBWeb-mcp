// Based on bw-modeling-mcp (https://github.com/dnic-dev/bw-modeling-mcp),
// Copyright (c) 2026 dnic-dev, MIT License (see NOTICE).
// Kept close to the original on purpose: these are the proven write paths of the BW modeling API.
// Changes for coBWeb are marked "coBWeb:". The object adapters in src/objects/ call into this module.
import { BwClient, MEDIA_TYPES, bwSeg, bwSegUpper, lockSessionHeader } from '../bw/client.js';
import { queryAccept, queryWriteMediaType } from './query.js';
// coBWeb: conversion types follow in S4; until then their delete is refused.
async function bwDeleteConversionType(_client: BwClient, kind: string, name: string): Promise<string> {
  throw new Error(`Deleting ${kind} conversion type ${name} is not supported yet.`);
}

function parseAtomTitles(xml: string): string[] {
  return [...xml.matchAll(/<atom:title[^>]*>([^<]+)<\/atom:title>/g)].map(m => m[1]);
}

/**
 * Delete a BW Query (TLOGO ELEM). Queries do not use the generic /{type}/{name}/m
 * delete flow; the wire protocol (payloads/query_delete.md) is a dedicated
 * sequence: lock through /comp/enq (activity_context DELE), DELETE the query URL
 * with an uppercase /A path, then unlock through the lowercase query URL.
 *
 * Reusable subComponents (variables, CKFs, RKFs) referenced by the query are NOT
 * deleted — only the query (ELEM) itself.
 */
async function bwDeleteQuery(
  client: BwClient,
  objectType: string,
  objectName: string
): Promise<string> {
  const nameUpper = objectName.toUpperCase();
  const nameLower = objectName.toLowerCase();

  // 1. Lock via the enqueue endpoint (name UPPERCASE, no compuid, DELE context).
  const csrf = await client.getCsrfToken();
  const lockResponse = await client.rawPost(
    `/sap/bw/modeling/comp/enq/${bwSegUpper(nameUpper)}?action=lock`,
    '',
    {
      'activity_context': 'DELE',
      'Accept': queryAccept(),
      'x-csrf-token': csrf,
      ...lockSessionHeader(),
    });
  const lockMatch = lockResponse.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
  if (!lockMatch) {
    throw new Error(`No <LOCK_HANDLE> in query delete lock response:\n${lockResponse.body}`);
  }
  const lockHandle = lockMatch[1];

  // Unlock through the lowercase query URL (asymmetric to the lock — replicate as traced).
  const unlock = async () => {
    await client.rawPost(
      `/sap/bw/modeling/query/${bwSeg(nameLower)}/a?action=unlock`,
      '',
      { 'Accept': queryAccept(), 'x-csrf-token': await client.getCsrfToken() });
  };

  try {
    // 2. DELETE — uppercase /A path. Use the safe negotiation form for Content-Type
    //    (the traced single v1_11 fails with HTTP 415 on lower-version backends).
    const deleteResponse = await client.rawDelete(
      `/sap/bw/modeling/query/${bwSegUpper(nameUpper)}/A?lockHandle=${lockHandle}`,
      {
        'Accept': queryAccept(),
        'Content-Type': `application/xml, ${queryWriteMediaType()}`,
      });

    // Success is an empty atom feed. HTTP 200 (rawDelete throws on >= 400) is
    // success regardless of feed content, but any checkresult entry with
    // messageType="Error" is surfaced as an error.
    const messages: string[] = [];
    const errorTitles: string[] = [];
    const entryRegex = /<atom:entry>([\s\S]*?)<\/atom:entry>/g;
    let em: RegExpExecArray | null;
    while ((em = entryRegex.exec(deleteResponse.body)) !== null) {
      const entry = em[1];
      const messageType = entry.match(/messageType="([^"]*)"/)?.[1] ?? '';
      const title = entry.match(/<atom:title[^>]*>([\s\S]*?)<\/atom:title>/)?.[1]?.trim() ?? '';
      if (messageType === 'Error') errorTitles.push(title || '(no title)');
      else if (title) messages.push(title);
    }
    if (errorTitles.length > 0) {
      throw new Error(`Query deletion reported errors: ${errorTitles.join('; ')}`);
    }

    // 3. Unlock — tolerate failures with a stderr warning.
    try {
      await unlock();
    } catch (unlockErr) {
      process.stderr.write(`Warning: failed to unlock query ${nameLower} after delete: ${unlockErr}\n`);
    }

    return JSON.stringify({
      success: true,
      object_type: objectType.toUpperCase(),
      object_name: nameUpper,
      messages,
    });
  } catch (err) {
    // The lock was acquired; attempt to release it before rethrowing.
    try {
      await unlock();
    } catch (unlockErr) {
      process.stderr.write(`Warning: failed to unlock query ${nameLower} after error: ${unlockErr}\n`);
    }
    throw err;
  }
}

const ACTIVE_PATH_ACCEPT: Record<string, string> = {
  plsq: 'application/vnd.sap.bw.modeling.plsq-v1_0_0+xml',
  filter: 'application/vnd.sap.bw.modeling.filter-v1_8_0+xml, application/vnd.sap.bw.modeling.filter-v1_9_0+xml',
};

/**
 * Lock for deletion, DELETE and unlock, all on /{type}/{name}/a. The lock is released also when
 * the delete is refused — for a filter still used by a planning sequence, for instance.
 */
async function deleteOnActivePath(client: BwClient, type: 'plsq' | 'filter', objectName: string): Promise<string> {
  const path = `/sap/bw/modeling/${type}/${bwSeg(objectName.toLowerCase())}/a`;
  const accept = ACTIVE_PATH_ACCEPT[type];
  const mediaType = MEDIA_TYPES[type] ?? accept.split(',').pop()!.trim();
  const lock = await client.rawPost(`${path}?action=lock`, '', {
    activity_context: 'DELE',
    Accept: accept,
    'x-csrf-token': await client.getCsrfToken(),
    ...lockSessionHeader(),
  });
  const handle = lock.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
  if (!handle) throw new Error(`No <LOCK_HANDLE> in delete lock response:\n${lock.body}`);
  let body: string;
  try {
    body = (await client.rawDelete(`${path}?lockHandle=${handle}`, { 'Content-Type': mediaType, Accept: mediaType })).body;
  } finally {
    await client
      .rawPost(`${path}?action=unlock`, '', { 'Content-Type': mediaType, Accept: mediaType, 'x-csrf-token': await client.getCsrfToken() })
      .catch(() => {/* ignore */});
  }
  return JSON.stringify({
    success: true,
    object_type: type.toUpperCase(),
    object_name: objectName.toUpperCase(),
    messages: parseAtomTitles(body),
  });
}

export async function bwDelete(
  client: BwClient,
  objectType: string,
  objectName: string
): Promise<string> {
  const typeLower = objectType.toLowerCase();

  // Queries (TLOGO ELEM) need a dedicated delete sequence.
  if (typeLower === 'query' || typeLower === 'elem') {
    return bwDeleteQuery(client, objectType, objectName);
  }

  // Conversion types exist in the active version only and are deleted on the object path.
  if (typeLower === 'ctrt' || typeLower === 'uomt') {
    return bwDeleteConversionType(client, typeLower === 'ctrt' ? 'currency' : 'unit', objectName);
  }
  // Planning sequences and filters are deleted on their active path, as the modeling tools do.
  if (typeLower === 'plsq' || typeLower === 'filter') {
    return deleteOnActivePath(client, typeLower, objectName);
  }

  const mediaType = MEDIA_TYPES[typeLower] ?? 'application/xml';

  // 1. Lock — uses /m before ?action=lock (delete-specific lock URL)
  const lockHandle = await client.lockForDelete(typeLower, objectName, mediaType);

  // 2. DELETE. A refused delete ("still in use") must not leave the object locked: the lock
  // would outlive this call and block every later change until the session times out.
  let deleteResult: string;
  try {
    deleteResult = await client.delete(typeLower, objectName, lockHandle, mediaType);
  } catch (err) {
    await client.unlock(typeLower, objectName).catch((unlockErr) => {
      process.stderr.write(`Warning: failed to unlock ${typeLower} ${objectName} after a failed delete: ${unlockErr}\n`);
    });
    throw err;
  }

  // 3. Unlock — no /m (same as normal unlock). The delete already succeeded; some resources
  // (CKF, RKF) no longer resolve once the object is gone and answer the unlock with HTTP 404.
  await client.unlock(typeLower, objectName).catch((unlockErr) => {
    process.stderr.write(`Warning: failed to unlock ${typeLower} ${objectName} after delete: ${unlockErr}\n`);
  });

  // 4. Parse atom feed response
  const messages = parseAtomTitles(deleteResult);

  return JSON.stringify({
    success: true,
    object_type: objectType.toUpperCase(),
    object_name: objectName.toUpperCase(),
    messages,
  });
}
