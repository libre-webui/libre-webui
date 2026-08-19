---
sidebar_position: 49
title: 'Chat Tools'
description: 'Native tool calls in Chat: built-in tools, OpenAPI and MCP servers, approvals, and the egress policy.'
slug: /CHAT_TOOLS
keywords: [tools, tool calls, mcp, openapi, approvals, function calling]
---

# Chat Tools

Chat can let the model call tools. A turn with tools enabled runs a native
multi-round loop: the model requests a tool, Libre WebUI executes it under
the invoking user's identity and permissions, the result goes back to the
model, and the loop continues until the model answers — up to eight rounds
per turn, with at most eight calls per round. Stop cancels the model call,
any in-flight tool call, and any pending approval wait.

Tool calls are recorded as normalized events (`chat.tool-call.v1`,
`chat.tool-result.v1`, `chat.approval.v1`) that flow identically over the
private WebSocket path and the durable event stream, so a refresh or a
reconnect replays the same state. The completed turn stores its calls, with
bounded result previews, on the assistant message.

## Enabling tools

Tools are off by default. An administrator opens them in User Management
(admins-only or all users); each turn then opts in with the wrench toggle in
the composer. Private (incognito) chats never offer tools: a tool call is an
outward-facing action and can leave approvals and audit records.

An assistant profile (persona) can scope the offered tools: bound tool
servers, a subset of built-in tools, bound skills, and bound knowledge
collections restrict what the model sees for sessions using that profile.

## Built-in tools

Three first-party, read-only tools ship with Chat:

- `web_search` — the admin-configured search engine, honoring the web-search
  access mode.
- `search_documents` — the user's own uploaded documents and knowledge
  collections (profile bindings can scope the collections).
- `load_skill` — loads a skill's full instructions by slug; the tool's
  description carries the manifest of the user's enabled skills, so skills
  stay lazy until the model needs one.

## Tool servers

Administrators register external tool servers under Tools:

- **OpenAPI**: a JSON OpenAPI 3.x specification is fetched once and pinned
  with a SHA-256 digest. Each operation becomes a tool; `GET` operations are
  classified read-only and everything else as a side effect until an
  administrator overrides the classification per tool. Execution rebuilds
  the call from the pinned operation — model arguments never choose the
  destination.
- **MCP (Streamable HTTP)**: the server's tool list is fetched over JSON-RPC
  and pinned the same way. `annotations.readOnlyHint` marks a tool
  read-only. stdio MCP servers are deliberately unsupported: external
  processes never run inside the web process.

A changed inventory only takes effect when an administrator refreshes the
server, which advances the pinned revision and preserves per-tool overrides.
Per-server availability is admins-only, all users, or grant-based through
the shared resource-grant model (user and group grants on the tool server).

### Credentials

Servers that require authentication use per-user credentials (bearer token
or a named header). Each secret is encrypted with additional authenticated
data binding it to the exact user and server, entered by each user under
Tools, and never shared between accounts.

### Egress policy

Every tool request resolves its destination itself, refuses private,
loopback, and metadata address space, and pins the connection to the
resolved address so a DNS rebind cannot redirect the call. Redirect
responses are refused. Responses are size-capped and every call carries a
hard timeout. Exact internal hostnames can be allowed with
`TOOLS_PRIVATE_NETWORK_ALLOWLIST` (comma-separated); allowlisted hosts stay
pinned and capped. Tool output re-enters the model as untrusted text.

## Approvals

Read-only tools run without asking. A side-effecting tool pauses the turn
and asks the user: allow once, allow for this chat, always allow this tool
on this server, or deny. Decisions are durable — an "always" grant survives
restarts and is revocable under Tools — and a pending request expires after
two minutes, which the model sees as a denial. Denials and timeouts never
execute the call. Every decision and every call leaves a redacted security
audit event.

## Environment variables

| Variable                          | Effect                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `TOOLS_ACCESS_MODE`               | Pin the tools feature to `admins` or `all-users` and lock the admin toggle.  |
| `TOOLS_PRIVATE_NETWORK_ALLOWLIST` | Exact hostnames tool servers may resolve to private addresses (comma list). |

## Boundaries

- Tool calls run on the WebSocket path (private-session transport is
  excluded by design) and the durable generation path used for persisted
  chats. The legacy REST streaming endpoint does not run the tool loop.
- Gemini and agent CLI models do not receive tools; Ollama,
  OpenAI-compatible, Responses-API, and Anthropic providers do.
- MCP servers authenticate with static per-user credentials; an MCP server
  that only supports interactive OAuth cannot be registered yet.
