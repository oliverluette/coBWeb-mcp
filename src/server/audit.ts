/**
 * Audit log of writing operations: one JSON line per object and operation, appended
 * to COBWEB_AUDIT_FILE. Specs and secrets are never written, only what was done to which object.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../log.js';

export interface AuditEntry {
  time: string;
  tool: string;
  action: string;
  type: string;
  name: string;
  source_system?: string;
  package?: string;
  transport?: string;
  result: string;
  message?: string;
}

export type AuditSink = (entry: Omit<AuditEntry, 'time'>) => void;

export function auditSink(file: string | undefined): AuditSink | undefined {
  if (!file) return undefined;
  return (entry) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n', 'utf8');
    } catch (err) {
      log('warn', `audit log ${file} not writable: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
