# Cost Governance

Cost governance turns the privacy-preserving usage ledger into money:
administrators declare what each provider model costs, Libre prices every
recorded call, and budgets watch — or cap — the spend. Nothing new is
collected: pricing runs entirely over the usage events Libre already
records (tokens, units, latency, provider, model), which never contain
prompts or responses.

## Tariffs

A tariff is a versioned price row for one plugin, optionally scoped to one
model:

- **Input / output price** in USD per million tokens, applied to
  provider-reported token counts.
- **Unit price** in USD per output unit, applied to media generations
  (images, speech batches, videos).
- **Effective from** a timestamp: tariffs never mutate. Add a new row when
  a provider changes prices; each usage event prices against the newest
  tariff at or before the moment it happened, so historical costs stay
  correct.

An exact plugin-and-model tariff wins over a plugin-wide row (no model).
Events with no matching tariff — or without provider-reported usage — are
counted as **unpriced** and surfaced prominently rather than silently
costed at zero. Provider-reported counts are exact where the provider
returns them; Libre does not substitute estimates into billing.

## Budgets

A budget covers the whole instance, one user, or one group, over a UTC
day, ISO week, or calendar month, in one of three modes:

- **Observe** — appears in analytics only.
- **Alert** — notifies at 80% and 100% of the amount.
- **Alert and block** — hard budgets alert and additionally block new
  interactive generations (chat, the OpenAI-compatible API, images,
  speech, sound, video, and edits) with a clear 429 once the period's
  spend reaches the amount.

Group membership is resolved fresh at every check, and threshold alerts
fire exactly once per budget, period, and threshold through notification
deduplication. Enforcement reads a briefly cached spend figure, so a hard
budget bounds spending within about half a minute of the true figure —
and any failure inside the check fails open: cost governance can never
take generation availability down. Scheduled automation runs are metered
and count toward spend, but only interactive requests are blocked;
disable an automation to stop its scheduled spend.

## Analytics and export

**Usage → Costs and budgets** shows the priced total for the selected
window, unpriced event counts, spend by plugin, model, and user, and
every budget with its live utilization. **Export CSV** downloads the
priced event ledger (timestamp, user, plugin, model, capability, tokens,
units, cost) for external accounting. All cost endpoints are
administrator-only and audit-logged on every mutation.
