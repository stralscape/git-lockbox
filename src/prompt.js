'use strict';

// Interactive prompts (zero npm deps).
// Questions go to stdout; all tool logging goes to stderr, keeping both streams clean.
//
// Prompts only happen on a real TTY. Piped stdin is never interactive, so
// automation must pass every answer as a flag (e.g. --remote) and never has
// its stdin stream consumed by a prompt.

const readline = require('node:readline/promises');
const { stdin, stdout } = require('process');

let rl = null;

function isInteractive() {
  return Boolean(stdin.isTTY);
}

/** Ask a question and return the trimmed answer ('' means abort/fallback). */
async function ask(question, { fallback = '' } = {}) {
  if (!isInteractive()) return fallback;
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await getRl().question(`${question}${suffix}: `)).trim();
  return answer === '' ? fallback : answer;
}

function getRl() {
  if (!rl) rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
  return rl;
}

/** Release the shared TTY interface (call once at the end of the run). */
function closeRl() {
  if (rl) {
    try { rl.close(); } catch (_) { /* noop */ }
    rl = null;
  }
}

module.exports = { isInteractive, ask, closeRl };
