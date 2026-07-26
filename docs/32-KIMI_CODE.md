---
sidebar_position: 13
title: 'Kimi Code'
description: 'Use Moonshot AI Kimi K3 and Kimi Code models from Libre WebUI.'
slug: /KIMI_CODE
keywords: [kimi, kimi k3, moonshot ai, coding, provider plugin]
---

# Kimi Code

Libre WebUI includes a bundled Kimi Code provider plugin for Moonshot AI's
OpenAI-compatible coding API.

## Configure the Provider

Create an API key in the
[Kimi Code Console](https://www.kimi.com/code/console), then save it for your
user in **Settings > Plugins > Kimi Code (Moonshot AI)** or provide it as a
deployment-wide environment variable:

```env
KIMI_API_KEY=...
```

Activate the plugin after saving the credential. Its models then appear in the
model selector.

## Available Models

| Model ID                    | Model                    | Availability                                             |
| --------------------------- | ------------------------ | -------------------------------------------------------- |
| `k3`                        | Kimi K3                  | Moderato and above; up to 1M context on eligible tiers   |
| `k3-256k`                   | Kimi K3                  | Moderato and above; fixed 256K context                   |
| `kimi-for-coding`           | Kimi K2.7 Code           | All Kimi Code members                                    |
| `kimi-for-coding-highspeed` | Kimi K2.7 Code HighSpeed | Allegretto and above; higher speed and greater quota use |

Kimi documents K3 as supporting up to a one-million-token context window for
eligible membership tiers. Libre WebUI leaves K3's reasoning effort unset so
the Kimi API applies its documented default, currently `high`.

Kimi Code models choose fixed sampling values for their active reasoning mode.
Libre WebUI therefore does not send the global temperature, top-p, frequency
penalty, or presence penalty settings to this provider. This follows Kimi's
recommendation and prevents invalid-parameter errors when its defaults change.

## API Endpoint

The bundled plugin uses Kimi Code's OpenAI-compatible endpoint:

```text
https://api.kimi.com/coding/v1/chat/completions
```

The endpoint can be overridden in the plugin variables for compatible gateways
or proxies. Remote overrides must use HTTPS.

## Privacy and Usage

Kimi Code is a remote provider. Prompts, conversation context, and attached
content sent through this plugin are processed by Kimi under its terms and
privacy policy. Use per-user credentials on shared deployments so each person
controls their own account, quota, and billing.

Kimi asks third-party clients to preserve their real client identity. Do not
configure a proxy to impersonate another product or alter client identification
to obtain different access.

## Troubleshooting

**Unauthorized or HTTP 401**

- Confirm the API key is from the Kimi Code Console.
- Confirm the selected model is included in your membership tier.
- K3 requires Moderato or above, and HighSpeed requires Allegretto or above.

**K3 context is smaller than expected**

- K3 context limits depend on membership.
- Moderato supports a smaller K3 context than Allegretto and higher tiers.
- Select `k3-256k` when you want the lower-quota 256K K3 route explicitly.
- Start a new chat after switching model families to avoid reusing an
  incompatible context cache.

**HTTP 429**

- Read the provider message shown in the Work activity. Kimi distinguishes
  temporary engine overload, concurrent-request limits, rolling usage limits,
  and monthly quota exhaustion.
- Retry temporary overloads after the indicated delay. Quota errors require
  waiting for the reset or changing the account plan.

**The model does not appear**

- Activate the Kimi Code plugin.
- Confirm the API key is saved for the current user or available as
  `KIMI_API_KEY`.
- Reload the model list after changing plugin settings.

## Related Docs

- [Plugin Architecture](./PLUGIN_ARCHITECTURE)
- [Working with Models](./WORKING_WITH_MODELS)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Official Kimi Code documentation](https://www.kimi.com/code/docs/en/)
