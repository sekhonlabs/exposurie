# Optional cloud brain

The brain remains plain Markdown on the laptop. An optional private cloud copy
provides `search`, `fetch`, `dates`, `brain_rules`, `create_page`, `update_page`
and `brain_status` over MCP for clients without a local filesystem. The local
CLI mirrors curated files in both directions. Conversation ingestion remains
the separate, manually requested `exposurie sync` workflow.

No cloud account is needed for normal local use. Installing this package does
not deploy a server, connect a ChatGPT account, schedule work or copy data.

## Host the example

The [Cloudflare example](../examples/cloudflare/) contains a Worker adapter and
D1 migration. It imports the shared code in `src/cloud/` and has no additional
npm runtime dependencies. Other hosts can reuse `createCloudHandler` with a
Web Request/Response runtime and a D1-compatible store adapter.

From a checkout containing this feature:

```sh
cd examples/cloudflare
npx wrangler login
npx wrangler d1 create exposurie-brain
```

Put the returned database ID in `wrangler.jsonc`. Set `PUBLIC_ORIGIN` to the
server's bare HTTPS origin and `OAUTH_ISSUER` to an OAuth provider's exact issuer
URL. Set `BRAIN_TIME_ZONE` to the timezone used for cloud page updates (default
UTC). Configure an established OAuth provider for authorization code login with
PKCE S256 and client registration accepted by ChatGPT. Create the API audience
`https://your-host.example/mcp` and scopes `brain.read` and `brain.write`.

The verifier accepts RS256 JWT access tokens. The issuer must publish OIDC
discovery and HTTPS JWKS endpoints. Tokens must contain the exact issuer,
resource audience, an unexpired `exp`, the requested scopes and the owner's
stable `sub`. Configure only that owner subject. Identity headers supplied by
HTTP callers do not grant access. The OAuth provider handles login, consent,
client registration and token refresh; this example is a resource server.

The [official authenticated MCP example](https://github.com/openai/openai-apps-sdk-examples/tree/main/authenticated_server_python)
describes an Auth0 setup. Follow the current [ChatGPT OAuth guide](https://developers.openai.com/plugins/build/auth)
for provider registration and resource indicators. The resource server exposes
`/.well-known/oauth-protected-resource`, per-tool OAuth schemes and
`mcp/www_authenticate` challenges. ChatGPT uses OAuth; the local sync secret
below is a separate credential for the laptop.

Create a random sync token with at least 32 characters using your secret manager.
Store the same value as a Worker secret and in the local secret manager. Store
the owner's OAuth subject as a secret too:

```sh
npx wrangler secret put OWNER_SUBJECT
npx wrangler secret put EXPOSURIE_SYNC_TOKEN
npx wrangler d1 migrations apply exposurie-brain --remote
npx wrangler deploy
```

The migration creates tables and revision triggers only; no knowledge or account
data is bundled. For a build check without deployment:

```sh
npx wrangler deploy --dry-run --outdir /tmp/exposurie-worker-build
```

## Configure the local mirror

Review the brain schema and write `.exposurie/source-policy.md` inside the
vault, stating which sources and topics may be saved, which remain excluded
and that saves need user authorization. If existing exclusions live in
`config.json`, restate the relevant rules in this policy before mirroring.
The policy is required for cloud sync and cloud saves. A renamed policy may be
configured with `sourcePolicy` in the vault config and `BRAIN_SOURCE_POLICY`
on the server; it must be a Markdown file directly inside `.exposurie/`.

Configure the server and run the first mirror with `EXPOSURIE_SYNC_TOKEN`
provided by your environment or secret manager:

```sh
exposurie cloud configure --url https://your-host.example --at ~/brain
exposurie cloud sync --at ~/brain --json
exposurie cloud status --at ~/brain --json
```

`--token-env NAME` chooses another environment variable. The command stores
only the URL and variable name in `.exposurie/cloud.json`, never the token.
Existing vaults should add `.exposurie/cloud.json` and `.exposurie/cloud-sync/`
to `.gitignore`; new scaffolds already ignore both.

Only configured curated categories and an explicit allowlist of schema,
source policy, procedures, page templates, catalog and log are mirrored. Raw
sources, chat archives, staging, checkpoints, credentials and Git history are
outside the protocol. Protected paths and symlinks are rejected before reading
bodies. A source policy is reviewed guidance, not an automatic content filter:
curate permitted facts before placing them in mirrored pages.

Renamed categories must match on both ends: set `BRAIN_CATEGORIES` to a JSON
object with the same category paths as the local config. Nested pages work.
If the catalog/log are renamed, set `BRAIN_INDEX`/`BRAIN_LOG`; they must be
top-level Markdown files. Configure a custom raw directory with `BRAIN_RAW`.

## Local first and scheduling

Local hits return immediately without cloud credentials or network access.
When configured, a missing page, missing section or zero-result search/date
query tries one mirror refresh, then re-runs locally if files were downloaded.
Refreshes can push already curated local changes too. If the cloud is offline,
the local result remains available and says the refresh was unavailable.

`cloud sync` is one bounded run. Schedule it every minute with launchd, cron or
Task Scheduler if automatic replication is wanted. Use an absolute Node/CLI
path, the intended `--at` vault and a secret-manager wrapper that supplies the
token without putting it in command arguments or the job file. Background
replication is independent of whether a ChatGPT plugin is selected. No scheduler
is installed by the package; `cloud status` reports the last actual run.

## Connect ChatGPT

Register the published `https://your-host.example/mcp` endpoint as a private
custom MCP plugin using OAuth, following the current [connection guide](https://developers.openai.com/api/docs/guides/custom-mcp-server).
Sign in as the configured owner. Confirm `brain_status`, a synthetic search,
fetch and date query. For writes, explicitly ask to save a test fact, fetch
the resulting revision, run the local mirror and inspect the local file.

The seven tools are data-only; no widget is required. Search/fetch use the
standard JSON text payloads with citation URLs and revision metadata. Citation
URLs are protected Markdown endpoints and require an OAuth bearer token; this
example does not include a browser login UI. Refresh the plugin after changing
tool descriptors. Client/workspace permissions determine where a connected
plugin is available. Connecting it does not force a brain lookup in every chat.

The stateless HTTP handler supports modern MCP `2026-07-28` discovery and legacy
initialization. It uses JSON responses, validates routing/version metadata and
Origin, and offers no SSE subscription stream. See the [MCP transport spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
and [tool server guide](https://developers.openai.com/plugins/build/mcp-server).

## Conflicts, retries and deletion

Every write requires a fetched `expected_revision`, a unique `request_id` and
a reason. SQL compare-and-swap rejects stale revisions. Replaying the same
successful request does not repeat an edit. Cloud saves validate metadata,
original creation date, wiki links and sourced dates. They require the schema
and source policy to have been imported. Every substantive change appends an
audit snapshot in the same SQL statement via a trigger.

The local mirror records a shared base and verifies content hashes. One-sided
edits replicate; independent edits use `git merge-file` when Git is available.
Overlapping edits preserve local/cloud/base copies under
`.exposurie/cloud-sync/conflicts/` and return `needs-review`, with exit 1.
Without Git, simultaneous edits need review. Merge from the preserved versions
and save through a revision-checked write; do not force overwrite either side.
New remote pages get a catalog entry locally. A subsequent mirror sends that
catalog update back.

Missing files require review rather than propagating deletions. There is no
delete tool. To erase knowledge, stop all mirrors first, remove the current
cloud record and its revision snapshots through the database administrator,
remove the local file plus relevant base/conflict snapshots, and review before
restarting. Deleting one local file alone does not erase cloud knowledge.
Retain independently sourced facts according to the owner policy.

The local Node baseline remains 20. SQL integration tests use Node 22+ SQLite
as a stand-in for D1 and report an explicit skip on earlier Node releases; the
deployed Worker uses D1. Test fixtures contain synthetic knowledge only.
