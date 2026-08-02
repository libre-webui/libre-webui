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

## Registration Approval

Public registration does not grant access by itself. Every account created
through the public signup form or through an OAuth provider starts in a
`pending` state and must be approved by an administrator before it can sign in.

The one exception is bootstrap: the first real account on an empty database is
created `active` with the `admin` role, atomically, so a fresh install still
produces a working administrator. Every later registration waits for review.

What a pending user sees:

- Signup succeeds but returns no session token. The API responds `202` with
  `approvalRequired: true`, and the UI explains that an administrator has to
  approve the account.
- A password sign-in with correct credentials is refused with `403` and the
  code `ACCOUNT_PENDING` ("Your account is waiting for administrator
  approval"). An OAuth sign-in redirects back to the login page with
  `?approval=pending`.
- Account status is re-read from the database on every authenticated request,
  so a session can never outlive an account's `active` status.

What an administrator sees:

- User management shows a **Pending approvals** card listing waiting accounts,
  each with an **Activate account** action and a reject action. Rejection is
  deletion; there is no separate suspended state.
- Administrators are notified in the app while signed in: a badge on the Users
  entry and a toast when new registrations arrive. The pending-approvals
  summary is polled about once a minute
  (`GET /api/users/pending-approvals`, admin-only).
- Approval (`PATCH /api/users/:id/approve`, admin-only) records which
  administrator approved the account and when. It does not change the role:
  approved accounts keep the `user` role until an administrator promotes them.
  Approval takes effect on the user's next sign-in attempt; nothing needs to
  be recreated.

Existing accounts are unaffected by an upgrade: only accounts created through
public registration after the feature shipped start as pending. Accounts
created by an administrator from user management are active immediately.

### Disable public registration

Set the backend environment variable below to close public registration:

```env
ENABLE_SIGNUP=false
```

Existing local and OAuth users can still sign in, and administrators can still
create accounts from user management. New local signups and new accounts from
OAuth providers are blocked. Libre WebUI also removes the signup link from the
login page.

Registration stays closed on an empty database. For a new private deployment,
first place the hostname behind an identity allowlist such as Cloudflare
Access, temporarily set `ENABLE_SIGNUP=true`, create the initial administrator,
then set it back to `false` and recreate the application container.

## Roles

| Role    | Purpose                                                                                       |
| ------- | --------------------------------------------------------------------------------------------- |
| `admin` | Instance administration, user management, system settings, and trusted Work runtime operation |
| `user`  | Normal chat, model, persona, document, and settings workflows                                 |

Model installation, deletion, copying, pushing, and unloading are restricted to
administrators because these operations change host resources.

### Work Access

Work is restricted to administrators because it lets a selected model execute
arbitrary commands inside a managed container. Treat every administrator with
Work access as a trusted runtime operator, not only as a WebUI settings
administrator.

Admin authorization is checked against the current database role rather than
only the role cached in an existing JWT. Demoting an administrator therefore
revokes Work access immediately. The backend then attempts to abort active runs
and stop the user's Work containers and previews while preserving task records
and named volumes. If Docker cleanup fails, access remains revoked, the role
change reports the cleanup failure, and the operator must restore Docker access
and retry cleanup.

Deleting a user is destructive for that user's Work data. Libre WebUI first
stops their managed containers and removes their Work volumes, then deletes the
account and database records. If Docker cannot prove that cleanup succeeded,
the account deletion fails so an administrator can correct the runtime problem
and retry.

## Sessions

The backend signs JWTs with `JWT_SECRET`. Set a stable secret in production:

```env
JWT_SECRET=replace-with-a-long-random-secret
```

Changing `JWT_SECRET` invalidates existing sessions. Local login tokens are currently issued by the main auth service with a 24-hour expiration.

## Cloudflare Turnstile

Turnstile protects password login and signup when both keys are configured:

```env
TURNSTILE_SITE_KEY=...
TURNSTILE_SECRET_KEY=...
TURNSTILE_EXPECTED_HOSTNAME=chat.example.com
```

The frontend assigns distinct `login` and `signup` actions. The backend verifies
the token with Cloudflare and rejects a response whose hostname or action does
not match the request. `BASE_URL` supplies the expected hostname when
`TURNSTILE_EXPECTED_HOSTNAME` is not set explicitly.

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
- Grant Work-capable administrator accounts only to people trusted to operate
  the backend's container runtime.

## Related Docs

- [Single Sign-On](./SINGLE_SIGN_ON)
- [Work: Isolated Workspaces](./WORKSPACES)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Database Encryption](./DATABASE_ENCRYPTION)
- [Demo Mode](./DEMO_MODE)
