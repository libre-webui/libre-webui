---
name: Libre WebUI
version: '1.0.0'
colors:
  primary: '#F4F4F0'
  secondary: '#A6A69C'
  tertiary: '#2563EB'
  neutral: '#0D0D0C'
  neutral-secondary: '#121211'
  neutral-tertiary: '#1B1B1A'
  neutral-surface: '#171716'
  accent: '#60A5FA'
  success: '#34D399'
  warning: '#FF7B52'
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
    amber: '#FF7B52' # Legacy preference id; displayed as Coral.
    rose: '#E11D48'
    slate: '#475569'
  custom:
    enabled: true
    minimumButtonContrast: 4.5
typography:
  h1:
    fontFamily: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif
    fontSize: 1.875rem
    fontWeight: 700
  h2:
    fontFamily: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif
    fontSize: 1.5rem
    fontWeight: 600
  h3:
    fontFamily: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif
    fontSize: 1.25rem
    fontWeight: 600
  body-md:
    fontFamily: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif
    fontSize: 0.9375rem
    fontWeight: 400
    lineHeight: 1.625
  body-sm:
    fontFamily: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif
    fontSize: 0.8125rem
    fontWeight: 400
  label:
    fontFamily: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif
    fontSize: 0.75rem
    fontWeight: 500
    letterSpacing: -0.005em
  code:
    fontFamily: JetBrains Mono, ui-monospace, SFMono-Regular, monospace
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
    width: 288px
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
    backgroundColor: '{colors.primary}'
    textColor: '{colors.neutral}'
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
    primary: '#181816'
    secondary: '#62625B'
    tertiary: '#2563EB'
    neutral: '#F7F7F5'
    neutral-secondary: '#FCFCFA'
    neutral-tertiary: '#F1F1EE'
    neutral-surface: '#FFFFFF'
---

## Overview

Libre WebUI is a privacy-first AI creation interface. Its design language is quiet futurism: precise typography, warm monochrome canvases, carefully layered surfaces, hairline separators, and motion that clarifies state. The interface should feel considered and unusually calm, leaving the conversation and the work as the most expressive material on screen.

Light and dark modes are equal first-class experiences. Light mode uses a warm off-white canvas rather than clinical gray; dark mode uses near-black rather than blue-black. Both preserve the same hierarchy and spacing.

## Colors

The palette is anchored in warm neutrals with one active accent family at a time. Blue is the default runtime accent, but users can choose another preset or a custom accent in Appearance.

- **Primary (#F4F4F0 in dark, #181816 in light):** Core text and neutral action color. High contrast against the background in both modes. All body text, headings, and primary UI labels use this.
- **Secondary (#A6A69C in dark, #62625B in light):** Muted text for metadata, timestamps, sidebar labels, placeholder text, and secondary information. Never used for primary content — this is the "quiet" voice of the interface.
- **Tertiary (#2563EB default):** The active accent color. Reserved for focus, selection, progress, and status. General primary actions are neutral: dark ink on light canvases and light ink on dark canvases. Restrained usage is critical — if tertiary appears on more than 5% of the visible surface, something is wrong.
- **Accent (#60A5FA default):** Hover state for tertiary elements and secondary highlights. It is derived from the active accent family so interaction feedback remains consistent when users customize color.
- **Neutral (#0D0D0C):** Deepest background layer. Near-black, warm-neutral with no blue cast, used where the interface needs a strong anchor.
- **Neutral-secondary (#121211):** Main dark app background, lifted slightly above pure black to reduce eye strain.
- **Neutral-tertiary (#1B1B1A):** Inputs, user message bubbles, and raised surfaces.
- **Neutral-surface (#171716):** A subtly distinct dark for panels that need separation without a hard border.
- **Success (#34D399):** Confirmation states, connection indicators, successful operations. Green but not neon — it should feel calm, not celebratory.
- **Warning (#FF7B52):** Rate limits, approaching quotas, and non-critical alerts use the shared coral scale.
- **Error (#F87171):** Failed requests, validation errors, disconnection states. Red but not aggressive — this is a tool, not an alarm.
- **Info (#60A5FA):** Informational banners, tooltip accents, documentation links. Cool blue that stays distinct from the active accent.

Status colors always pair with dark text on the colored fill to keep contrast comfortably above WCAG AA.

Work task status indicators use a fixed operational palette rather than the
custom accent:

- **Idle:** `rgb(255, 255, 255)`
- **Thinking:** `rgb(48, 121, 255)`
- **Complete:** `rgb(76, 212, 117)`
- **Needs input:** `rgb(255, 204, 0)`
- **Error:** `rgb(255, 61, 129)`

Every indicator is paired with a translated text label; color never carries the
state alone.

## Accent Customization

Accent selection is a user preference, not a separate light or dark theme. By default, changing the accent updates the primary and accent token scales used by buttons, focus rings, links, sliders, progress bars, and selected states while preserving the neutral palette.

Appearance also offers an opt-in **Adapt to accent** palette. When enabled, the selected preset or custom color tints the canvas, surfaces, borders, text hierarchy, and legacy neutral scales in both light and dark mode. Light mode uses a slightly clearer tint so the accent remains visible across high-lightness surfaces; dark mode keeps its existing restrained saturation. Typography, spacing, component hierarchy, and semantic status colors do not change. Disabling the option restores the exact default neutral light or dark palette.

Preset accents are violet, blue, cyan, teal, emerald, Coral (stored under the legacy `amber` preference id), rose, and slate. Custom accents generate a full shade scale from the selected color, and button shades are darkened as needed so white button text remains at least 4.5:1 contrast. Avoid using multiple accent families in the same viewport. Status colors remain semantic and should not inherit the custom accent.

## Typography

Inter is the preferred typeface when available locally, followed by the native system UI stack. Fonts are not fetched from third-party CDNs: this prevents layout shifts, supports offline desktop use, and respects the product's privacy posture. Native CJK and Arabic system faces remain in the fallback chain.

JetBrains Mono is reserved exclusively for code: inline code spans, code blocks, terminal output, and technical identifiers like model names when displayed in monospace context. Never mix it into prose.

Body text at 0.9375rem (15px) balances density with readability for long-form AI responses. Line height at 1.625 provides breathing room for paragraphs that can run long without fatiguing the eye.

Headings use weight 300-700, with lighter weights reserved for large editorial titles and stronger weights for compact interface labels. They are always primary color — never secondary, never accent. Headings orient; they do not decorate.

## Layout

The spacing scale follows a 4px base: 4, 8, 16, 24, 32, 48. Padding inside message bubbles is 16px. Gaps between messages are 24px. Sidebar item padding is 8px vertical, 12px horizontal. The input bar has 16px internal padding.

Consistency in spacing matters more than any individual measurement. If two similar elements have different padding, that is a bug, not a design choice.

## Shapes

Rounded corners are generous but not circular. Buttons and cards use 12px. Message bubbles use 16px. The input bar uses 24px. Only avatars and status indicators use full rounding (9999px).

## Components

### Sidebar

The sidebar is the navigation anchor — darker than the chat area to recede visually. Conversation list items use secondary text by default, primary text on hover, and a subtle neutral-tertiary background highlight on the active conversation. Width is fixed at 288px when expanded and 72px in the compact rail, with the rail remaining available on mobile.

### Chat Area

Centered with a width of 48rem. User messages get a subtle neutral-tertiary background bubble with rounded-lg corners. Assistant messages have no background fill — they sit directly on the chat area surface, creating visual asymmetry that makes the conversation scannable at a glance.

### Work Area

Chat and Work are peer modes in the primary sidebar header. The active mode is
visibly selected; Work tasks use the main sidebar list instead of introducing a
second navigation rail. Each task row keeps its position while status changes,
shows the task title, model, updated time, and labeled status color, and exposes
deletion even when that task is selected. In the compact rail, ordinary chat
and Work history is hidden; hired agents remain pinned as persona avatars with
their status and unread activity conveyed accessibly.

On wide screens, Work divides the main surface into conversation and workspace
panes with a draggable, keyboard-operable separator. The default conversation
share is 45%, constrained to keep both sides usable, and the saved value is
scoped to the current user. Smaller screens replace the simultaneous split with
clear Conversation and Workspace controls. RTL layouts reverse the visual pane
order and resize direction without changing the logical meaning of either
surface.

The workspace toolbar keeps the high-frequency controls close to the content:
Files contains navigation, formatting, and save actions; Activity shows tool
calls and results; Preview contains the start command, lifecycle controls, and
open action. Code, paths, commands, model identifiers, and tool output always
remain LTR, including inside Arabic RTL layouts.

### Input Bar

The message input is the most important interactive element. It uses neutral-tertiary fill with rounded-xl corners, creating a pill-like shape. The send button uses the neutral inverse treatment and sits inside the input container, aligned right. The active accent is reserved for focus and selection states. Placeholder text uses the secondary color.

### Code Blocks

Code rendering follows the active light or dark mode. Dark mode uses GitHub's
dark palette with a `#0D1117` background; light mode uses the quiet
`surface-subtle` palette so code does not become an unrelated dark slab. Syntax
highlighting follows standard conventions, and a copy button sits in the
top-right corner of message code blocks with ghost button styling. Work's file
editor uses the same theme-aware tokens, keeps the editable text, caret, and
highlight overlay scroll-synchronized, and falls back to readable plain text for
large files.

### Buttons

Primary buttons use the neutral inverse treatment — dark ink in light mode, light ink in dark mode. The active accent appears in their focus treatment, not their resting fill. Secondary buttons use a raised surface and hairline border; ghost buttons reveal a quiet surface only on interaction.

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

Transitions are 140–180ms with an ease-out curve for interactive states. Sidebar collapse/expand is 200ms. Motion changes opacity, color, or a few pixels of position; it does not bounce, glow, or continuously decorate. Every transition and animation must collapse under `prefers-reduced-motion`.

## Brand Identity

Libre WebUI's identity is the absence of excess. No ornamental gradients, neon glow, or mascot. Expressiveness comes from user-created work, not interface chrome. Custom accents personalize focus and selection without changing the restrained neutral system. The word "Libre" means free, and the design should feel uncluttered, unburdened, and focused entirely on creation.

The Kroonen AI wordmark may appear in the sidebar footer or settings page. It uses primary text color at body-sm size. It does not compete with the interface.
