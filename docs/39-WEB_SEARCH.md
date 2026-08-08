---
sidebar_position: 39
title: 'Web Search'
description: 'Give chats and Work tasks live web search through a self-hosted SearXNG instance. Off by default, admin-enabled, fully private.'
slug: /WEB_SEARCH
keywords:
  [
    web search,
    searxng,
    search the web,
    live results,
    sources,
    internet access,
    self-hosted search,
  ]
---

# Web Search

Libre WebUI can search the web and hand the results to your models — without
sending anything to a commercial search API. Search runs through a
[SearXNG](https://docs.searxng.org/) instance you host yourself, next to the
app. Queries leave your server only as anonymous SearXNG requests to the
public search engines it aggregates.

Like every dual-use capability in Libre WebUI, it ships **off**. An
administrator turns it on once; until then no search UI exists anywhere.

## How it works

There are three pieces, and each one is invisible until the previous one
exists:

1. **A SearXNG instance** the backend can reach. The bundled private deploy
   stack includes one; any instance with the JSON API enabled works.
2. **The admin setting** — Settings > Connections > **Search** (the tab is
   admin-only). Set the SearXNG URL, flip **Enable web search**, and use
   **Test connection** to prove the wiring with a live query.
3. **Who may use it** — the **Web search** card in User Management, next to
   the Work access and model download controls. Off (the default) keeps
   search admins-only even while it is enabled; on opens it to all active
   users. The backend enforces this on every request.
4. **The per-use controls** that appear for permitted users:
   - **Chat:** a globe toggle in the composer. When it is on, the backend
     searches for your message before generating, injects the top results as
     context, and the reply shows numbered **source chips** linking to each
     result. This works with _every_ model — including small local models
     with no tool-calling support — because the results arrive as context,
     not as a tool the model must know how to call.
   - **Work:** tasks whose network access is on gain a `web_search` tool in
     the agent loop. The model decides when to call it, like any other tool.
     Offline tasks (network disabled) never see the tool, even though the
     search request itself would egress from the backend, not the sandbox.

A failed search never fails the turn: the model answers without the context
and the run continues.

## Setup with the bundled stack

`deploy/private/docker-compose.yml` already contains the `searxng` service:
internal-only (never published to the host), hardened, and pre-wired into
the app through `SEARXNG_URL=http://searxng:8080`.

1. Add a secret to `.env`:

   ```env
   SEARXNG_SECRET=any-long-random-value
   ```

2. `docker compose up -d`.

3. As an administrator: Settings > Connections > **Search** — the URL is
   pre-filled from the environment — enable, then **Test connection**.

## Setup with your own SearXNG

Any reachable SearXNG instance works, with one requirement: the **JSON
format** must be enabled in its `settings.yml` (most public instances
disable it):

```yaml
search:
  formats:
    - html
    - json
```

Then paste its base URL (for example `http://127.0.0.1:8888` or
`https://search.example.com`) into Settings > Connections > Search.

## Environment variables

| Variable      | Default | Purpose                                                                     |
| ------------- | ------- | --------------------------------------------------------------------------- |
| `SEARXNG_URL` | unset   | Pre-fills the URL in the Search settings; enabling is still an admin action |

The setting itself (enabled + URL) is persisted in the database, so it
survives restarts and takes effect immediately without redeploying.

## Privacy and scope

- Searches run **server-side**. Browsers never contact the search engine,
  and no API key or account is involved anywhere.
- Result text is bounded before it reaches model context (500 characters
  per result, at most 8 results), and only `http(s)` result URLs are kept.
- The bundled instance is reachable only on the stack's internal network.
  Its rate limiter is off for that reason; do not publish it.

## Troubleshooting

**No globe in the composer / no `web_search` tool in Work.** Search is not
enabled (Settings > Connections > Search), or the account is not permitted:
regular users need the **Web search** toggle in User Management turned on.

**Test connection fails with an HTTP 403.** The instance does not allow the
JSON format. Add `json` to `search.formats` in its `settings.yml` (see
above) and restart it.

**Test connection cannot reach the service.** The URL must be reachable
_from the backend_, not from your browser. Inside the bundled stack that is
`http://searxng:8080`; `localhost` inside a container is the container
itself.

**Replies ignore the results.** The model still decides what to use. Small
models follow the injected context better when the question is concrete;
the sources under the reply always show what was retrieved.
