---
name: Libre WebUI
version: '1.0.0'
colors:
  primary: '#FFFFFF'
  secondary: '#9CA3AF'
  tertiary: '#2563EB'
  neutral: '#0A0A0A'
  neutral-secondary: '#111113'
  neutral-tertiary: '#27272A'
  neutral-surface: '#202023'
  accent: '#60A5FA'
  success: '#34D399'
  warning: '#FBBF24'
  error: '#F87171'
  info: '#60A5FA'
accent-presets:
  default: blue
  options:
    violet: '#7C3AED'
    blue: '#2563EB'
    cyan: '#0E7490'
    teal: '#0F766E'
    emerald: '#15803D'
    amber: '#B45309'
    rose: '#E11D48'
    slate: '#475569'
  custom:
    enabled: true
    minimumButtonContrast: 4.5
typography:
  h1:
    fontFamily: Inter, system-ui, -apple-system, sans-serif
    fontSize: 1.875rem
    fontWeight: 700
  h2:
    fontFamily: Inter, system-ui, -apple-system, sans-serif
    fontSize: 1.5rem
    fontWeight: 600
  h3:
    fontFamily: Inter, system-ui, -apple-system, sans-serif
    fontSize: 1.25rem
    fontWeight: 600
  body-md:
    fontFamily: Inter, system-ui, -apple-system, sans-serif
    fontSize: 0.9375rem
    fontWeight: 400
    lineHeight: 1.625
  body-sm:
    fontFamily: Inter, system-ui, -apple-system, sans-serif
    fontSize: 0.8125rem
    fontWeight: 400
  label:
    fontFamily: Inter, system-ui, -apple-system, sans-serif
    fontSize: 0.75rem
    fontWeight: 500
    letterSpacing: 0.05em
  code:
    fontFamily: JetBrains Mono, Fira Code, monospace
    fontSize: 0.875rem
    fontWeight: 400
rounded:
  sm: 6px
  md: 12px
  lg: 16px
  xl: 24px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
components:
  sidebar:
    backgroundColor: '{colors.neutral}'
    width: 260px
  chat-area:
    backgroundColor: '{colors.neutral-secondary}'
    width: 48rem
  message-user:
    backgroundColor: '{colors.neutral-tertiary}'
    textColor: '{colors.primary}'
    rounded: '{rounded.lg}'
    padding: '{spacing.md}'
  message-assistant:
    backgroundColor: '{colors.neutral-secondary}'
    textColor: '{colors.primary}'
    padding: '{spacing.md}'
  input-bar:
    backgroundColor: '{colors.neutral-tertiary}'
    textColor: '{colors.primary}'
    rounded: '{rounded.xl}'
  button-primary:
    backgroundColor: '{colors.tertiary}'
    textColor: '{colors.primary}'
    rounded: '{rounded.md}'
  button-ghost:
    backgroundColor: '{colors.neutral-tertiary}'
    textColor: '{colors.primary}'
  link:
    textColor: '{colors.accent}'
    typography: '{typography.body-md}'
  metadata:
    textColor: '{colors.secondary}'
    typography: '{typography.body-sm}'
  model-selector:
    backgroundColor: '{colors.neutral-tertiary}'
    textColor: '{colors.primary}'
    rounded: '{rounded.md}'
  toggle-active:
    backgroundColor: '{colors.tertiary}'
  code-block:
    backgroundColor: '#0D1117'
    textColor: '#E6EDF3'
    rounded: '{rounded.md}'
    typography: '{typography.code}'
  panel:
    backgroundColor: '{colors.neutral-surface}'
    textColor: '{colors.primary}'
    padding: '{spacing.md}'
  status-success:
    backgroundColor: '{colors.success}'
    textColor: '{colors.neutral}'
    rounded: '{rounded.full}'
  status-warning:
    backgroundColor: '{colors.warning}'
    textColor: '{colors.neutral}'
    rounded: '{rounded.full}'
  status-error:
    backgroundColor: '{colors.error}'
    textColor: '{colors.neutral}'
    rounded: '{rounded.full}'
  status-info:
    backgroundColor: '{colors.info}'
    textColor: '{colors.neutral}'
    rounded: '{rounded.full}'
light:
  colors:
    primary: '#111827'
    secondary: '#6B7280'
    tertiary: '#2563EB'
    neutral: '#F8FAFC'
    neutral-secondary: '#FFFFFF'
    neutral-tertiary: '#F1F5F9'
    neutral-surface: '#E2E8F0'
---

## Overview

Libre WebUI is a privacy-first AI chat interface. The design language draws from the established conventions of modern AI chat UIs — the sidebar-plus-chat layout — while introducing a clear blue default accent that matches the product UI. The overall feeling is focused, professional, and unobtrusive: a tool that stays out of the way and lets the conversation be the product.

Dark mode is the default and primary experience. Light mode exists for accessibility and preference, not as an afterthought but not as the hero either.

## Colors

The palette is anchored in cool neutrals with one active accent family at a time. Blue is the default, but users can choose another preset or a custom accent in Appearance.

- **Primary (#FFFFFF in dark, #111827 in light):** Core text color. High contrast against the background in both modes. All body text, headings, and primary UI labels use this.
- **Secondary (#9CA3AF):** Muted text for metadata, timestamps, sidebar labels, placeholder text, and secondary information. Never used for primary content — this is the "quiet" voice of the interface.
- **Tertiary (#2563EB default):** The active accent color. Used exclusively for interactive elements that demand attention: primary buttons, active toggles, the send button, selected nav items. Restrained usage is critical — if tertiary appears on more than 5% of the visible surface, something is wrong.
- **Accent (#60A5FA default):** Hover state for tertiary elements and secondary highlights. It is derived from the active accent family so interaction feedback remains consistent when users customize color.
- **Neutral (#0A0A0A):** Sidebar and deepest background layer. Near-black, warm-neutral with no blue cast, used only where the interface needs a strong anchor.
- **Neutral-secondary (#111113):** Main dark app background. Lifted slightly above pure black to reduce eye strain while preserving the dark identity.
- **Neutral-tertiary (#27272A):** Cards, input fields, user message bubbles, and elevated surfaces. The lightest of the main dark surface tiers.
- **Neutral-surface (#202023):** A subtly distinct dark for panels that need to separate from the chat area without a hard border. Used for settings panels, popovers, and contextual overlays.
- **Success (#34D399):** Confirmation states, connection indicators, successful operations. Green but not neon — it should feel calm, not celebratory.
- **Warning (#FBBF24):** Rate limits, approaching quotas, non-critical alerts. Amber, not orange.
- **Error (#F87171):** Failed requests, validation errors, disconnection states. Red but not aggressive — this is a tool, not an alarm.
- **Info (#60A5FA):** Informational banners, tooltip accents, documentation links. Cool blue that stays distinct from the active accent.

Status colors always pair with dark text on the colored fill to keep contrast comfortably above WCAG AA.

## Accent Customization

Accent selection is a user preference, not a theme fork. Changing the accent updates the primary and accent token scales used by buttons, focus rings, links, sliders, progress bars, and selected states. The neutral palette, typography, spacing, and component hierarchy do not change.

Preset accents are violet, blue, cyan, teal, emerald, amber, rose, and slate. Custom accents generate a full shade scale from the selected color, and button shades are darkened as needed so white button text remains at least 4.5:1 contrast. Avoid using multiple accent families in the same viewport. Status colors remain semantic and should not inherit the custom accent.

## Typography

Inter is the primary typeface — geometric, highly legible at small sizes, excellent language coverage for a multilingual AI interface. Falls back through system-ui to ensure zero-delay rendering.

JetBrains Mono is reserved exclusively for code: inline code spans, code blocks, terminal output, and technical identifiers like model names when displayed in monospace context. Never mix it into prose.

Body text at 0.9375rem (15px) balances density with readability for long-form AI responses. Line height at 1.625 provides breathing room for paragraphs that can run long without fatiguing the eye.

Headings use weight 600-700 and are always primary color — never secondary, never accent. Headings orient; they do not decorate.

## Layout

The spacing scale follows a 4px base: 4, 8, 16, 24, 32, 48. Padding inside message bubbles is 16px. Gaps between messages are 24px. Sidebar item padding is 8px vertical, 12px horizontal. The input bar has 16px internal padding.

Consistency in spacing matters more than any individual measurement. If two similar elements have different padding, that is a bug, not a design choice.

## Shapes

Rounded corners are generous but not circular. Buttons and cards use 12px. Message bubbles use 16px. The input bar uses 24px. Only avatars and status indicators use full rounding (9999px).

## Components

### Sidebar

The sidebar is the navigation anchor — darker than the chat area to recede visually. Conversation list items use secondary text by default, primary text on hover, and a subtle neutral-tertiary background highlight on the active conversation. The model selector sits at the top. Width is fixed at 260px on desktop, collapsible on mobile.

### Chat Area

Centered with a width of 48rem. User messages get a subtle neutral-tertiary background bubble with rounded-lg corners. Assistant messages have no background fill — they sit directly on the chat area surface, creating visual asymmetry that makes the conversation scannable at a glance.

### Input Bar

The message input is the most important interactive element. It uses neutral-tertiary fill with rounded-xl corners, creating a pill-like shape. The send button uses the active accent and sits inside the input container, aligned right. Placeholder text uses the secondary color.

### Code Blocks

Use GitHub's dark palette (#0D1117 background) regardless of the app's light/dark mode. Code is always dark. Syntax highlighting follows standard conventions — strings in green-ish tones, keywords in blue-purple, comments in gray. A copy button sits in the top-right corner with ghost button styling.

### Buttons

Primary buttons use the active accent with white text — used for actions that move the user forward (send, confirm, save). Ghost buttons sit on a neutral-tertiary fill with primary text — used for everything else (settings toggles, sidebar actions, context menus).

### Links

Inline links use the active accent on a transparent background. Body-md typography keeps them in line with surrounding prose; underline appears on hover.

### Metadata

Timestamps, sidebar labels, character counts, and other quiet metadata use secondary text at body-sm size. Metadata never competes with content — it sits beside it, not within it.

### Status Indicators

Small pill-shaped chips for connection state, validation feedback, and system messages. Each status color (success, warning, error, info) pairs with dark neutral text and uses full rounding. Indicators never carry meaning through color alone — they always include an icon or short label.

### Panels

Settings drawers, command palettes, and contextual overlays use the neutral-surface fill to distinguish themselves from the chat area without introducing a hard border.

## Accessibility

All text meets WCAG AA contrast requirements at minimum. Primary text on neutral backgrounds exceeds 7:1 contrast ratio. White text on primary action buttons passes AA at body sizes for all preset accents and generated custom accents. Interactive elements have visible focus indicators using the active accent color with a 2px offset ring. No information is conveyed through color alone — status indicators pair color with iconography or text labels.

## Motion

Transitions are 150ms ease-out for interactive states (hover, focus, active). Sidebar collapse/expand is 200ms. No decorative animation. No loading spinners that spin indefinitely — use skeleton screens or progress indicators with determinate progress when possible.

## Brand Identity

Libre WebUI's identity is the absence of excess. No gradients. No illustrations. No mascot. Blue is the default brand accent, and custom accents are a personalization layer over the same restrained system. The word "Libre" means free, and the design should feel free: uncluttered, unburdened, focused entirely on the conversation between human and machine.

The Kroonen AI wordmark may appear in the sidebar footer or settings page. It uses primary text color at body-sm size. It does not compete with the interface.
