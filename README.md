# Visual Testing

## Installation

1. Install Deno:

```shell
brew install deno
```

2. Install packages

```shell
deno install
```

3. Configure browserless:

This tool requires browserless for visual comparison. Run `docker compose up` to
spin up an instance of browserless. Create a `.env` file based on the
`.env.example`:

```shell
cp .env.example .env
```

Then update the values in your `.env` file:

- `BASE_URL`: Your browserless instance URL. Default is already added in the
  docker-compose.
- `API_TOKEN`: Your browserless API token. Default is already added in the
  docker-compose.

## Usage Examples

Compare production and preview:

```shell
deno --env-file=.env --allow-all compare-prod-and-preview.ts https://zu.com/sitemap-0.xml https://deploy-preview-385--zuc-web.netlify.app
```

Compare a single URL:

```shell
deno --env-file=.env --allow-all compare-single-url.ts https://zu.com/work https://deploy-preview-385--zuc-web.netlify.app/work
```

Compare branches:

```shell
deno --env-file=.env --allow-all compare-branches.ts http://localhost:4321/work test
```
