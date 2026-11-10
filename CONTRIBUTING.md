# Contributing to git-lockbox

Thanks for helping out! Bug fixes and features are welcome via pull requests.

## Getting started

Prerequisites: **Node.js ≥ 17**, **git**, **gpg** (GnuPG ≥ 2.2.7) and **tar** on PATH.

```bash
git clone <this-repo-url> git-lockbox
cd git-lockbox && npm install -g .
```

That's the whole setup — the project has **zero npm dependencies** by design. Everything runs on the Node standard library (CommonJS modules, `'use strict'`), so a fresh clone is instantly runnable.

To smoke-test a change locally without touching GitHub, push to a throwaway bare repo:

```bash
git init --bare /tmp/deploy.git
cd /path/to/any/repo
git-lockbox --remote /tmp/deploy.git -v
# then verify the artifact decrypts:
git clone /tmp/deploy.git check && cd check
gpg -d lockbox.tgz.gpg | tar xz
```

## PR guidelines

- **One change per PR.** A bug fix or a feature, not both. Unrelated cleanup belongs in its own PR.
- **A flag lives in three places and all three must stay in sync:** `src/args.js` (parsing/registration), the help text in `bin/git-lockbox.js` (plus the `resolveOptions()` wiring), and the options table in `README.md`. If a PR adds or changes a CLI flag, update all of them in the same PR.
- **No new dependencies.** If the feature genuinely cannot be done with the standard library, explain why in the PR description.
- **Preserve the security invariants.** Never write plaintext artifacts to disk, never log or echo key material when not needed, keep keys/tokens redacted in all output and error paths.
