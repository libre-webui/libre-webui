---
sidebar_position: 21
title: 'Single Sign-On'
description: 'Configure GitHub and Hugging Face OAuth or a generic OpenID Connect provider, including optional domain, role, and group policies.'
slug: /SINGLE_SIGN_ON
keywords:
  [
    libre webui sso,
    openid connect,
    oidc,
    github oauth,
    hugging face oauth,
    keycloak,
    authentik,
    oauth2 authentication,
  ]
---

# Single Sign-On

Libre WebUI supports OAuth login with GitHub and Hugging Face, plus any OpenID Connect provider through the generic OIDC integration. OAuth users are still stored as local Libre WebUI users and receive the `user` role by default (OIDC can optionally map roles and groups from claims).

## GitHub OAuth

Create an OAuth app in GitHub Developer Settings.

Local callback URL:

```text
http://localhost:3001/api/auth/oauth/github/callback
```

Production callback URL:

```text
https://your-domain.example/api/auth/oauth/github/callback
```

Backend `.env`:

```env
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_CALLBACK_URL=https://your-domain.example/api/auth/oauth/github/callback
```

GitHub OAuth requests the `user:email` scope. New users are created with `gh_`-prefixed usernames.

## Hugging Face OAuth

Create an OAuth app in Hugging Face settings.

Local callback URL:

```text
http://localhost:3001/api/auth/oauth/huggingface/callback
```

Production callback URL:

```text
https://your-domain.example/api/auth/oauth/huggingface/callback
```

Backend `.env`:

```env
HUGGINGFACE_CLIENT_ID=...
HUGGINGFACE_CLIENT_SECRET=...
HUGGINGFACE_CALLBACK_URL=https://your-domain.example/api/auth/oauth/huggingface/callback
```

New users are created with `hf_`-prefixed usernames.

## Generic OIDC

Any provider with an OpenID Connect discovery document works: Keycloak,
Authentik, Authelia, Okta, Entra ID, Google Workspace, and others. The flow
uses PKCE (S256), CSRF state, and a nonce that is verified inside the
signature-checked ID token; signing keys come from the provider's JWKS.

Register a confidential client with this callback URL:

```text
https://your-domain.example/api/auth/oauth/oidc/callback
```

Backend `.env`:

```env
OIDC_ISSUER_URL=https://id.example.com/realms/main
OIDC_CLIENT_ID=libre-webui
OIDC_CLIENT_SECRET=...
OIDC_DISPLAY_NAME=Example SSO
```

Optional policies:

```env
# Require a verified email in one of these domains
OIDC_ALLOWED_EMAIL_DOMAINS=example.com,example.org

# Grant/remove the admin role based on a group claim on every login
OIDC_GROUP_CLAIM=groups
OIDC_ADMIN_GROUPS=libre-admins

# Reconcile Libre group memberships with the group claim on every login
OIDC_SYNC_GROUPS=true
```

Identities are linked on the stable `sub` claim, so a renamed provider
account keeps its Libre account. New users are created with `oidc_`-prefixed
usernames when registration allows it. An email already owned by an unlinked
local account is rejected instead of silently merged. With
`OIDC_SYNC_GROUPS=true`, membership of every Libre group whose name matches a
claim value is claim-driven for OIDC users — create matching groups from the
User Management page first.

## Shared Settings

Set the public backend URL:

```env
BASE_URL=https://your-domain.example
CORS_ORIGIN=https://your-domain.example
```

If callback URLs are not set explicitly, Libre WebUI builds defaults from `BASE_URL`.

## Limits

Libre WebUI does not currently expose SAML or SCIM provisioning. Domain allowlists and role/group mapping are available for the generic OIDC provider only; GitHub and Hugging Face users are always created with the `user` role and managed from the admin UI.

## Troubleshooting

**OAuth button does nothing**

Confirm the provider client ID and secret are set and the backend has restarted.

**Provider rejects callback**

The callback URL in the provider dashboard must exactly match the URL used by Libre WebUI.

**User gets normal permissions**

OAuth users are created as `user` by default. Promote users from the admin UI if needed.

## Related Docs

- [Authentication](./AUTHENTICATION)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
