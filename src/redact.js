'use strict';

const { URL } = require('url');

/** Replace occurrences of one or more secrets in a text string (for log/error redaction). */
function redact(text, secret, replacement = '***REDACTED***') {
  const secrets = (Array.isArray(secret) ? secret : [secret])
    .filter((value) => value && String(value).length >= 4)
    .map(String)
    .sort((a, b) => b.length - a.length); // longest first, so prefixes don't break matches
  let out = String(text);
  for (const value of secrets) out = out.split(value).join(replacement);
  return out;
}

/**
 * Strip userinfo (user:password) from an HTTP(S) URL for display.
 * Non-URL remotes (ssh/scp-like/local paths) are returned unchanged.
 */
function redactUrlCredentials(url) {
  const text = String(url);
  try {
    const parsed = new URL(text);
    // Only HTTP(S) userinfo is credential material. ssh://git@host/... needs
    // the username to stay usable, so leave SSH URLs untouched.
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        (parsed.username || parsed.password)) {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
  } catch (_) { /* not a URL: ssh/scp-like or local path */ }
  return text;
}

/** Strip userinfo from any HTTP(S) URLs embedded in free-form text. */
function redactUrlCredentialsInText(text) {
  return String(text).replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrlCredentials(url));
}

module.exports = { redact, redactUrlCredentials, redactUrlCredentialsInText };
