'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');

const GPG = 'gpg';
const DEFAULT_CIPHER = 'AES256';

/** 32 bytes => 43-char base64url string (no padding). */
function generatePassphrase(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Create the encrypted artifact WITHOUT writing a plaintext archive:
 *
 *   <source command> (stdout stream)
 *        |  piped between processes, never a file
 *        v
 *   gpg --symmetric AES256 --output <outputFile>
 *
 * The source is `git archive` for whole-tree runs or `tar` for --dist-only.
 * By default the passphrase rides gpg's ARGUMENT list (--passphrase ...) and
 * gpg's stdin carries only the archive stream; with usePassphraseFd it is fed
 * as the FIRST LINE of gpg's stdin followed by the archive stream (gpg
 * consumes line 1 as passphrase, the rest as data - verified byte-exact on
 * Windows with GnuPG). The ciphertext is gpg's only disk write.
 */
function createEncryptedArtifact({
  command,
  args,
  outputFile,
  passphrase,
  cipher = DEFAULT_CIPHER,
  label = command,
  usePassphraseFd = false,
}) {
  // argv mode uses the --passphrase=<value> form: a separate argument would be
  // re-parsed by gpg when the value starts with '-' (base64url keys can).
  const passphraseArgs = usePassphraseFd
    ? ['--passphrase-fd', '0'] // passphrase = first line of stdin, not the process arguments
    : [`--passphrase=${passphrase}`]; // argv mode: gpg's process list shows the passphrase during the run
  const passphraseArg = usePassphraseFd ? null : `--passphrase=${passphrase}`;
  const gpgArgs = [
    '--batch',
    '--yes',
    '--no-symkey-cache', // nothing derived from the passphrase is retained by gpg-agent, even in RAM
    '--pinentry-mode', 'loopback',
    ...passphraseArgs,
    '--cipher-algo', cipher,
    '--symmetric',
    '--output', outputFile,
  ];

  return new Promise((resolve, reject) => {
    const source = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const gpg = spawn(GPG, gpgArgs, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });

    const sourceErrChunks = [];
    const gpgErrChunks = [];
    source.stderr.on('data', (d) => sourceErrChunks.push(d));
    gpg.stderr.on('data', (d) => gpgErrChunks.push(d));

    let settled = false;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      source.stdout.destroy();
      gpg.stdin.destroy();
      reject(new Error(msg));
    };

    source.on('error', (err) => fail(`${label} failed to start: ${err.message}`));
    gpg.on('error', (err) => fail(`gpg failed to start: ${err.message}`));

    // Anything from the source goes straight into the pipe to gpg, after the
    // initial passphrase line.
    source.stdout.on('error', (err) => fail(`${label} stdout error: ${err.message}`));
    gpg.stdin.on('error', () => {
      if (settled) return;
      // gpg may exit before the source finishes; kill the upstream gracefully.
      source.stdout.destroy();
    });

    // fd mode: lay the passphrase down before streaming data.
    // argv mode: gpg's stdin carries only the archive stream.
    if (usePassphraseFd) gpg.stdin.write(passphrase + '\n');
    source.stdout.pipe(gpg.stdin);

    source.on('close', (code) => {
      if (code !== 0) {
        fail(`${label} ${args.join(' ')} exited with code ${code}\n${Buffer.concat(sourceErrChunks).toString().trim()}`);
      }
    });

    gpg.on('close', (code) => {
      if (code !== 0) {
        // Never echo argv-mode passphrases: mask the --passphrase value.
        const shown = gpgArgs.map((a) => (a === passphraseArg ? '***' : a)).join(' ');
        fail(`gpg ${shown} exited with code ${code}\n${Buffer.concat(gpgErrChunks).toString().trim()}`);
        return;
      }
      if (settled) return;
      settled = true;
      resolve({ outputFile });
    });
  });
}

/**
 * Human-readable rendering of the full pipeline. The passphrase itself never
 * appears in the rendering: argv mode shows a masked value (***), fd mode
 * shows only the --passphrase-fd 0 pointer.
 */
function describeEncryptPipeline({ command, args, outputFile, cipher = DEFAULT_CIPHER, usePassphraseFd = false }) {
  const quote = (arg) => (/\s/.test(arg) ? `"${arg}"` : arg);
  const gpg = [
    GPG,
    '--batch',
    '--yes',
    '--no-symkey-cache', // passphrase-derived data is never cached, even in RAM
    '--pinentry-mode', 'loopback',
    ...(usePassphraseFd
      ? ['--passphrase-fd', '0'] // passphrase = first line of stdin alongside the archive stream
      : ['--passphrase=***']), // argv mode: value masked in the rendering
    '--cipher-algo', cipher,
    '--symmetric',
    '--output', outputFile,
  ].map(quote).join(' ');
  return `${command} ${args.map(quote).join(' ')} | ${gpg}`;
}

module.exports = {
  generatePassphrase,
  createEncryptedArtifact,
  describeEncryptPipeline,
};
