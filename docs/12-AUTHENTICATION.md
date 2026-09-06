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

Libre WebUI uses local user accounts with JWT sessions. A fresh installation
always permits one local administrator bootstrap. Public registration for every
later local or OAuth account is closed by default.

The sign-in page includes a language selector beside the theme control. You
can choose your preferred language before signing in; the selection is saved
in the current browser and applies to sign-up as well.

## First-Time Setup

When the database has no users:

1. Libre WebUI shows the first-time setup flow.
2. The user creates the first local account.
3. The account is assigned the `admin` role.
4. Every later public registration stays closed unless explicitly enabled.

Existing databases keep their current users and roles.

## Local Accounts

Local signup requires:

- Username
- Password between 12 characters and 72 UTF-8 bytes, with uppercase,
  lowercase, and a number
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

### Enable public registration deliberately

Registration defaults to disabled. Set the backend environment variable below
only while new local or OAuth accounts should be accepted:

```env
ENABLE_SIGNUP=true
```

Return it to `false` after any planned registration window.
Existing local and OAuth users can still sign in, and administrators can still
create accounts from user management while public registration is closed.

An empty database always permits one local administrator, even when
`ENABLE_SIGNUP=false`; OAuth cannot claim that bootstrap slot. For a private
remote deployment, place the hostname behind an identity allowlist such as
Cloudflare Access before starting the application, then create the initial
administrator through that protected route.

## Roles

| Role    | Purpose                                                                                       |
| ------- | --------------------------------------------------------------------------------------------- |
| `admin` | Instance administration, user management, system settings, and trusted Work runtime operation |
| `user`  | Normal chat, model, persona, document, and settings workflows                                 |

Model installation, deletion, copying, pushing, and unloading are restricted to
administrators because these operations change host resources.

### Work Access

Work is restricted to administrators by default because it lets a selected
model execute arbitrary commands inside a managed container. An administrator
can open Work to all active users from the User Management tab in Settings; the setting
persists across restarts and takes effect immediately, including for open
terminal sessions. Host-folder workspaces remain admin-only in every mode
because they bind-mount server paths. Treat everyone granted Work access as
a trusted runtime operator, not only as a WebUI user.

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

### Groups and Resource Grants

Administrators can create groups and manage memberships from the User
Management tab in Settings. Groups are principals for resource grants: the owner of a
chat, note, document, knowledge collection, folder, persona, prompt,
skill, or calendar can grant `read`, `write`, or `admin` access to a user
or a group through the access API — every shareable surface uses the same
share dialog (see [Sharing](./56-SHARING.md)) — and administrators can
scope registered tool servers to users or groups the same way. Resources stay private by default — the global `admin` role does not
grant access to other users' content. Membership is evaluated at request
time, so removing a member revokes group-granted access immediately. The
"effective access" view on the User Management tab in Settings answers "why can this
user access this?" by listing their role, groups, feature access, and every
grant that reaches them.

### Security Audit Log

Security-sensitive actions — logins and failures, logouts, session and token
revocations, user, group, grant, and token changes — are recorded in an
append-only audit log that is separate from usage analytics. Details are
redacted before they are stored: secret-like keys are dropped and payload
sizes are capped, so passwords, tokens, and prompt content never enter the
log. Group and grant mutations write their audit event inside the same
database transaction, so a change cannot exist without its trail.
Administrators can query the log from the User Management tab in Settings; retention
defaults to 180 days (`AUDIT_RETENTION_DAYS`).

## Sessions

The backend signs JWTs with `JWT_SECRET`. Set a stable secret in production:

```env
JWT_SECRET=replace-with-a-long-random-secret
```

Changing `JWT_SECRET` invalidates existing sessions. Local and OAuth login
tokens use `JWT_EXPIRES_IN`, which defaults to `7d`; changing that value affects
new sessions. WebSocket connections exchange the durable token for a
short-lived, one-use ticket and close when the underlying session expires.

Every login also creates a server-side session record bound into the JWT.
Settings → Sessions lists each device with its sign-in method, first and last
activity, and expiry. Revoking a session there (or "Sign out other sessions")
invalidates its token immediately on every replica and closes its live
WebSocket connections; logout revokes the current session the same way.
Tokens issued before this feature carry no session id and remain valid until
expiry, except that "sign out other sessions" from a fresh login also stamps
a per-account cutoff that rejects them.

## Two-Factor Authentication and Passkeys

Settings → Sessions manages both second factors and passwordless sign-in:

- **Authenticator app (TOTP).** Enrollment shows a base32 secret and an
  `otpauth://` link for any authenticator app; confirming the first 6-digit
  code activates it and reveals ten one-time recovery codes. After that,
  password login returns a short-lived challenge instead of a session, and
  `POST /api/auth/mfa/verify` completes the sign-in with a TOTP code or a
  recovery code. Each accepted code's timestep is recorded, so an intercepted
  code cannot be replayed; recovery codes are stored only as keyed one-way
  lookup tokens and each works exactly once. Disabling or regenerating
  recovery codes requires re-proving a factor.
- **Passkeys (WebAuthn).** "Sign in with a passkey" performs a passwordless
  login with a discoverable credential; user verification (screen lock,
  biometric, or PIN) is required at registration and sign-in. Attestation is
  accepted as `none`, ES256 and EdDSA credentials are supported, and
  credential material is encrypted at rest with the id kept as a keyed
  lookup token. Challenges are one-use and expire after five minutes; a
  nonzero signature counter that fails to advance is rejected as a clone
  signal. Passkeys need a secure (HTTPS) origin, or `localhost` in
  development; set `WEBAUTHN_RP_ID` when the instance is reached under more
  than one hostname.

The MFA challenge token issued after a correct password is signed with a
secret derived from (but distinct from) `JWT_SECRET`: it can never
authenticate an API request, is bound to one account and one purpose, and is
consumed on success.

Administrators can require a second factor for every account (Users → the
two-factor policy card, or pin it with `MFA_REQUIRED_MODE=required`). Users
without one are walked through enrollment at their next sign-in before a
session is issued. Administrators can also reset a user's TOTP enrollment
from the user list for account recovery; passkeys are left in place because
the user manages them from settings. Enrollment, activation, verification
failures, disabling, policy changes, passkey registration/removal, and admin
resets are all recorded in the security audit log.

MFA applies to password logins. OAuth and OIDC sign-ins rely on the identity
provider's own second factor and are not challenged again. API tokens are
unaffected: they never touch session authentication.

## API Tokens

Settings → API keys mints personal access tokens (prefix `lwk_`) for
programmatic use. The secret is shown once and stored only as a hash. Each
token carries an explicit scope list (`chat`, `models`, `documents`, `notes`,
`personas`, `media`, `work`, `admin`); the backend maps every route family to
a required scope, so a notes-only token cannot touch chats or administration,
and session management is never reachable with a token. Tokens support
optional expiry, track last use, can be revoked at any time, and are
rate-limited per token across replicas. Admin-scoped tokens can be minted
only by administrators and still require the account to hold the admin role
when used. A `chat`-scoped token is also the key for the OpenAI-compatible
[public `/v1` API](./53-PUBLIC_API.md).

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

Both OAuth providers use a cryptographically random `state` value bound to a
short-lived HttpOnly, SameSite cookie. The callback rejects missing or mismatched
state. After a successful callback, the JWT crosses back to the frontend in a
60-second HttpOnly cookie that is exchanged and cleared immediately; bearer
tokens are never placed in callback URLs, browser history, or referrer headers.

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
- Grant Work access (administrator accounts, or the open-to-all-users mode)
  only to people trusted to operate the backend's container runtime.

## Related Docs

- [Single Sign-On](./SINGLE_SIGN_ON)
- [Work: Isolated Workspaces](./WORKSPACES)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Database Encryption](./DATABASE_ENCRYPTION)
- [Demo Mode](./DEMO_MODE)
