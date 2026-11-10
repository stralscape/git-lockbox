'use strict';

const fs = require('fs');
const path = require('path');
const proc = require('./proc');

const GIT = 'git';

/** Absolute path of this repository's root working tree. */
function repoRoot() {
  const res = proc.runSync(GIT, ['rev-parse', '--show-toplevel']);
  return res.status === 0 ? res.stdout.toString().replace(/\r?\n$/, '') : process.cwd();
}

/**
 * Resolve local (file) remote paths to absolute: the push happens from a
 * temp repository elsewhere, so a relative URL would break. scp-like
 * (host:path), scheme:// and absolute paths are kept as-is.
 */
function normalizeRemote(remote) {
  const r = String(remote).trim();
  if (!r) return r;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(r)) return r; // scheme://...
  if (/^[a-zA-Z]:[\\/]/.test(r)) return r; // absolute win path (C:\..., C:/...)
  if (/^(\\\\|\/{2})/.test(r)) return r; // UNC
  if (/^\/[^/]/.test(r)) return r; // absolute posix path
  if (/^[^/:\\]+:[^/]/.test(r)) return r; // scp-like host:path
  return path.resolve(r);
}

function isInsideGitRepo() {
  const res = proc.runSync(GIT, ['rev-parse', '--is-inside-work-tree']);
  if (res.status !== 0) return false;
  // Git for Windows may emit CRLF.
  return res.stdout.toString().trim() === 'true';
}

async function assertInsideGitRepo() {
  if (!isInsideGitRepo()) {
    throw new Error('This command must be run inside a git working tree.');
  }
}

/** The current HEAD commit sha, or '' when there are no commits. */
function headCommitSha() {
  const res = proc.runSync(GIT, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return res.status === 0 ? res.stdout.toString().trim() : '';
}

function assertToolsAvailable(tools) {
  const missing = tools.filter((t) => !proc.toolAvailable(t));
  if (missing.length > 0) {
    throw new Error(
      `Required tool(s) not found on PATH: ${missing.join(', ')}. ` +
        'Install git, tar and gpg (usually found in Git for Windows or via your package manager).'
    );
  }
}

/** Preferred OS temp dir (env allows an override for hardened setups). */
function makeTempDir(basePath) {
  // Per-run timestamped subdir (no PID deliberately).
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp =
    d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) +
    '-' + pad(d.getMilliseconds(), 3);
  const runDir = path.join(basePath, `git-lockbox-run-${stamp}`);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

function runGit(args, options) {
  const res = proc.runSync(GIT, args, options);
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed with exit code ${res.status}\n${res.stderr.toString().trim()}`);
  }
  return res;
}

module.exports = {
  GIT,
  assertInsideGitRepo,
  assertToolsAvailable,
  headCommitSha,
  makeTempDir,
  repoRoot,
  normalizeRemote,
  runGit,
};
