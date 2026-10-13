# Searchlock

One MCP server for free web search. Searchlock queries DuckDuckGo and Brave
together behind a single `search` tool, reads pages through `fetch_content`,
and needs no API key.

> [!NOTE]
> Searchlock talks to the public DuckDuckGo and Brave endpoints directly.
> Results can vary if those pages change, and Brave rate limits anonymous
> traffic more aggressively than DuckDuckGo.

## Quick start

Requires [Bun](https://bun.sh) 1.0 or newer. No install needed:

```bash
bunx searchlock
```

That starts the server on `stdio`, which is what Claude Desktop and Claude
Code expect. Everything after the command is options:

```bash
bunx searchlock --safesearch strict --ddg-region us-en
bunx searchlock --transport streamable-http --port 8000
bunx searchlock --version
```

### Claude Desktop

```json
{
    "mcpServers": {
        "searchlock": {
            "command": "bunx",
            "args": ["searchlock"]
        }
    }
}
```

With options set through the environment:

```json
{
    "mcpServers": {
        "searchlock": {
            "command": "bunx",
            "args": ["searchlock", "--safesearch", "strict"],
            "env": {
                "SEARCHLOCK_DDG_REGION": "us-en"
            }
        }
    }
}
```

### Claude Code

```bash
claude mcp add searchlock bunx searchlock
```

## Tools

| Tool | What it does |
| --- | --- |
| `search` | Search DuckDuckGo and Brave together and return one merged answer. `provider` picks `both` (default), `ddg`, or `brave`. `vertical` picks `web` (default), `news`, `images`, or `videos`. DuckDuckGo serves the `web` vertical only. |
| `suggest` | Autocomplete suggestions for a partial query, via Brave. |
| `fetch_content` | Read any result URL as plain text, with pagination (`start_index`, `max_length`) and extractors (`text`, `main`, `markdown`). |
| `expand_link` | Turn a shortened `ref://` token from search output back into the full URL. |

Each provider runs independently. If one fails, the other still answers and
the failure shows up as a note under the results instead of failing the
whole call.

## Configuration

Every setting is an environment variable, and the common ones also have CLI
flags that override it. Defaults are shown in parentheses.

| Flag | Variable | Purpose |
| --- | --- | --- |
| `--safesearch` | `SEARCHLOCK_SAFESEARCH` | `off`, `moderate` (default), or `strict`. Applies to both providers. |
| `--ddg-region` | `SEARCHLOCK_DDG_REGION` | Default DuckDuckGo region, for example `us-en`. Empty by default. |
| | `SEARCHLOCK_BRAVE_COUNTRY` | Brave country code, for example `us` (default). |
| | `SEARCHLOCK_BRAVE_LANGUAGE` | Brave language code, for example `en` (default). |
| | `SEARCHLOCK_SEARCH_RPM` | DuckDuckGo search budget per minute (30). |
| | `SEARCHLOCK_FETCH_RPM` | `fetch_content` budget per minute (20). |
| | `SEARCHLOCK_FETCH_HOST_RPM` | Per-host fetch budget (0 means off). |
| | `SEARCHLOCK_RATE_LIMIT_STRATEGY` | `sliding` (default) or `token_bucket`. |
| `--parse-mode` | `SEARCHLOCK_PARSE_MODE` | `fetch_content` extractor: `text` (default), `main`, or `markdown`. |
| | `SEARCHLOCK_CACHE_TTL` | Seconds a fetched page stays cached for paginated reads (300, 0 disables). |
| | `SEARCHLOCK_CACHE_MAX_ENTRIES` | Pages kept in the fetch cache (64, 0 disables). |
| | `SEARCHLOCK_REF_URL_THRESHOLD` | Result URLs longer than this become short `ref://` tokens (120, 0 disables). |
| | `SEARCHLOCK_BRAVE_TIMEOUT` | Seconds per Brave request (120). |
| | `SEARCHLOCK_BRAVE_MAX_RETRIES` | Brave request retries (3). |
| | `SEARCHLOCK_PROXY_LIST` | Comma-separated proxy URLs for Brave traffic. |
| `--allow-private-urls` | `SEARCHLOCK_ALLOW_PRIVATE_URLS` | Let `fetch_content` reach private addresses. Keep off unless the deployment is trusted. |

### HTTP transport

```bash
bunx searchlock --transport streamable-http --host 127.0.0.1 --port 8000
```

> [!WARNING]
> `fetch_content` refuses private, loopback, link-local, and cloud metadata
> addresses by default, and re-checks every redirect. Only relax this on a
> trusted network.

## Development

```bash
bun install
bun test tests/unit.test.ts
bunx tsc --noEmit
bun run tests/live.ts
bun run tests/e2e.ts
```

`bun test` runs offline. `bun run tests/live.ts` exercises the real
endpoints end to end; a provider that rate limits the network reports SKIP
instead of failing the run. `bun run tests/e2e.ts` drives the finished
server over the MCP protocol the way an agent would: merged search across
verticals, following a result into `fetch_content` with pagination and
cache checks, the `ref://` token round trip, the SSRF refusal, and bad
input handling.
