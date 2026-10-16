# @pipeworx/de-gesetze

German federal statutes and ordinances (Bundesrecht) — search by title or
official abbreviation, read a single § or Art. in full, browse a law's
structure, and get its amendment status ("Stand").

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1815+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `gesetze_search(query, limit?)` — find a law by title keyword or
  abbreviation ("BGB", "Datenschutz"). An abbreviation match returns that one
  law directly; otherwise ranks law titles by word overlap.
- `gesetze_law_info(law)` — amendment metadata ("Stand") for one law:
  official abbreviation/title, date of promulgation, official publication
  citation, the amendment-status entries (Neufassung/Stand), and the
  entry-into-force date when the source publishes one.
- `gesetze_structure(law, section_id?, depth?, provision_limit?)` — the
  law's table of contents (Buch/Abschnitt/Titel/Kapitel) with its §/Art.
  provisions listed under each heading. Paged: a branch with more provisions
  than `provision_limit` reports `has_more_provisions` rather than
  truncating silently.
- `gesetze_provision(law, provision)` — full text of one § (Paragraph) or
  Art. (Artikel), by abbreviation and number ("823", "§ 823", "823a",
  "Art 1"), with its title and its own amendment/application footnote when
  the source attaches one.

## Auth

Keyless.

## Data sources

- Bundesministerium der Justiz (BMJ) / juris GmbH, Gesetze im Internet —
  the federal government's official collection of German statutes and
  ordinances currently in force, each as structured XML with its own
  amendment metadata.

## Notes

- **Abbreviation matching.** The collection's own table of contents carries
  no separate abbreviation field — only a title and a per-law identifier.
  For the large majority of entries that identifier IS the law's lowercase
  official abbreviation (the publisher's own convention: `bgb` -> BGB,
  `stgb` -> StGB, `estg` -> EStG), and `gesetze_search`/`gesetze_law_info`/
  `gesetze_structure`/`gesetze_provision` all resolve on that basis first.
  This is a documented convention, not a guarantee for every one of the
  ~6,100 entries — an obscure ordinance's identifier occasionally departs
  from its cited abbreviation, in which case `gesetze_search`'s title
  search is the way in.
- **Per-law fetch is live, per call.** Only the catalog (title + law
  identifier, ~6,100 entries) is baked into a lookup index; a law's full
  text, structure and amendment metadata are fetched and parsed live on
  each call to `gesetze_law_info`/`gesetze_structure`/`gesetze_provision` —
  proxied, never mirrored. A short per-isolate cache avoids re-fetching the
  same law repeatedly in a burst of calls; it is not a persistent copy.
- **§ vs. Art.** Most laws number their provisions "§ N"; a handful
  (constitutional and some international-treaty texts, e.g. the Grundgesetz)
  use "Art N" instead. `gesetze_provision` matches on the bare number/letter
  token, so either symbol works regardless of which one a given law actually
  uses — you do not need to know in advance.
- **Granularity.** A provision is one § or Art. (the source's own unit).
  Absätze (paragraphs) and Sätze (sentences) within a provision are part of
  its text, not separately addressable — consistent with how the publisher
  itself structures the document.
- **Copyright.** German federal legislative and administrative texts are
  "amtliche Werke" and are not protected by copyright (§ 5
  Urheberrechtsgesetz).
- **Index refresh.** `scripts/bake-de-gesetze-index.mjs` regenerates
  `src/de-index-data.ts` from one live call to the publisher's table of
  contents; it is registered in
  `workers/gateway/src/pack-baked-indexes.json` so it ships to KV, never
  into the gateway bundle.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "de-gesetze": {
      "url": "https://gateway.pipeworx.io/de-gesetze/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/de-gesetze/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1815+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/gesetze_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"Datenschutz"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/gesetze_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "de-gesetze": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-de-gesetze"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-de-gesetze
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about De Gesetze data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
