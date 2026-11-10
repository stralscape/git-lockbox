'use strict';

const { spawnSync } = require('child_process');

/** Check a list of tool names with `where`/`which` or `--version`. */
function toolAvailable(name) {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(whichCmd, [name], { windowsHide: true });
  if (res.status === 0) return true;
  // Some environments launch tools via wrappers; fall back to --version.
  const v = spawnSync(name, ['--version'], { windowsHide: true });
  return v.status === 0;
}

/**
 * Run `command args...` synchronously. Returns { status, stdout, stderr } as Buffers.
 * On ENOENT throws a friendly error.
 * stdinValue: optional string written to the child's stdin and closed.
 * env: extra environment variables merged over process.env (commit identity, ...).
 */
function runSync(command, args, { stdinValue = null, env = null } = {}) {
  const stdio = stdinValue === null
    ? ['ignore', 'pipe', 'pipe']
    : ['pipe', 'pipe', 'pipe'];
  // node applies `encoding` to `input` too, so buffer-encoding can't coexist
  // with input; normalize outputs to Buffers ourselves in that case.
  const passBuffers = stdinValue === null;
  const res = spawnSync(command, args, {
    stdio,
    windowsHide: true,
    encoding: passBuffers ? 'buffer' : 'utf8',
    env: env ? { ...process.env, ...env } : undefined,
    input: stdinValue === null ? undefined : String(stdinValue),
  });
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      throw new Error(`Required tool "${command}" not found on PATH.`);
    }
    throw res.error;
  }
  const toBuf = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8'));
  return {
    status: res.status,
    stdout: passBuffers ? (res.stdout || Buffer.alloc(0)) : toBuf(res.stdout || ''),
    stderr: passBuffers ? (res.stderr || Buffer.alloc(0)) : toBuf(res.stderr || ''),
  };
}

module.exports = { runSync, toolAvailable };
