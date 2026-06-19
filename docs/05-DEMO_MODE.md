---
sidebar_position: 6
title: 'Demo Mode'
description: 'How Libre WebUI demo mode works for preview deployments.'
slug: /DEMO_MODE
keywords: [libre webui demo mode, preview deployment, mock data]
---

# Demo Mode

Demo mode lets public preview deployments show Libre WebUI without requiring a real backend account or provider credentials.

## When Demo Mode Turns On

Demo mode is enabled when:

- `VITE_DEMO_MODE=true`, or
- the frontend is running on a recognized preview host such as Vercel, Netlify, GitHub Pages, or a `demo.`/`preview.` subdomain.

Local development is not demo mode unless `VITE_DEMO_MODE=true` is set.

## Login Behavior

In demo mode, the login form is prefilled with demo credentials and the fields are disabled. Users only click **Sign in**. Signup and OAuth buttons are hidden in demo mode.

## What Demo Mode Provides

Demo mode uses mock API responses for the main product flows:

- Chat sessions and messages
- Models
- Personas
- Artifacts
- Preferences
- Plugin lists

This keeps the demo interactive without writing real user data.

## What Demo Mode Does Not Do

Demo mode is not a production authentication strategy. It does not provide real persistence, real provider calls, or real account management.

For a real deployment, run the backend with normal authentication and configure the providers you want to expose.

## Configure Demo Mode

Frontend `.env`:

```env
VITE_DEMO_MODE=true
```

Build and run the frontend as usual. If the backend is also running, demo-mode API mocks still take precedence for supported UI flows.

## Related Docs

- [Authentication](./AUTHENTICATION)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Quick Start](./QUICK_START)
