# shrt

A fast, self-contained URL shortener for the command line.

`shrt` works in two modes that share the same code:

- **Remote (default).** Delegates to public shortening APIs — `is.gd` by default, with `tinyurl` and `cleanuri` as automatic fallbacks. **Zero config, no API keys**: a brand-new install produces a working short URL from a single command.
- **Local (self-hosted).** Stores mappings in a local SQLite database and serves redirects from a tiny built-in HTTP server. No external services required.

It is a polished Unix citizen: reads URLs from arguments, stdin, or a file; emits clean machine-parseable output for scripts and pretty colorized output for humans; returns meaningful exit codes; and keeps a searchable history of every link.

```console
$ shrt https://example.com/some/very/long/path/to/a/resource
✓ https://is.gd/Ab3xYz   (remote · is.gd · 142ms)
  ↳ https://example.com/some/very/long/path/to/a/resource
```

---

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Modes](#modes)
- [Commands](#commands)
  - [`shorten` (default)](#shorten-default)
  - [`expand`](#expand)
  - [`list`](#list)
  - [`stats`](#stats)
  - [`delete`](#delete)
  - [`serve`](#serve)
  - [`config`](#config)
- [Global flags](#global-flags)
- [Output modes](#output-modes)
- [Configuration](#configuration)
- [Remote providers](#remote-providers)
- [Security: the SSRF guard](#security-the-ssrf-guard)
- [Exit codes](#exit-codes)
- [How it works](#how-it-works)
- [Development & testing](#development--testing)

---

## Install

Requires **Node.js ≥ 18** (uses the built-in `fetch`). Node 20+ recommended.

```bash
# from a clone of this repo
npm install        # installs deps and compiles better-sqlite3 (prebuilt binary on most platforms)
npm link           # puts `shrt` on your PATH

# or run without linking
node bin/shrt.js --help
```

The only "heavy" dependency is `better-sqlite3` (an embedded database); everything else is pure JavaScript. No database server, and no API keys, are required.

## Quick start

```bash
shrt https://example.com/very/long/path          # shorten via is.gd (default)
shrt url1 url2 url3                                # several at once
echo https://example.com | shrt                   # from stdin
cat urls.txt | shrt -q                             # batch from stdin, pipe-friendly
shrt -f urls.txt                                   # batch from a file

shrt -m local https://example.com                  # store a local mapping
shrt serve                                          # serve local redirects on :8787
#   → visiting http://localhost:8787/<code> now 302-redirects to the original

shrt list                                           # browse history
shrt expand https://is.gd/Ab3xYz                   # resolve a short URL
shrt -j https://example.com | jq -r '.[0].shortUrl' # script-friendly JSON
```

## Modes

| | **Remote** (default) | **Local** (self-hosted) |
|---|---|---|
| Where the short URL points | a public shortener (`is.gd`, …) | `http://localhost:8787/<code>` (your machine) |
| Needs the internet | yes | no |
| Needs `shrt serve` running to redirect | no (the provider hosts it) | yes |
| Custom aliases (`--alias`) | no | yes |
| Hit analytics | no | yes (counted by the local server) |
| Private/internal URLs allowed | no (blocked by the SSRF guard) | yes (you're hosting it yourself) |

Switch per-command with `-m local` / `-m remote`, or set a default with `shrt config set mode local`.

---

## Commands

Every command supports the [global flags](#global-flags) (`-j/--json`, `-q/--quiet`, `-v/--verbose`, `--no-color`).

### `shorten` (default)

Shorten one or more URLs. This is the default command, so `shrt <url>` and `shrt shorten <url>` are equivalent.

```bash
shrt <url> [url...]
shrt shorten <url> [url...]
```

| Flag | Description |
|---|---|
| `-m, --mode <local\|remote>` | Override the configured mode for this run. |
| `-p, --provider <name>` | Force a specific remote provider (`is.gd`, `tinyurl`, `cleanuri`); skips the fallback chain. |
| `-a, --alias <code>` | **Local only.** Request a custom short code (letters, digits, `_`, `-`; ≤64 chars). |
| `--tags <a,b,c>` | Attach comma-separated tags to the history entry. |
| `--force` | Bypass dedupe and create a fresh mapping/request. |
| `--qr` | Also render an ASCII QR code of the short URL. |
| `-c, --copy` | Copy the first resulting short URL to the clipboard. |
| `-f, --file <path>` | Read newline-separated URLs from a file (`#` comments allowed). |
| `--timeout <ms>` | Network timeout for this run. |
| `--allow-private` | Allow private/loopback hosts (overrides the SSRF guard). |

Examples:

```bash
shrt https://example.com/page                      # remote (is.gd → tinyurl → cleanuri)
shrt -p tinyurl https://example.com/page           # force tinyurl, no fallback
shrt -m local --alias docs https://example.com/d   # http://localhost:8787/docs
shrt --tags work,launch https://example.com        # tag for later search
shrt --qr -c https://example.com                   # QR + copy to clipboard
shrt -f urls.txt -q | xargs -n1 echo SHORT:        # batch, pipe-friendly
```

Input is collected from **args**, then **`-f` file**, then **stdin** (stdin is read only when no args/file are given, so the tool never hangs in a script). Duplicate inputs — and URLs that normalize to the same address — are de-duplicated within the batch.

### `expand`

Resolve a short URL or local code back to its destination.

```bash
shrt expand <shortUrlOrCode>
```

- A **local code or local short URL** is resolved instantly from the database.
- A **remote short URL** is resolved over HTTP, following redirects (with the SSRF guard applied to every hop) and reporting the final destination and hop count.

```bash
shrt expand docs                                   # local code → original URL
shrt expand https://is.gd/Ab3xYz                   # remote → follows redirects
shrt -j expand https://is.gd/Ab3xYz                # {input, resolved, mode, hops}
```

### `list`

List and search your history. Alias: `shrt ls`.

```bash
shrt list [--search <text>] [--mode local|remote] [--limit <n>] [--all] [--sort created|hits]
```

| Flag | Description |
|---|---|
| `--search <text>` | Substring match on long URL, short URL, and tags. |
| `--mode <local\|remote>` | Filter by mode. |
| `--limit <n>` | Maximum rows (default 20). |
| `--all` | Show all rows. |
| `--sort <created\|hits>` | Sort by recency (default) or hit count. |

```bash
shrt list
shrt list --search github --sort hits
shrt -j list --all | jq '.[] | {code, hits}'
```

### `stats`

Show aggregate statistics, or the full record for one link.

```bash
shrt stats            # summary: total links, total hits, top 5 by hits
shrt stats <code>     # full record for one code/id
```

### `delete`

Remove a history entry / local mapping. Alias: `shrt rm`. After deleting a local code, its redirect immediately 404s.

```bash
shrt delete <codeOrId> [--yes]
```

`--yes` skips the confirmation prompt. In a non-interactive context (a pipe, or `--json`) `--yes` is **required** — `shrt` never blocks on a prompt in a pipeline.

### `serve`

Run the local redirect server.

```bash
shrt serve [--port <n>] [--host <host>] [--daemon] [--stop] [--status]
```

| Flag | Description |
|---|---|
| `--port <n>` | Port to bind (default from config: `8787`; `0` = pick a free port). |
| `--host <host>` | Interface to bind (default `127.0.0.1`). |
| `--daemon` | Run detached in the background (PID + logs under the config dir). |
| `--stop` | Stop a running background server (SIGTERM via the PID file). |
| `--status` | Report whether the server is running. |

Routes:

| Route | Behavior |
|---|---|
| `GET /<code>` | `302` redirect to the original URL; increments `hits` and `last_hit_at`. |
| `HEAD /<code>` | `302` redirect **without** counting a hit. |
| `GET /` | Minimal status page (link count + uptime). |
| `GET /healthz` | `200 ok` (health check). |
| `GET /robots.txt` | Disallow all (short links shouldn't be crawled). |
| _unknown code_ | `404` with a small HTML page. |

```bash
shrt serve                       # foreground, logs requests, Ctrl+C to stop
shrt serve --daemon --port 9000  # background
shrt serve --status
shrt serve --stop
```

The server shuts down gracefully on `SIGINT`/`SIGTERM` (stops accepting, drains, closes the DB).

### `config`

Get/set/reset configuration and print file locations.

```bash
shrt config get [key]           # one value, or the whole resolved config
shrt config set <key> <value>   # validate and persist to config.json
shrt config reset [--yes]       # restore defaults
shrt config path                # print config + db + pid + log paths
```

```bash
shrt config get                       # whole config
shrt config -v get                    # annotate each value with its source
shrt config set mode local
shrt config set providerFallback tinyurl,cleanuri
shrt config path
```

---

## Global flags

| Flag | Description |
|---|---|
| `-j, --json` | Machine-readable JSON on stdout (logs/warnings stay on stderr). |
| `-q, --quiet` | Print only the essential output (short URLs), one per line — pipe-safe. |
| `-v, --verbose` | Verbose diagnostics on stderr (provider attempts, timings, DB path). |
| `--no-color` | Disable ANSI color (also honors `NO_COLOR` and non-TTY auto-detect). |
| `--config <path>` | Use an alternate config file. |
| `--db <path>` | Use an alternate database file. |
| `-V, --version` / `-h, --help` | Standard. |

> Tip: global flags can go before the command (`shrt --no-color list`); `-j`/`-q`/`-v` also work after it (`shrt list -j`).

## Output modes

- **Human (default):** colorized blocks — the short URL in bright cyan, the source dimmed beneath it, provider/mode/timing in the margin. Successes go to **stdout**, failures to **stderr**, so even human output pipes cleanly.
- **Quiet (`-q`):** only the resulting short URL(s), newline-separated, no color, no metadata. Built for `xargs`/`pbcopy`/etc.
- **JSON (`-j`):** a pretty-printed array on stdout; each element is `{ input, shortUrl, code, mode, provider, ms, deduped, error, meta }`. Nothing but JSON ever touches stdout in this mode.

Color is enabled only when the output is a TTY, and is disabled by `--no-color`, `NO_COLOR`, or `color = never`. A spinner appears on a TTY for network/multi-URL work and never leaks into pipes.

---

## Configuration

Config lives at `~/.config/shrt/config.json` (respecting `XDG_CONFIG_HOME`). Values are merged with this precedence:

```
CLI flags  >  environment variables  >  config.json  >  built-in defaults
```

A malformed config file degrades to defaults with a warning rather than crashing; an invalid value in the file or environment is ignored (with a warning) while valid ones still apply.

### Config file shape

```json
{
  "mode": "remote",
  "provider": "is.gd",
  "providerFallback": ["tinyurl", "cleanuri"],
  "localBaseUrl": "http://localhost:8787",
  "serverPort": 8787,
  "codeLength": 7,
  "timeoutMs": 8000,
  "color": "auto",
  "copyToClipboard": false,
  "allowPrivateHosts": false
}
```

### Keys

| Key | Type | Valid values | Default |
|---|---|---|---|
| `mode` | string | `local`, `remote` | `remote` |
| `provider` | string | `is.gd`, `tinyurl`, `cleanuri` | `is.gd` |
| `providerFallback` | string[] | any of the provider names | `["tinyurl","cleanuri"]` |
| `localBaseUrl` | string | http(s) URL | `http://localhost:8787` |
| `serverPort` | number | 1–65535 | `8787` |
| `codeLength` | number | 4–16 | `7` |
| `timeoutMs` | number | 1000–60000 | `8000` |
| `color` | string | `auto`, `always`, `never` | `auto` |
| `copyToClipboard` | boolean | `true`/`false` | `false` |
| `allowPrivateHosts` | boolean | `true`/`false` | `false` |

Invalid values are rejected with the offending key named:

```console
$ shrt config set serverPort 99999
✗ invalid value for serverPort: serverPort must be an integer 1–65535
```

### Environment variables

Every key has a `SHRT_`-prefixed environment override:

`SHRT_MODE`, `SHRT_PROVIDER`, `SHRT_PROVIDER_FALLBACK` (comma-separated), `SHRT_LOCAL_BASE_URL`, `SHRT_SERVER_PORT`, `SHRT_CODE_LENGTH`, `SHRT_TIMEOUT_MS`, `SHRT_COLOR`, `SHRT_COPY_TO_CLIPBOARD`, `SHRT_ALLOW_PRIVATE_HOSTS`.

Also honored: `NO_COLOR` (disable color), `FORCE_COLOR` (force color).

### Provider endpoint overrides

For corporate proxies, self-hosted is.gd-compatible mirrors (e.g. YOURLS), air-gapped testing, or pointing at a stub, you can override each provider's endpoint:

```
SHRT_ISGD_ENDPOINT       (default https://is.gd/create.php)
SHRT_TINYURL_ENDPOINT    (default https://tinyurl.com/api-create.php)
SHRT_CLEANURI_ENDPOINT   (default https://cleanuri.com/api/v1/shorten)
```

## Remote providers

The primary provider is tried first; on a network error, timeout, or provider-level error, `shrt` advances down `providerFallback` and records which provider ultimately succeeded. Every request carries a descriptive `User-Agent` and is bounded by `timeoutMs` via `AbortController`. A returned value is accepted only if it parses as an http(s) URL **and** is shorter than the input — guarding against providers that answer `200 OK` with an error sentence in the body.

| Provider | Method | Notes |
|---|---|---|
| `is.gd` | `GET /create.php?format=simple` | Plain-text response. Default. |
| `tinyurl` | `GET /api-create.php` | Plain-text response. |
| `cleanuri` | `POST /api/v1/shorten` | JSON `{ result_url }` / `{ error }`. |

## Security: the SSRF guard

Because a shortener resolves and/or submits arbitrary URLs, it can be abused as a Server-Side Request Forgery pivot (for example to reach cloud metadata at `169.254.169.254`). By default `shrt` **blocks** loopback, RFC1918 private, CGNAT, and link-local addresses, `*.local`/`*.localhost`, and non-FQDN hosts for **remote submission** and **`expand` resolution** (every redirect hop is re-checked).

This guard does **not** apply to **local-mode shortening** — you're self-hosting, so pointing a local code at an internal address is expected. Override the guard when you mean to with `--allow-private` or `allowPrivateHosts: true`.

## Exit codes

Loosely following `sysexits(3)`, so `shrt` behaves in pipelines and CI:

| Code | Meaning |
|---|---|
| `0` | All URLs succeeded. |
| `1` | Total failure (no URL succeeded). |
| `2` | Partial success (some succeeded, some failed). |
| `64` | Usage error (bad invocation, empty input, invalid flag/config value). |
| `66` | Input file missing/unreadable (`-f`). |
| `70` | Internal / database error. |
| `75` | Server bind error (port already in use). |

```bash
shrt "$URL" >/dev/null && echo "ok" || echo "failed ($?)"
```

## How it works

`shrt` stores every shorten operation in a SQLite database (`~/.config/shrt/shrt.db`) using WAL mode, with idempotent migrations tracked by a `schema_version`. Local mode dedupes a URL forever (same URL → same code, since you own the namespace); remote mode dedupes an identical URL only within a 24-hour window (to avoid hammering the public APIs while still letting you re-shorten later). Auto-generated codes use a 7-character alphabet that omits ambiguous characters (`0/o/1/l`) so they survive being read aloud or retyped.

```
shrt/
├── bin/shrt.js            # entry point
├── src/
│   ├── cli.js             # commander wiring, run loop, exit-code mapping
│   ├── context.js         # builds the per-command context
│   ├── config.js          # defaults, XDG paths, merge, validation
│   ├── db.js              # SQLite — the ONLY module containing SQL
│   ├── validate.js        # URL normalize + SSRF guard
│   ├── shorten.js         # orchestrator (local/remote, dedupe, persist)
│   ├── codes.js           # short-code generation + collision retry
│   ├── output.js          # plain/json/table/color, spinner, QR
│   ├── input.js           # collect URLs from args/file/stdin
│   ├── clipboard.js       # best-effort copy
│   ├── server.js          # local redirect HTTP server
│   ├── providers/         # is.gd / tinyurl / cleanuri + fallback chain
│   └── commands/          # one module per subcommand
└── test/                  # node:test suite + e2e CLI spawn test
```

## Development & testing

```bash
npm test            # run the full suite (node:test, no external services)
npm run test:watch  # watch mode
```

The suite covers URL validation/normalization and the SSRF guard, code generation and collision retry, provider success/failure/fallback (against a stubbed `fetch`), database CRUD + dedupe, the orchestrator, output formatting, the redirect server (real HTTP requests), and an **end-to-end test that spawns the real `shrt` binary** against a local stub provider server and a live `serve` subprocess. No network access is required to run the tests.

## License

MIT
