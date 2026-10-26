/** Logging to stderr only; stdout carries the MCP protocol. */
import type { LogLevel } from './config.js';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let threshold: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export function log(level: LogLevel, message: string): void {
  if (ORDER[level] > ORDER[threshold]) return;
  process.stderr.write(`[cobweb] ${level === 'info' ? '' : `${level.toUpperCase()}: `}${message}\n`);
}
