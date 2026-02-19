# Visual Testing

## Installation

1. Install Deno:

```sh
brew install deno
```

2. Start browserless:

```sh
docker compose up -d
```

3. Configure environment variables:

```sh
cp .env.example .env
```

Set these values in `.env`:

- `BASE_URL`: browserless URL (default local: `http://localhost:3000`)
- `API_TOKEN`: browserless API token

## Commands

Run all commands with Deno tasks:

```sh
deno task <task-name> <args>
```

Available tasks:

- `ui`
- `compare:prod-preview`
- `compare:url`
- `compare:branches`
- `sitemap:screenshots`
- `sitemap:open`
- `check`
- `test`

## Interactive launcher

Run the prompt-based task launcher:

```sh
deno task ui
```

Useful launcher flags:

- `--task <task-id>`: preselect a task and skip the menu
- `--advanced`: show advanced tasks (`check`, `test`) and advanced fields
- `--dry-run`: print the resolved command without running it
- `--no-history`: do not read/write saved values for this run

The launcher remembers last-used values per task in:
`/Users/tanmay/GitHub/visual-testing/.cache/task-launcher-history.json`

Dry-run example:

```sh
deno task ui --task compare:url --dry-run
```

## Usage

Compare production and preview via sitemap:

```sh
deno task compare:prod-preview https://zu.com/sitemap-0.xml https://deploy-preview-385--zuc-web.netlify.app
```

Compare a single URL:

```sh
deno task compare:url https://zu.com/work https://deploy-preview-385--zuc-web.netlify.app/work
```

Compare branches for one URL:

```sh
deno task compare:branches http://localhost:4321/work test
```

Take screenshots for sitemap URLs:

```sh
deno task sitemap:screenshots https://example.com/sitemap.xml
```

Open sitemap URLs in Safari:

```sh
deno task sitemap:open https://example.com/sitemap.xml
```

## Common optional flags

Most scripts support these optional flags:

- `--timeout-ms <ms>`
- `--retries <n>`
- `--retry-delay-ms <ms>`
- `--max-urls <n>`
- `--help`

Script-specific flags include:

- `compare:prod-preview`: `--concurrency`, `--comparison-concurrency`,
  `--file-io-concurrency`, `--cache-ttl-ms`, `--cache-cleanup-age-ms`,
  `--no-cache`, `--run-name`
- `compare:url`: `--run-name`
- `compare:branches`: `--run-name`
- `sitemap:screenshots`: `--concurrency`
- `sitemap:open`: `--concurrency`, `--yes`

## Diff output organization

Visual diff images are written to run-specific subfolders so runs do not mix
files:

- `compare:prod-preview`:
  `/Users/tanmay/GitHub/visual-testing/changes/prod-preview-<timestamp>/`
- `compare:url`:
  `/Users/tanmay/GitHub/visual-testing/changes/single-url-<timestamp>/`
- `compare:branches`:
  `/Users/tanmay/visual-testing-compare/changes/branch-compare-<timestamp>/`

Use `--run-name <name>` to include a readable label in the folder name.

## Branch compare precondition

`compare:branches` exits immediately if the git working tree has tracked or
untracked changes. Run it only from a clean working tree.

## Validation

Run static validation:

```sh
deno task check
```
