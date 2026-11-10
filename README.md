# git-lockbox

**Deploy from GitHub without trusting it with your code.**

Encrypt a local source repository with GPG and push it as a new commit to a remote destination repository for deployment.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js ≥ 17](https://img.shields.io/badge/node-%E2%89%A517-brightgreen)
![Dependencies: zero](https://img.shields.io/badge/dependencies-zero-brightgreen)

Most hosting platforms deploy by cloning a GitHub repository, which means the platform — and anyone with repo access — can read your source at rest. **git-lockbox** is here to break that dependency.

```
your repo ──▶ archive + encrypt ──▶ GitHub (ciphertext only) ──▶ clone + decrypt ──▶ build
```

Each run packages the committed tree (or a working-tree folder such as `dist/`), encrypts it with GPG under a generated passphrase and appends the ciphertext as one commit to the default branch of the specified destination repository. Every commit holds just one opaque `.gpg` file — no source, no file list. Plaintext appears only after clone, on the deploy machine. Zero npm dependencies — just Node, `git` and `gpg` on PATH.

## Quickstart

First, create your destination repository (e.g. `github.com/your/encrypted-destination-repository` on GitHub).  
**git-lockbox** appends the encrypted archive to an existing repository — it does not create one for you. An empty repository is fine; deploys are appended to the `main` branch of the destination, which is created automatically on the first push (customize this option with `--branch`).

Install it globally from npm:

```bash
npm install -g git-lockbox
```

Or install from source:

```bash
git clone <this-repo-url> git-lockbox
cd git-lockbox && npm install -g .
```

Then, from the repository you want to deploy:

```bash
cd /path/to/your/repo
git-lockbox
# or pass the destination directly
git-lockbox --remote git@github.com:your/encrypted-destination-repository.git
```

No global install? `npx git-lockbox ...` runs it in place.

Without `--remote` it prompts interactively. Each run appends one deploy commit and ends by printing the generated passphrase once plus a ready-to-run deploy command.

## On the deployment machine

1. Put the passphrase in `DECRYPT_KEY` — an environment variable, a secrets file or whatever your platform provides. Avoid a literal assignment that lands in shell history.
2. Clone the destination and decrypt in place:

   ```bash
   git clone -b main git@github.com:your/encrypted-destination-repository.git app && cd app
   gpg --batch --yes --no-symkey-cache --pinentry-mode loopback \
       --passphrase "$DECRYPT_KEY" -d lockbox.tgz.gpg | tar xz
   # then whatever your stack needs: install & build
   ```

   With `--use-passphrase-file`, encrypt/decrypt using a passphrase file instead:

   ```bash
   gpg --batch --yes --no-symkey-cache --pinentry-mode loopback \
       --passphrase-file /path/to/passphrase.txt -d lockbox.tgz.gpg | tar xz
   ```

## How it works

- **Fresh key per run** — use the generated 32 random bytes passphrase (`crypto.randomBytes`) or supply a fixed key via `--use-key` / `--use-passphrase-file`.
- **Streamed encryption** — `git archive` (whole tree) or `tar` a specific dist folder (`--dist-only`) which pipes straight into gpg (`AES256`, `--no-symkey-cache`); no plaintext file is ever written.
- **Append-only deploy** — the ciphertext is committed straight into a bare object database (`hash-object`, `mktree`, `commit-tree`) and pushed fast-forward only.

Deploy commits are a single space-free line, parsed by position — `<source HEAD sha>_<optional key label>_<ISO-UTC timestamp>`, e.g. `a1b2…_secretkey01_2026-10-31T14:00:00Z`. Because deploys only append, the branch history doubles as a deploy ledger.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--remote <url>` | prompted | destination repo receiving the encrypted archive |
| `--branch <name>` | `main` | branch deploys are appended to (one commit per run) |
| `--name <file>` | `lockbox.tgz.gpg` | file name in the destination repo (`.gpg` appended if missing) |
| `--dist-only [folder]` | entire tracked tree | package a working-tree folder as-is; bare flag = `dist`; needs `tar` |
| `--github-personal-access-token <token>` | ambient git auth | PAT for private HTTPS remotes; redacted from logs; prefer SSH |
| `--use-key <key>` | generated per run | fixed passphrase (min 16 chars); never re-printed |
| `--use-key-label <label>` | none | key nickname in the commit message; requires a fixed key |
| `--use-passphrase-file <path>` | per-run key | passphrase = first line of the file; exclusive with `--use-key` |
| `--verbose` | quiet | full progress output |
| `--generate-key` | — | print a new random key to stdout and exit |
| `--temp-dir <path>` | `<repo>/.git` | base for run artifacts |
| `--reset-remote-using-force-push` | off | force-push a fresh deploy commit, replacing the destination branch history instead of appending; previous deploy artifacts become unrecoverable |

Run `git-lockbox --help` for the full reference.

## Security

- **Per-run keys** are printed once; lose one and that artifact is unrecoverable — re-run instead. Old deploys stay reachable in history (unless wiped by `--reset-remote-using-force-push` flag).
- **Fixed keys** trade rotation for reuse: one leak unlocks every artifact pushed under that key. Rotate by switching keys and bumping `--use-key-label`.
- **No plaintext on disk** — run artifacts live in `<repo>/.git/git-lockbox-run-<timestamp>/`; the only disk artifact is the `.gpg` file, deleted once committed.
- **No telemetry, no server, no lock-in** — the only network calls are one `git fetch` and one `git push`; the format is standard OpenPGP AES-256 over a gzipped tar, decryptable with stock `gpg` and `tar`.

## Requirements

**Node.js ≥ 17** · **git** and **gpg** on PATH (GnuPG ≥ 2.2.7) · **tar** to extract (on the producer only for `--dist-only`) · **Windows:** if PowerShell blocks npm's `.ps1` shims, run `git-lockbox.cmd` or use cmd/bash

## Contributing

Bug fixes and features are welcome via pull requests — see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security vulnerabilities privately rather than opening a public issue.

## License

[MIT](LICENSE)
