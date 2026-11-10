'use strict';

const { redactUrlCredentials } = require('./redact');

/** Human/progress line -> stdout (auto newline). */
function out(text) {
  process.stdout.write(text + '\n');
}

/** Diagnostics/errors -> stderr (auto newline). */
function err(text) {
  process.stderr.write(text + '\n');
}

function printDeployInstructions({ remote, branch, name, passphrase, usePassphraseFd = false, usePassphraseFile = '' }) {
  const archive = /\.gpg$/i.test(name) ? name : name + '.gpg';
  const shownRemote = redactUrlCredentials(remote);

  // Decrypt command follows the passphrase source:
  // - --use-passphrase-file: same file used to encrypt, read by gpg itself
  // - --use-passphrase-fd: piped via stdin (POSIX shell where printf is a builtin)
  // - default: key given via --passphrase argument
  const quoteIfNeeded = (arg) => (/\s/.test(arg) ? `"${arg}"` : arg);
  const passMode = usePassphraseFile
    ? `gpg --batch --yes --no-symkey-cache --pinentry-mode loopback --passphrase-file ${quoteIfNeeded(usePassphraseFile)}`
    : usePassphraseFd
      ? "printf '%s\\n' \"$DECRYPT_KEY\" | gpg --batch --yes --no-symkey-cache --pinentry-mode loopback --passphrase-fd 0"
      : 'gpg --batch --yes --no-symkey-cache --pinentry-mode loopback --passphrase "$DECRYPT_KEY"';
  const decryptGpgCommand = `  ${passMode} -d ${archive}`;

  out('');
  if (passphrase !== null) {
    // The still-secret key goes to stderr so redirecting/capturing stdout
    // (progress, instructions) never picks it up inadvertently.
    out('used generated encryption key: ');
    err(passphrase);
    out('')
  } else if (usePassphraseFile) {
    out(`decryption key: provided via passphrase file ${quoteIfNeeded(usePassphraseFile)}\n`);
  } else {
    out('decryption key: provided via --use-key\n');
  }
  out('deploy instructions:\n');
  if (shownRemote !== String(remote)) {
    out('  (remote credentials were removed from this display; authenticate with your git credential helper or SSH)');
  }
  out('  git clone -b ' + branch + ' ' + shownRemote + ' output_dir && cd output_dir');
  out(decryptGpgCommand + ' | tar xz && BUILD_COMMAND');
}

module.exports = {
  out,
  err,
  printDeployInstructions,
};
