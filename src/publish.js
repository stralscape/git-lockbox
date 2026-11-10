'use strict';

const fs = require('fs');
const path = require('path');
const repo = require('./repo');
const { redact } = require('./redact');

const COMMITTER = {
  GIT_AUTHOR_NAME: 'git-lockbox',
  GIT_AUTHOR_EMAIL: 'git-lockbox@local',
  GIT_COMMITTER_NAME: 'git-lockbox',
  GIT_COMMITTER_EMAIL: 'git-lockbox@local',
};

/**
 * Strict ISO 8601 UTC timestamp, always exactly 20 chars (YYYY-MM-DDTHH:MM:SSZ):
 * no spaces, no separators that could collide with the commit-message format.
 */
function isoUtcTimestamp(d = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    pad(d.getUTCFullYear(), 4) + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
    'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + 'Z'
  );
}

/**
 * Deploy commit message: one single line, no spaces anywhere, parsed by position
 * (not by keywords):
 *
 *   <source HEAD sha>[_<--use-key-label>]<ISO-UTC-timestamp>
 *
 * - first part: the source repository's HEAD sha that was archived
 *   (40 hex on SHA-1 repositories, which are the default)
 * - middle: the --use-key-label, if given (free text, no spaces)
 * - trailing 20 chars: strict ISO timestamp of the deploy run
 *   (YYYY-MM-DDTHH:MM:SSZ), matched by the fixed ISO shape
 *
 * With --use-key the label is the user's way of telling which key produced
 * which deploy; it reveals nothing about the key material itself.
 */
function buildDeployCommitMessage({ timestamp, sourceCommitSha, keyLabel = '' }) {
  let line = String(sourceCommitSha);
  if (keyLabel) line += `_${keyLabel}`;
  line += `_${timestamp}`;
  return line;
}

/**
 * Authentication args for an HTTPS push with a GitHub PAT.
 * Using `-c http.extraHeader=...` keeps the token out of the temp repo's
 * on-disk config; it is still visible in the git child process arguments
 * while the push runs (like the tool's own CLI flag).
 * Returns the args plus the secret strings that must be redacted from errors.
 */
function patPushArgs(remote, pat) {
  if (!pat || !/^https?:\/\//i.test(remote)) return { args: [], secrets: [] };
  const encoded = Buffer.from(`x-access-token:${pat}`, 'utf8').toString('base64');
  const value = `Basic ${encoded}`;
  return {
    args: ['-c', `http.extraHeader=Authorization: ${value}`],
    secrets: [value, encoded],
  };
}

/**
 * Stage the encrypted artifact into a BARE object database - no working
 * tree, no checkout, no second copy of the file on disk - using plumbing:
 *
 *   git hash-object -w <file>     -> blob goes straight into the object DB
 *   (delete the .gpg file here)
 *   echo entry | git mktree       -> tree
 *
 * The commit itself is built by publishToRemote, once the destination
 * branch's current tip is known (deploys append to it).
 */
function stageEncryptedArtifact({ workDir, encryptedPath, fileName }) {
  const deployDir = path.join(workDir, 'deploy.git');
  repo.runGit(['init', '--bare', '--quiet', deployDir]);

  const blobSha = repo
    .runGit(['-C', deployDir, 'hash-object', '-w', '--', encryptedPath])
    .stdout.toString().trim();

  // The file's bytes now live (compressed) inside the object DB; drop the file.
  fs.rmSync(encryptedPath, { force: true });

  const treeSha = repo
    .runGit(
      ['-C', deployDir, 'mktree'],
      { stdinValue: `100644 blob ${blobSha}\t${fileName}\n` }
    )
    .stdout.toString().trim();

  return { deployDir, treeSha };
}

/** Fetch failures that simply mean "the remote branch does not exist (yet)". */
const BRANCH_MISSING_PATTERN =
  /couldn't find remote ref|not a valid (?:object name|ref)|no such ref|did not match any remote|not found in upstream/i;

/**
 * Fetch the destination branch and return its current tip commit (the parent
 * the new deploy commit is built on), or '' when the branch does not exist
 * yet (first deploy -> an initial, parentless commit is created).
 *
 * A shallow (--depth 1) fetch is attempted first: it is the same well-trodden
 * pattern as CI systems committing and pushing back from shallow checkouts;
 * the client never needs the parent's full history to add one child commit.
 * If the host or git version rejects it, a full fetch is tried once.
 * Anything other than a missing branch (auth, network) throws.
 */
function fetchBranchTip({ deployDir, remote, branch, pat }) {
  const auth = patPushArgs(remote, pat);
  const fetchOnce = (extraArgs) =>
    repo.runGit([
      '-C', deployDir,
      ...auth.args,
      'fetch', ...extraArgs,
      'origin', `refs/heads/${branch}`,
    ]);

  try {
    fetchOnce(['--depth', '1']);
  } catch (_) {
    try {
      fetchOnce([]);
    } catch (err) {
      if (BRANCH_MISSING_PATTERN.test(String(err.message || ''))) return '';
      throw new Error(redact(err.message, [pat, ...auth.secrets]));
    }
  }

  return repo
    .runGit(['-C', deployDir, 'rev-parse', '--verify', 'FETCH_HEAD'])
    .stdout.toString().trim();
}

/**
 * Create the deploy commit: parented on the fetched tip when the branch
 * exists (fast-forward chain), parentless for the very first deploy.
 * Git stamps the commit date itself; the message line is the deploy
 * identifier (see buildDeployCommitMessage).
 */
function commitDeploy({ deployDir, treeSha, parentTip, messageLine }) {
  const args = ['commit-tree', treeSha];
  if (parentTip) args.push('-p', parentTip);
  args.push('-m', messageLine);
  const commitSha = repo
    .runGit(['-C', deployDir, ...args], { env: COMMITTER })
    .stdout.toString().trim();
  return commitSha;
}

/**
 * Publish a new deploy commit WITHOUT rewriting history:
 *
 *   fetch branch tip -> commit-tree ([-p tip]) -> plain push <sha>:refs/heads/<branch>
 *
 * The push is always a fast-forward, so no force push and no confirmation
 * are ever needed. If the branch moved between fetch and push (concurrent
 * deploy), the push is rejected as non-fast-forward and the tool fails
 * immediately; nothing was lost - re-running appends to the new tip.
 *
 * With reset=true (--reset-remote-using-force-push), the fetch is skipped
 * and a parentless deploy commit is pushed with --force, replacing the
 * branch's entire history; previous deploy artifacts become unreachable
 * (unrecoverable, even with their passphrases). Deliberate, never prompted.
 * Returns deploy info for the run output.
 */
function publishToRemote({ workDir, encryptedPath, fileName, remote, branch, pat, sourceCommitSha, keyLabel = '', reset = false }) {
  const { deployDir, treeSha } = stageEncryptedArtifact({ workDir, encryptedPath, fileName });

  // Keep the URL itself credential-free; the PAT (when given) is supplied to
  // git as transient config arguments instead of being written to disk.
  repo.runGit(['-C', deployDir, 'remote', 'add', 'origin', remote]);

  const parentTip = reset ? '' : fetchBranchTip({ deployDir, remote, branch, pat });

  const timestamp = isoUtcTimestamp();
  const messageLine = buildDeployCommitMessage({ timestamp, sourceCommitSha, keyLabel });
  const commitSha = commitDeploy({ deployDir, treeSha, parentTip, messageLine });

  const auth = patPushArgs(remote, pat);
  const pushArgs = [
    '-C', deployDir,
    ...auth.args,
    'push',
    ...(reset ? ['--force'] : []),
    'origin', `${commitSha}:refs/heads/${branch}`,
  ];
  try {
    repo.runGit(pushArgs);
  } catch (err) {
    throw new Error(redact(err.message, [pat, ...auth.secrets]));
  }

  // Belt and suspenders: drop the remote URL from the temp repo.
  try { fs.rmSync(path.join(deployDir, 'config'), { force: true }); } catch (_) { /* noop */ }

  return { deployDir, commitSha, parentTip, timestamp, messageLine };
}

module.exports = { publishToRemote };
