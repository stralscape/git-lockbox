#!/usr/bin/env node
'use strict';

const { parseArgs } = require('../src/args');
const log = require('../src/log');
const repo = require('../src/repo');
const prompt = require('../src/prompt');
const { redact, redactUrlCredentials, redactUrlCredentialsInText } = require('../src/redact');
const {
  resolveTreeish,
  resolveDistFolder,
  archiveModeLabel,
  isPathInside,
  DEFAULT_DIST_FOLDER,
} = require('../src/archive');
const { generatePassphrase, createEncryptedArtifact, describeEncryptPipeline } = require('../src/encrypt');
const { publishToRemote } = require('../src/publish');
const path = require('path');
const fs = require('fs');

const DEFAULT_BRANCH = 'main';
const DEFAULT_ARCHIVE_NAME = 'lockbox.tgz.gpg';

function fail(message) {
  log.err('error: ' + message);
  process.exitCode = 1;
}

function printHelp() {  log.out(`
git-lockbox - deploy from GitHub without trusting it with your code.
Encrypt a local source repository with GPG and push it as a new commit to a remote destination repository for deployment.
Prints ready-to-use deploy instructions.

Usage:
  git-lockbox [options]

Options:
  --remote <url>                          Destination git repository (receives the
                                          encrypted archive). Asked interactively
                                          if missing and run in a terminal.

  --branch <name>                         Remote branch deploys are appended to.
                                          Default: ${DEFAULT_BRANCH}

  --name <file>                           Archive file name in the destination repo.
                                          Default: ${DEFAULT_ARCHIVE_NAME}. A .gpg suffix
                                          is appended if missing; must be a plain file
                                          name (no directory separators).

  --dist-only [folder]                    Package a working-tree folder instead of the
                                          committed tree. Bare --dist-only means
                                          "${DEFAULT_DIST_FOLDER}". The folder is packaged as-is
                                          from disk (Git tracking/ignore rules are not
                                          consulted); paths are relative to the repo root.
                                          The folder's contents become the archive root.
                                          It must be non-empty, must not be the repo
                                          root or contain the .git directory, and the
                                          run's temp dir must lie outside it.
                                          Requires tar on the producer.

  --github-personal-access-token <token>  PAT for private GitHub repos (https push).
                                          Never logged; redacted on errors. Prefer SSH
                                          or a credential helper where possible.

  --use-key <key>                         Use a fixed passphrase for encryption instead
                                          of the per-run random one (automation/reuse).
                                          Minimum 16 chars. The key is never re-printed
                                          in the output; it is visible in the tool's
                                          command line (shell history/process list).

  --use-key-label <label>                 Space-free label identifying the key, shown
                                          in the deploy commit's message so you can
                                          tell which key produced which deploy without
                                          revealing anything about the key material.
                                          Requires --use-key or --use-passphrase-file.
                                          Max 64 chars.

  --use-passphrase-fd                     Pass the passphrase to gpg via stdin (fd 0,
                                          first line of the stream) for encryption
                                          instead of the process arguments.

  --use-passphrase-file <path>            Read the passphrase from the first line of
                                          this file (line terminator is trimmed,
                                          min 16 chars; must be LF-terminated or
                                          have no trailing newline - CRLF is
                                          rejected because gpg keeps the \\r as part
                                          of the key), instead of --use-key or a
                                          per-run key; the printed deploy
                                          instructions decrypt using gpg's
                                          --passphrase-file on the same file.

  --verbose                               Print the full step-by-step progress output
                                          (Step 1/5 ... 5/5). Without it, only the
                                          intro settings block and the final deploy
                                          instructions are printed.

  --generate-key                          Generate a new random encryption key, print it
                                          to stdout, and exit. Nothing else happens (no
                                          repo checks, no push). Use for --use-key
                                          automation setups.

  --temp-dir <path>                       Use this directory for run artifacts instead
                                          of the default (<repo>/.git). A per-run
                                          git-lockbox-run-<timestamp> subfolder is
                                          created inside it.

  --reset-remote-using-force-push         Instead of appending, force-push a fresh
                                          deploy commit that replaces the destination
                                          branch's entire history. Previous deploy
                                          artifacts become unreachable (unrecoverable,
                                          even with their passphrases). Deliberate,
                                          never prompted; the deploy ledger property
                                          of the branch history is lost.

  --help                                  Show this help.
`);
}

function normalizeArchiveName(raw) {
  let name = String(raw || '').trim();
  if (!name) return DEFAULT_ARCHIVE_NAME;
  if (name.includes('/') || name.includes('\\')) {
    throw new Error('--name must be a plain file name (no directory separators).');
  }
  if (/[\r\n\t]/.test(name)) {
    throw new Error('--name must not contain control characters.');
  }
  if (!/\.gpg$/i.test(name)) name += '.gpg';
  return name;
}

// The key label lands in the deploy commit's message, which is a single
// space-free line parsed by position: <sha>[_<label>]_<ISO-timestamp>.
// Keep it free of whitespace/control characters, reasonably short, and make
// sure its tail cannot pass for the trailing strict-ISO timestamp segment
// (otherwise the positional split becomes ambiguous).
const MAX_KEY_LABEL_LEN = 64;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function normalizeUseKeyLabel(raw) {
  const label = String(raw || '').trim();
  if (!label) return '';
  if (/[\s\r\n\t]/.test(label)) {
    throw new Error('--use-key-label must not contain spaces or control characters.');
  }
  if (label.length > MAX_KEY_LABEL_LEN) {
    throw new Error(`--use-key-label is too long (maximum ${MAX_KEY_LABEL_LEN} characters).`);
  }
  if (ISO_TIMESTAMP_PATTERN.test(label.slice(-20))) {
    throw new Error(
      '--use-key-label must not end with an ISO timestamp look-alike (e.g. "..._2026-10-31T14:00:00Z"), ' +
      'which would make the positional parse of the commit message ambiguous.'
    );
  }
  return label;
}

function resolveOptions(settings) {
  const distOnlyRaw = settings['dist-only'];
  const s = {
    remote: settings.remote || '',
    branch: settings.branch || DEFAULT_BRANCH,
    name: normalizeArchiveName(settings.name || DEFAULT_ARCHIVE_NAME),
    // --dist-only: true -> default dist folder; string -> custom folder; absent -> null (whole tree)
    distFolder: distOnlyRaw === true ? DEFAULT_DIST_FOLDER : (distOnlyRaw || null),
    pat: settings['github-personal-access-token'] || '',
    useKey: settings['use-key'] || '',
    useKeyLabel: normalizeUseKeyLabel(settings['use-key-label'] || ''),
    usePassphraseFile: normalizePassphraseFile(settings['use-passphrase-file'] || ''),
    usePassphraseFd: Boolean(settings['use-passphrase-fd']),
    reset: Boolean(settings['reset-remote-using-force-push']),
    verbose: Boolean(settings.verbose),
  };
  if (s.useKeyLabel && !s.useKey && !s.usePassphraseFile) {
    throw new Error('--use-key-label can only be used together with --use-key or --use-passphrase-file.');
  }
  if (s.useKey && s.usePassphraseFile) {
    throw new Error('--use-key and --use-passphrase-file are mutually exclusive (both provide the passphrase).');
  }
  return s;
}

/**
 * --use-passphrase-file: the passphrase lives in a user-provided file, read
 * by gpg on both sides of the deploy (producer reads only its first line to
 * stay byte-consistent with what deploy-side gpg reads from the same file).
 */
function normalizePassphraseFile(raw) {
  const p = String(raw || '').trim();
  if (!p) return '';
  if (/[\r\n]/.test(p)) {
    throw new Error('--use-passphrase-file must be a single path.');
  }
  return p;
}

/**
 * Read the passphrase file the way gpg does for --passphrase-file, minus the
 * line terminator itself: FIRST LINE with its trailing \n removed
 * (LF-terminated or no-newline files round-trip byte-exact through the printed
 * --passphrase-file deploy command). CRLF/CR files are REJECTED up front: gpg
 * keeps the \r as part of the key at decrypt time, while this tool cannot
 * reproduce that through its own gpg invocation - silently accepting such a
 * file would produce artifacts the printed deploy instructions cannot decrypt.
 */
function readPassphraseFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch (err) {
    throw new Error(`Cannot read passphrase file "${filePath}": ${err.message}`);
  }
  const newline = content.indexOf('\n');
  const firstLine = newline === -1 ? content : content.subarray(0, newline);
  if (firstLine.length > 0 && firstLine[firstLine.length - 1] === 0x0d) {
    throw new Error(
      `Passphrase file "${filePath}" has a carriage return at the end of its first line (CRLF/CR line endings): ` +
      'gpg would keep it as part of the key at decrypt time, making the artifact undecryptable with the printed instructions. ' +
      'Re-save the file with an LF line ending (or no trailing newline).'
    );
  }
  const text = firstLine.toString('utf8');
  if (!text) {
    throw new Error(`Passphrase file "${filePath}" has an empty first line.`);
  }
  if (text.length < MIN_PASSPHRASE_LEN) {
    throw new Error(`Passphrase file "${filePath}" is too short (minimum ${MIN_PASSPHRASE_LEN} chars).`);
  }
  return text;
}

// Fixed passphrases (--use-key / --use-passphrase-file) are reused across runs, so they
// must be long enough to resist brute force on possibly-collected older artifacts.
const MIN_PASSPHRASE_LEN = 16;

function describeEffective(s) {
  return [
    `remote repo:          ${s.remote ? redactUrlCredentials(s.remote) : '(prompted at runtime)'}`,
    `branch:               ${s.branch}`,
    `archive name:         ${s.name}`,
    `archive mode:         ${archiveModeLabel(s.distFolder)}`,
    `encryption key:       ${s.useKey ? 'user-provided (--use-key)' : s.usePassphraseFile ? 'user-provided file (--use-passphrase-file)' : 'generated fresh per run'}`,
    `key label:            ${s.useKeyLabel || '(none)'}`,
  ];
}

async function mainFlow(settings) {
  await repo.assertInsideGitRepo();

  const s = resolveOptions(settings);
  repo.assertToolsAvailable(s.distFolder ? ['git', 'gpg', 'tar'] : ['git', 'gpg']);

  if (s.reset) {
    log.out(
      'warning: --reset-remote-using-force-push is set: the history of the destination branch "' +
        s.branch + '" will be replaced by force push. Previous deploy artifacts become unrecoverable.'
    );
  }

  if (s.useKey && s.useKey.length < MIN_PASSPHRASE_LEN) {
    fail(`--use-key too short (minimum ${MIN_PASSPHRASE_LEN} chars).`);
    return;
  }

  const sourceCommit = repo.headCommitSha();
  if (!sourceCommit) {
    fail('This repository has no commits yet.');
    return;
  }

  // Source validity check happens up front, so bad folders/commits fail before prompting.
  let archiveSource;
  let distFolderPath = null;
  if (s.distFolder) {
    distFolderPath = resolveDistFolder({ repoRoot: repo.repoRoot(), folder: s.distFolder });
    archiveSource = {
      command: 'tar',
      args: ['-c', '-z', '-f', '-', '-C', distFolderPath, '.'],
      label: 'tar',
    };
  } else {
    const treeish = resolveTreeish({ sourceCommit });
    archiveSource = {
      command: 'git',
      args: ['archive', '--format=tar.gz', treeish],
      label: 'git',
    };
  }

  // Destination remote: flag -> interactive prompt
  let remote = s.remote;
  if (!remote && prompt.isInteractive()) {
    log.out('');
    log.out('No destination repository given (--remote). Configure it interactively:');
    remote = await prompt.ask('Destination git repository (receives the encrypted archive)');
  }
  if (!remote) {
    fail('No destination repository given.');
    return;
  }
  remote = repo.normalizeRemote(remote);
  const displayRemote = redactUrlCredentials(remote);
  if (displayRemote !== remote) {
    log.out('warning: ' + 'destination remote contains embedded credentials; they are redacted from this output. Prefer SSH or a credential helper.');
  }
  if (s.useKeyLabel) {
    log.out(`Deploy commits carry the key label "${s.useKeyLabel}" in their message (no information about the key itself).`);
  }

  log.out('');
  log.out('================= git-lockbox =================');
  log.out('');
  log.out(`source repo commit:   ${sourceCommit}`);
  for (const line of describeEffective({ ...s, remote })) log.out(line);
  if (s.pat) log.out('push credentials:     GitHub personal access token (redacted in logs)');
  else log.out('push credentials:     ambient git auth (ssh agent / credential helper)');
  log.out('');

  // Local temp base dir: --temp-dir wins, else the repo's own .git directory.
  const tempBase = settings['temp-dir']
    ? path.resolve(settings['temp-dir'])
    : path.join(repo.repoRoot(), '.git');
  if (distFolderPath && isPathInside(distFolderPath, path.resolve(tempBase))) {
    fail('--temp-dir cannot be inside the --dist-only folder.');
    return;
  }

  // Warn about leftover run dirs from previous crashed runs (kept on purpose for inspection).
  try {
    const stale = fs.readdirSync(tempBase)
      .filter((n) => /^git-lockbox-run-/.test(n))
      .map((n) => path.join(tempBase, n));
    if (stale.length > 0) {
      log.out('warning: ' + 'run artifacts from previous (aborted or crashed) runs still exist - inspect and remove manually:');
      for (const p of stale) log.out('warning: ' + '  ' + p);
    }
  } catch (_) { /* base dir may not exist yet */ }

  const workDir = repo.makeTempDir(tempBase);
  let encryptedPath = path.join(workDir, s.name);

  try {
    // Progress lines are only shown with --verbose; the final block below is always shown.
    const verbose = Boolean(s.verbose);
    const step = (text) => {
      if (verbose) log.out('==> ' + text);
    };

    // Delimiter opening the step section (runs above Step 1/5).
    log.out('===============================================');

    // Step 1: passphrase source (user key, user file, or generated; generated
    // first when in fd mode since it opens the gpg stdin pipe)
    let passphrase;
    if (s.useKey) {
      step('Step 1/5 - run using user-provided passphrase (--use-key)...');
      step('Note: --use-key reuses a fixed passphrase; older artifacts pushed with that key remain decryptable with it. Rotate the key to stop using it for new pushes.');
      passphrase = s.useKey;
    } else if (s.usePassphraseFile) {
      step(`Step 1/5 - run using passphrase file (--use-passphrase-file)...`);
      passphrase = readPassphraseFile(s.usePassphraseFile);
    } else {
      step('Step 1/5 - generating random passphrase (crypto.randomBytes, 32 bytes)...');
      passphrase = generatePassphrase();
    }

    // Step 2: encrypt - archive source piped straight into gpg; no plaintext archive file
    step(`Step 2/5 - encrypting using the command: ${describeEncryptPipeline({
      command: archiveSource.command,
      args: archiveSource.args,
      outputFile: encryptedPath,
      usePassphraseFd: s.usePassphraseFd,
    })}`);
    await createEncryptedArtifact({
      command: archiveSource.command,
      args: archiveSource.args,
      label: archiveSource.label,
      outputFile: encryptedPath,
      passphrase,
      usePassphraseFd: s.usePassphraseFd,
    });
    if (!s.distFolder) {
      step(`Note: git archive packages only committed, tracked files; use --dist-only (or --dist-only <folder>) to package a working-tree folder, e.g. ${DEFAULT_DIST_FOLDER}.`);
    }
    step(`Encrypted archive created: ${path.basename(encryptedPath)} (${fs.statSync(encryptedPath).size} bytes)`);

    // Step 3: object-db staging + deploy commit (fetch tip -> commit-tree)
    step(`Step 3/5 - creating deploy commit (bare object db, no checkout)...`);
    const publishInfo = publishToRemote({
      workDir,
      encryptedPath,
      fileName: s.name,
      remote,
      branch: s.branch,
      pat: s.pat,
      sourceCommitSha: sourceCommit,
      keyLabel: s.useKeyLabel,
      reset: s.reset,
    });
    step(`Encrypted blob committed as deploy commit, transient .gpg file removed from disk`);

    // Step 4: push (plain fast-forward; no confirmation; --reset-remote-using-force-push
    // is the one deliberate exception, replacing the branch history)
    if (publishInfo.parentTip) {
      step(`Step 4/5 - appended deploy commit on top of ${publishInfo.parentTip.slice(0, 10)} on ${displayRemote} branch "${s.branch}"...`);
    } else if (s.reset) {
      step(`Step 4/5 - force-pushed fresh deploy commit, replacing the history of ${displayRemote} branch "${s.branch}"...`);
    } else {
      step(`Step 4/5 - created initial deploy commit on ${displayRemote} branch "${s.branch}"...`);
    }
    step(`Push complete: ${publishInfo.messageLine}`);

    try {
      fs.rmSync(workDir, { recursive: true, force: true });
      step(`Step 5/5 cleanup local temp dir ${workDir} removed`);
    } catch (cleanupErr) {
      log.out('warning: ' + `Could not fully remove temp dir ${workDir}: ${redact(cleanupErr.message, [s.pat, s.useKey])}`);
    }

    log.printDeployInstructions({
      remote,
      branch: s.branch,
      name: s.name,
      passphrase: (s.useKey || s.usePassphraseFile) ? null : passphrase,
      usePassphraseFd: s.usePassphraseFd,
      usePassphraseFile: s.usePassphraseFile,
    });
  } finally {
    // Safety net: wipe whatever remains when the run failed before the push;
    // idempotent, silent (successful runs already cleaned up above).
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      log.out('warning: ' + `Could not fully remove temp dir ${workDir}: ${redact(cleanupErr.message, [s.pat, s.useKey])}`);
    }
  }
}

function handleAsyncError(err, secretForRedaction) {
  fail(
    redactUrlCredentialsInText(redact(err && err.message ? err.message : String(err), secretForRedaction))
  );
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err.message);
    return;
  }

  const settings = parsed.options;
  const secretsForRedaction = [
    settings['github-personal-access-token'] || '',
    settings['use-key'] || '',
  ];

  if (settings['generate-key']) {
    // stdout must stay machine-clean: KEY=$(git-lockbox --generate-key) captures exactly the key.
    log.out(generatePassphrase());
    return;
  }

  if (parsed.showHelp) {
    printHelp();
    return;
  }

  mainFlow(settings)
    .then(() => { if (!process.exitCode) process.exitCode = 0; })
    .catch((err) => handleAsyncError(err, secretsForRedaction))
    .finally(() => prompt.closeRl());
}

main();
