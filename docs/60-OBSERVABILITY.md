---
sidebar_position: 60
title: 'Observability'
description: 'Structured logs, request correlation, and opt-in OpenTelemetry export over OTLP/HTTP JSON.'
slug: /OBSERVABILITY
keywords: [observability, structured logs, opentelemetry, otlp, tracing, metrics]
---

# Observability

Libre WebUI provides two operator-facing observability paths:

- structured application logs, written locally to standard output and error;
- an optional OpenTelemetry exporter for HTTP requests, durable jobs, counters,
  and warning/error log records.

Neither path sends telemetry to the Libre WebUI project. OpenTelemetry is off
until an operator configures a collector endpoint. The administrator
[System and Usage](./37-SYSTEM_MONITORING.md) pages are separate: they read
diagnostics and model/provider usage from the deployment itself rather than
from an OpenTelemetry collector.

## Structured logs

The default `LOG_FORMAT=text` keeps the familiar scoped console output. Set
`LOG_FORMAT=json` for one JSON object per line:

```env
LOG_LEVEL=info
LOG_FORMAT=json
```

Each structured line carries:

- an ISO timestamp;
- level and logger scope;
- a message;
- the current request or durable-job correlation id when one exists; and
- bounded structured details supplied by the caller.

Every HTTP request receives an `X-Request-Id`. Libre accepts an incoming id only
when it is 8–64 characters of letters, digits, `.`, `_`, or `-`; otherwise it
creates a UUID. The id is returned in the response and follows asynchronous
work through the logging context. Access logs record the HTTP method, path,
status, and duration, with the query string removed because query parameters can
contain user content or short-lived credentials.

`LOG_LEVEL` accepts `silent`, `error`, `warn`, `info`, or `debug`. Debug logging
can expose more operational detail; enable it only while diagnosing a problem
and protect the resulting logs like other deployment data.

## Redaction boundary

Structured details and exported telemetry pass through the same bounded
redaction helper:

- fields whose names resemble passwords, secrets, tokens, keys,
  authorization, cookies, credentials, bearer values, or JWTs are omitted;
- strings are capped at 512 characters;
- arrays, nesting depth, and exported attribute counts are bounded; and
- error objects retain their name and a bounded message, not an arbitrary
  object graph.

This is defense in depth, not permission to log prompts or secrets. A short
user-supplied string without a secret-shaped field name can still be ordinary
log text. Application extensions should log identifiers and outcomes rather
than request bodies, prompts, document text, tool results, or provider payloads.
Restrict access to logs and apply an operator-managed retention policy.

## Enable OpenTelemetry

Libre exports OTLP/HTTP JSON directly, without adding an OpenTelemetry SDK
dependency. Point it at the HTTP base URL of a collector that accepts the
standard signal paths:

```env
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.example.com:4318
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer example-collector-token
OTEL_SERVICE_NAME=libre-webui
```

The exporter appends `/v1/traces`, `/v1/metrics`, and `/v1/logs` to the base
URL. `OTEL_EXPORTER_OTLP_HEADERS` is a comma-separated list of `key=value`
pairs. Store collector credentials as deployment secrets; do not commit them.
`OTEL_SERVICE_NAME` defaults to `libre-webui`.

When the endpoint variable is absent, span, metric, and log recording are
no-ops and nothing leaves the process. In a team deployment, application and
external-worker processes export independently, so give each process the
collector configuration it should use. A distinct service name per role can
make dashboards easier to read.

## Exported signals

| Signal | What Libre records |
| ------ | ------------------ |
| HTTP server spans | Method and path without query string, response status, duration, success/failure status, and request id |
| HTTP counters | Monotonic request count by method and response-status class |
| Durable-job spans | Job type, attempt number, duration, and success/failure status |
| Durable-job counters | Monotonic execution count by job type and outcome |
| Log records | Redacted warning and error messages with logger scope plus request/job correlation ids |

Spans are local finished spans. Libre does not currently propagate an incoming
OpenTelemetry trace parent, create parent/child span trees across services, or
instrument browser rendering and every provider call. Model token and media
usage belongs to the local [Usage Analytics](./37-SYSTEM_MONITORING.md) and
[Cost Governance](./58-COST_GOVERNANCE.md) ledgers instead.

## Delivery behavior

Telemetry is deliberately best-effort:

- buffers hold at most 2,048 spans and 2,048 log records and drop the oldest
  entry under pressure;
- at most 512 counter series are retained;
- the exporter flushes about every five seconds;
- each HTTP export has a three-second timeout; and
- a collector error drops that batch and never blocks or fails an application
  request or durable job.

The exporter is therefore not an audit log or durable accounting system. Use
the append-only security audit log for security events, the SQL usage ledger for
costs, and your collector's own retention and alerting for telemetry.

## Troubleshooting

**No telemetry arrives.** Confirm that `OTEL_EXPORTER_OTLP_ENDPOINT` is present
in the environment of the exact application or worker process, includes only
the collector base URL, and that the collector accepts OTLP/HTTP JSON on the
three standard paths.

**The collector returns unauthorized.** Check the comma-separated header syntax
and whether the collector expects `authorization=Bearer ...` or another header.
Restart the process after changing environment variables.

**Requests still succeed while the collector is down.** This is expected. The
export path fails open for application availability and does not persist failed
batches for retry.

**A log field is missing or shortened.** Secret-shaped keys are removed and
long or deeply nested values are bounded by design. Log a safe identifier or
summary instead of weakening the redaction boundary.

## Related Docs

- [System Diagnostics & Usage Analytics](./37-SYSTEM_MONITORING.md)
- [Cost Governance](./58-COST_GOVERNANCE.md)
- [Platform Foundation](./45-PLATFORM_FOUNDATION.md)
- [Authentication & Security](./12-AUTHENTICATION.md)
- [Environment Variables](./26-ENVIRONMENT_VARIABLES.md)
