#!/usr/bin/env node
/**
 * Development launcher with automatic reload.
 *
 * The MCP host starts this script instead of dist/transport/stdio.js. It runs the server as a
 * child process and passes every message through unchanged. Before a tools/call or tools/list
 * it checks whether dist/ changed since the child started; if so, and once the build has
 * settled, it starts a fresh child, repeats the handshake the host made, and only then passes
 * the request on. A rebuild therefore takes effect with the next call, without restarting the
 * host.
 *
 * Limits: a change of the tool list itself (names, input schemas) is announced to the host
 * with notifications/tools/list_changed; whether the host reads the list again is up to the
 * host. Requests still running in the old child are answered by it before the switch.
 *
 * The child gets this process's environment and arguments; nothing is read or written besides
 * dist/ timestamps. Messages are newline-delimited JSON-RPC, as in the MCP stdio transport.
 * Diagnostics go to stderr with the prefix [dev-reload].
 */
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const entry = join(dist, 'transport', 'stdio.js');
/** A build counts as settled when no file in dist/ changed for this long. */
const SETTLE_MS = 1500;
const SETTLE_MAX_MS = 30000;

const say = (msg) => process.stderr.write(`[dev-reload] ${msg}\n`);

function newestMtime(dir) {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestMtime(p));
    else if (e.name.endsWith('.js') || e.name.endsWith('.json')) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

function distMtime() {
  try {
    return newestMtime(dist);
  } catch {
    return 0;
  }
}

/** One line-oriented reader per stream. */
function lines(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
}

const toHost = (msg) => process.stdout.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`);

let child;
let childStarted = 0;
/** Request ids the host sent to the current child and that are not answered yet. */
const pending = new Set();
/** Internal requests (handshake replay, tool list) waiting for their answer. */
const internal = new Map();
let internalSeq = 0;
let initializeRequest; // the host's initialize, replayed to every new child
let initializedSent = false;
let toolListKey; // last tool list the host saw
let switching; // promise while a new child starts

function startChild() {
  childStarted = Date.now();
  const c = spawn(process.execPath, [entry, ...process.argv.slice(2)], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  c.stderr.on('data', (d) => process.stderr.write(d));
  lines(c.stdout, (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return toHost(line);
    }
    if (msg.id !== undefined && internal.has(msg.id) && msg.method === undefined) {
      const resolve = internal.get(msg.id);
      internal.delete(msg.id);
      return resolve(msg);
    }
    if (msg.id !== undefined && msg.method === undefined) {
      pending.delete(msg.id);
      if (msg.result?.tools) toolListKey = JSON.stringify(msg.result.tools);
    }
    toHost(msg);
  });
  c.on('exit', (code, signal) => {
    if (child !== c) return;
    say(`server exited (${signal ?? code})`);
    for (const id of pending) toHost({ jsonrpc: '2.0', id, error: { code: -32603, message: 'coBWeb server process ended; call again.' } });
    pending.clear();
    child = undefined;
  });
  child = c;
  return c;
}

function send(c, msg) {
  c.stdin.write(`${JSON.stringify(msg)}\n`);
}

/** Ask the child; fails when it ends or does not answer, so a broken build cannot hang a call. */
function ask(c, method, params, timeoutMs = 30000) {
  const id = `__dev_reload_${++internalSeq}`;
  return new Promise((resolve, reject) => {
    const done = (fn, v) => {
      clearTimeout(timer);
      c.off('exit', onExit);
      internal.delete(id);
      fn(v);
    };
    const onExit = () => done(reject, new Error(`server ended during ${method}`));
    const timer = setTimeout(() => done(reject, new Error(`no answer to ${method} within ${timeoutMs / 1000} s`)), timeoutMs);
    c.once('exit', onExit);
    internal.set(id, (msg) => done(resolve, msg));
    send(c, { jsonrpc: '2.0', id, method, params });
  });
}

/** Why the last start failed; requests are answered with it until a new build works. */
let broken;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntilSettled() {
  const start = Date.now();
  while (Date.now() - distMtime() < SETTLE_MS && Date.now() - start < SETTLE_MAX_MS) await sleep(250);
}

async function waitIdle() {
  const start = Date.now();
  while (pending.size > 0 && Date.now() - start < 120000) await sleep(100);
}

/** Start a fresh child and repeat the host's handshake on it. */
async function restart(reason) {
  await waitUntilSettled();
  await waitIdle();
  const old = child;
  child = undefined;
  if (old) {
    old.stdin.end();
    old.kill();
  }
  const c = startChild();
  say(`server (re)started: ${reason}`);
  broken = undefined;
  if (initializeRequest) {
    try {
      await ask(c, 'initialize', initializeRequest.params);
    } catch (err) {
      broken = `The coBWeb server did not start after the last build (${err.message}). Fix the build; the next call starts it again.`;
      say(broken);
      if (child === c) child = undefined;
      return;
    }
    if (initializedSent) send(c, { jsonrpc: '2.0', method: 'notifications/initialized' });
    if (toolListKey !== undefined) {
      const list = await ask(c, 'tools/list', {});
      const key = JSON.stringify(list.result?.tools ?? []);
      if (key !== toolListKey) {
        toolListKey = key;
        toHost({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        say('tool list changed; the host may need a restart to see it');
      }
    }
  }
}

async function ensureCurrent() {
  if (switching) await switching;
  const stale = !child || distMtime() > childStarted;
  // After a failed start, wait for a newer build instead of starting the same one again.
  if (broken && distMtime() <= childStarted) return;
  if (!stale) return;
  switching = restart(child ? 'dist/ changed' : 'no running server').finally(() => {
    switching = undefined;
  });
  await switching;
}

// Messages from the host are handled in order; a reload holds back the ones behind it.
let queue = Promise.resolve();
lines(process.stdin, (line) => {
  queue = queue.then(() => handle(line)).catch((err) => say(`unexpected: ${err?.message ?? err}`));
});

async function handle(line) {
  {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (child) child.stdin.write(`${line}\n`);
      return;
    }
    if (msg.method === 'initialize') initializeRequest = msg;
    if (msg.method === 'notifications/initialized') initializedSent = true;
    if (msg.method === 'tools/call' || msg.method === 'tools/list') {
      try {
        await ensureCurrent();
      } catch (err) {
        broken = `The coBWeb server could not be restarted (${err.message}). Fix the build; the next call tries again.`;
        say(broken);
      }
    }
    if (broken && msg.id !== undefined && msg.method !== undefined) {
      toHost({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: broken } });
      return;
    }
    if (!child) startChild();
    if (msg.id !== undefined && msg.method !== undefined) pending.add(msg.id);
    send(child, msg);
  }
}
process.stdin.on('end', () => {
  queue.then(() => {
    if (child) child.stdin.end();
    setTimeout(() => process.exit(0), 500).unref();
  });
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  if (child) child.kill();
  process.exit(0);
});

startChild();
