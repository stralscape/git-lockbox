'use strict';

// Boolean flags: presence only, never consume a value.
const BOOLEAN_FLAGS = new Set(['help', 'generate-key', 'use-passphrase-fd', 'verbose', 'reset-remote-using-force-push']);
// Flags taking a required value.
const VALUE_FLAGS = new Set(['remote', 'branch', 'name', 'github-personal-access-token', 'temp-dir', 'use-key', 'use-key-label', 'use-passphrase-file']);
// Optional-value flag: bare use means "use the default dist folder".
const OPTIONAL_VALUE_FLAGS = new Set(['dist-only']);

const ALL_FLAGS = ['--remote', '--branch', '--name', '--dist-only', '--use-key', '--use-key-label',
  '--use-passphrase-file', '--use-passphrase-fd', '--verbose', '--github-personal-access-token', '--temp-dir', '--generate-key', '--reset-remote-using-force-push', '--help'];

function parseArgs(argv) {
  // Conventional end-of-options separator: only the FIRST "--" is special;
  // everything after it is positional (this tool accepts no positionals, so
  // those tokens error out below).
  const sep = argv.indexOf('--');
  const afterSep = sep === -1 ? [] : argv.slice(sep + 1);
  argv = sep === -1 ? argv : argv.slice(0, sep);
  if (argv.length === 0 && afterSep.length === 0) return { options: {} };

  const options = { _positional: afterSep };
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];

    if (token.startsWith('--')) {
      let key;
      let value;
      if (token.includes('=')) {
        const eq = token.indexOf('=');
        key = token.slice(2, eq);
        value = token.slice(eq + 1);
      } else {
        key = token.slice(2);
      }

      const dotted = '--' + key;
      if (BOOLEAN_FLAGS.has(key)) {
        if (value !== undefined) throw new Error(`${dotted} does not take a value`);
        options[key] = true;
      } else if (OPTIONAL_VALUE_FLAGS.has(key)) {
        if (value === undefined) {
          const next = argv[i + 1];
          // A dash-prefixed token is the next option, not a folder name
          // (a folder literally named "-x" can still be passed as --dist-only=-x).
          if (next !== undefined && !next.startsWith('-')) {
            value = next;
            i += 1;
          }
        }
        // undefined value = bare --dist-only (use the default dist folder);
        // an explicitly empty value is invalid.
        if (value === '') {
          throw new Error(`${dotted} requires a folder name; omit the value entirely or pass a folder`);
        }
        options[key] = value === undefined ? true : value;
      } else if (VALUE_FLAGS.has(key)) {
        if (value === undefined) {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith('--')) {
            throw new Error(`Option ${dotted} requires a value (e.g. ${dotted} <value>)`);
          }
          value = next;
          i += 1;
        }
        if (value === '') {
          throw new Error(`Option ${dotted} requires a non-empty value`);
        }
        options[key] = value;
      } else {
        throw new Error(`Unknown option ${dotted}. Available: ${ALL_FLAGS.join(', ')}`);
      }
      i += 1;
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      throw new Error(`Unknown option "${token}" (use long option names: ${ALL_FLAGS.join(', ')})`);
    }
    options._positional.push(token);
    i += 1;
  }

  if (options._positional.length > 0) {
    throw new Error(
      `Unexpected argument "${options._positional[0]}". ` +
        'This tool has no subcommands - just run git-lockbox with options.'
    );
  }

  return { options, showHelp: Boolean(options.help) };
}

module.exports = { parseArgs };
