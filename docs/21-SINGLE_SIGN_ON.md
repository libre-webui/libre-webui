---
sidebar_position: 21
title: 'Single Sign-On'
description: 'Configure GitHub and Hugging Face OAuth login in Libre WebUI.'
slug: /SINGLE_SIGN_ON
keywords:
  [libre webui sso, github oauth, hugging face oauth, oauth2 authentication]
image: /img/social/21.png
---

# Single Sign-On

Libre WebUI supports OAuth login with GitHub and Hugging Face. OAuth users are still stored as local Libre WebUI users and receive the `user` role by default.

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

## Shared Settings

Set the public backend URL:

```env
BASE_URL=https://your-domain.example
CORS_ORIGIN=https://your-domain.example
```

If callback URLs are not set explicitly, Libre WebUI builds defaults from `BASE_URL`.

## Limits

Libre WebUI does not currently expose SAML, SCIM provisioning, domain allowlists, or OAuth auto-role mapping in the app configuration. Manage roles from the admin UI after users are created.

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
