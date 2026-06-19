---
sidebar_position: 1
title: 'Authentication & Security'
description: 'Authentication, first-user setup, OAuth, roles, Turnstile, and session security in Libre WebUI.'
slug: /AUTHENTICATION
keywords:
  [libre webui authentication, user management, jwt security, oauth, turnstile]
image: /img/social/12.png
---

# Authentication & Security

Libre WebUI uses local user accounts with JWT sessions. A fresh install guides the first user through account creation, and that first user becomes the administrator.

## First-Time Setup

When the database has no users:

1. Libre WebUI shows the first-time setup flow.
2. The user creates the first account.
3. The account is assigned the `admin` role.
4. The user is logged in and can manage the instance.

Existing databases keep their current users and roles.

## Local Accounts

Local signup requires:

- Username
- Password with at least 6 characters
- Optional email

Passwords are hashed with bcrypt before storage. Login and signup routes are rate-limited.

## Roles

| Role    | Purpose                                                       |
| ------- | ------------------------------------------------------------- |
| `admin` | Instance administration, user management, system settings     |
| `user`  | Normal chat, model, persona, document, and settings workflows |

Administrators can update some system settings, including whether normal users may pull models.

## Sessions

The backend signs JWTs with `JWT_SECRET`. Set a stable secret in production:

```env
JWT_SECRET=replace-with-a-long-random-secret
```

Changing `JWT_SECRET` invalidates existing sessions. Local login tokens are currently issued by the main auth service with a 24-hour expiration.

## Cloudflare Turnstile

Turnstile protects signup when both keys are configured:

```env
TURNSTILE_SITE_KEY=...
TURNSTILE_SECRET_KEY=...
```

The frontend displays the widget on the Create Account form. The backend verifies the Turnstile token before creating the account.

If either key is missing, Turnstile is disabled.

## GitHub OAuth

Configure:

```env
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_CALLBACK_URL=https://your-domain.example/api/auth/oauth/github/callback
```

The GitHub OAuth flow creates local users with `gh_`-prefixed usernames and assigns the `user` role by default.

## Hugging Face OAuth

Configure:

```env
HUGGINGFACE_CLIENT_ID=...
HUGGINGFACE_CLIENT_SECRET=...
HUGGINGFACE_CALLBACK_URL=https://your-domain.example/api/auth/oauth/huggingface/callback
```

The Hugging Face OAuth flow creates local users with `hf_`-prefixed usernames and assigns the `user` role by default.

## Redirects and CORS

Set `BASE_URL` for callback defaults and `CORS_ORIGIN` for browser access:

```env
BASE_URL=https://your-domain.example
CORS_ORIGIN=https://your-domain.example
```

For local development, include the Vite dev origin:

```env
CORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173
```

## Demo Mode

Demo mode is a frontend preview mode. It pre-fills disabled demo credentials and uses mock API responses. It is not a production authentication mode.

## Security Checklist

- Set a strong `JWT_SECRET`.
- Keep `DATA_DIR` on persistent, access-controlled storage.
- Back up `ENCRYPTION_KEY` with the database.
- Configure Turnstile for public signup.
- Use HTTPS for public deployments.
- Restrict provider API keys to the minimum scope needed.
- Keep OAuth callback URLs exact.

## Related Docs

- [Single Sign-On](./SINGLE_SIGN_ON)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Database Encryption](./DATABASE_ENCRYPTION)
- [Demo Mode](./DEMO_MODE)
