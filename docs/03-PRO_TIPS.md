---
sidebar_position: 4
title: 'Pro Tips'
description: 'Practical workflows for getting more out of Libre WebUI.'
slug: /PRO_TIPS
keywords: [libre webui pro tips, ai workflows, ollama tips, productivity]
---

# Pro Tips

This page collects practical workflows that make Libre WebUI feel faster, cleaner, and more reliable in daily use.

## Keep a Small Daily Model Loaded

Use a fast local model for routine work and switch to larger models only when the task needs it.

Good daily-driver examples:

- `gemma4:12b` for fast everyday chat
- `qwen3.8:27b` for stronger general work
- `gemma4:26b` for MoE efficiency on bigger hardware
- `gemma4:31b` for the best dense local quality
- `nomic-embed-text` for document embeddings

Open **Models** to see which models are running. Unload models you are not using when VRAM gets tight.

## Name New Chats While the Reply Runs

Enable **Auto Title** and choose a **Task Model** under **Settings → Defaults**.
For a new saved chat, title generation summarizes your first message as soon
as you send it, alongside the assistant response. The sidebar updates when
the title is ready; a slow title request does not block the reply.

The selected task model and provider handle the title request. A provider
that serializes requests may still queue it. Follow-up messages, chats you
have already named, and incognito chats do not trigger automatic titles.

## Follow Live Thinking

When **Auto Title** is enabled and a **Task Model** is selected under
**Settings → Defaults**, the collapsed thinking block shows a short activity
summary while the assistant reasons. The same task model receives the latest
reasoning excerpt to describe the current topic, so choose a local model when
that text must stay on your machine.

Summaries use at most the latest 4,000 characters, start after enough text is
available, and update at most once every five seconds with one request in
flight. A slow or failed summary never blocks the answer. The last summary
remains visible for that rendered message after thinking ends, alongside its
duration; expand the block to read the original reasoning. These summaries
are temporary and are not saved in chat history.

The activity text animates as it changes, with the same loading indicator as
pending chat titles. Reduced-motion preferences disable both animations.
Incognito chats and chats without an enabled task model keep the ordinary
thinking label without making summary requests.

## Use Incognito Chat for Conversations That Should Not Persist

Start an incognito chat from the tab bar's `+` menu, the command palette, the
Home page, or the ghost button on the chat welcome screen. It also has a
direct URL: `/chat?incognito=1`.

An incognito chat is never persisted: no session is created on the server, no
message is saved, and it never appears in the sidebar or history. The chat
shows a **Private Mode** banner ("This conversation won't be saved"). Opening
a saved chat leaves incognito mode; reloading an incognito tab starts a fresh
empty private chat, so the previous turns are gone.

Be clear about the boundary: incognito controls persistence, not provider
exposure. The selected model — local or remote — still receives the full
conversation, and document context still applies when it is enabled. For a
conversation that must not leave your infrastructure, combine incognito with a
local Ollama model.

## Use the Compact Sidebar

The compact sidebar keeps direct shortcuts to Channels, Notes, Calendar,
Automations, Personas, and Imagine beneath Chat and Work, with Search last.
The Agents shortcut appears when enabled for your account. Hover over an icon for its
label; the current destination stays highlighted. On short screens, scroll
the shortcuts while settings and account controls remain at the bottom.

## Scroll Through Panels

Chat and Work lists fade softly at edges where more items are available.
The fade clears at the beginning or end of the list, and lists that fit remain
fully visible. Keyboard focus keeps the list clear so controls stay readable.

The top tab bar uses the same fade at its horizontal scroll edges. The fade
clears when all tabs fit or when you reach either end. Selecting a tab brings
it into view, and the new-tab button stays fully visible beside the strip.

The same effect follows scrolling in Settings, Chat, Work, library pages,
menus, and dialog content, including horizontal lists and tables. Settings
keeps its title and search field above the scrolling navigation. Fades update
when content loads, filters change, or the window resizes, and work in every
theme and right-to-left layouts. Keyboard navigation clears the fade around
focused controls; using the mouse or touch restores it. Text inputs and the
internals of embedded apps and terminal/editor widgets keep their own rendering.

Chat and Work use a wider fade for older content at the top and beneath their
**New messages** and **New activity** buttons when you scroll up. These buttons
stay clear above the fading text and return you to the latest content, where
the bottom fade disappears.

## Manage Tabs with the Context Menu

Right-click a tab (or press `Shift + F10` on a focused tab) for:

- **Close tab**
- **Close other tabs**
- **Close tabs to the right**
- **Close all tabs**

Home is always the first tab and cannot be closed. Administrators can pin
**System**, **Provider Usage**, and **Evaluations** into the sidebar footer
using the pin icon in the avatar menu. User administration lives under
**Settings → User Management**.

## Fly Around with the Command Palette

`Cmd/Ctrl + K` opens the command palette from anywhere — including while the
composer has focus. It fuzzy-matches across app actions, your chats, and your
Work tasks, so partial or misspelled queries still land: `autmtn` finds
**Automations**, "pictures" finds **Imagine**, "dark" finds the theme toggle.
From three characters on it also searches inside message, note, and document
content (including notes shared with you) and shows a snippet for each hit —
this runs over your own decrypted data in memory; nothing is indexed in
plaintext on disk. Matched characters are highlighted,
results are ranked by relevance, and with no query you get your most recent
chats and tasks. Navigate with `↑`/`↓`, open with `Enter`, close with `Esc`
(or `Cmd/Ctrl + K` again).

## Theme Default

New installs use the dark theme, applied before first paint so there is no
light flash. An administrator can change the instance-wide default from
**Settings > User Management > Defaults > Default theme** (Light, Dark, or Pure Black). That default paints the
sign-in page, seeds every new account, and applies in any browser that has not
picked a theme of its own; a saved personal preference is always respected.
Libre WebUI does not follow the operating system's theme setting; switch
explicitly with `Cmd/Ctrl + D`, the sun/moon button, or from Settings. The
toggle cycles Light, Dark, Pure Black, and Celestial.

**Celestial** follows the sun: the palette and a live sky (sun or moon on its
arc, clouds, stars after dusk, a lamp that follows the pointer at night) shift
minute by minute, with sunrise and sunset moving through the year. Pick it in
Settings > Appearance. The sky clock at the end of the tab bar opens a glass
preview: drag across the day to move the sun and moon, or jump straight to
**Sunrise** or **Sunset**. The same preview is available in Appearance.
The preview identifies **Live** time and a manually selected **Preview**, with
time labels along the slider. **Follow the clock**, closing the preview, or
leaving Appearance returns to real time. Exploring the day runs locally and does not save a new theme setting.
Without a location it assumes a
mid-latitude day; share your location (or type coordinates) and sunrise and
sunset are solved for your actual sky. The location is rounded to about a
kilometre, kept only in that browser, and never sent to the server.
Manual coordinates have visible Latitude and Longitude labels. Latitude must
be between -90 and 90; longitude between -180 and 180. **Apply** or Enter saves
valid coordinates. Invalid or incomplete entries preserve the saved location;
**Clear** explicitly removes it. With a
location you can also turn on **Match the weather**: current conditions come
straight from Open-Meteo to your browser, and clouds, rain, snow, fog, and
wind shape the sky. If a request fails, Libre keeps the last successful weather
for this session and retries automatically while the celestial theme is active.
Retries start after 15 seconds and slow to at most one every five minutes during
an outage. A request that stalls for ten seconds is cancelled so it cannot block
later refreshes. Turning weather off or changing location cancels pending requests.

Celestial uses the same glass composer in Chat and Work. Sun and moon placement
scales to the screen, and the pointer light stays beneath the reading surface.
Decorative motion pauses when the tab is hidden and responds immediately to the
system's reduced-motion preference, including during the theme's arrival sweep.

## Account Wallpaper

In **Settings > Appearance > Background Image**, choose an image up to 10 MB.
Your source image and settings are saved to your account. The wallpaper appears
on Home and in Chat and Work; it does not paint the sidebar, tab bar, or library pages.

**Dithered** creates distinct square pixels with open gaps in the shadows,
inspired by the image's colors. Bright areas are softened before the dots are
created, keeping pale skies and light photos textured instead of a solid wash.
**Original** uses a smooth image, and **Blurred** adds adjustable softening. All
three styles fade into the current theme and adapt highlights for readability;
the uploaded source is never changed. **Intensity** previews immediately and
saves after you stop adjusting it. Zero intensity hides the wallpaper without
removing it. You can also disable it temporarily, replace it, or remove it.

The preview works across Light, Dark (grey), Pure Black, and Celestial. On mobile,
opening navigation hides the wallpaper until the navigation overlay closes.
Persona backgrounds stay specific to their chats and do not replace the account
wallpaper. Image processing runs in your browser. If an external image cannot be
processed because of its origin policy, a local visual fallback is used.

## Keep Work Tasks Focused

Use a separate Work task for each project or independent goal. Every task has
its own conversation, managed container identity, and persistent files. The
container itself can stop or be recreated while its named volume survives, so
reusing the same task preserves useful context while starting a new task creates
a clean boundary.

A good first instruction gives the model:

- The result you want.
- Important technical or design constraints.
- The command or behavior that should verify completion.
- Any files or interfaces that must remain unchanged.

Follow progress in **Activity**, then inspect and test the result in **Files**,
**Git**, **Terminal**, and **Preview**. The file editor supports syntax highlighting in light and dark
themes, browser-backed unsaved drafts, and formatting for supported file types.
Use `Cmd/Ctrl + S` to save and `Shift + Alt + F` to format.

Use an installed tool-capable Ollama model when you want model traffic to stay
on your configured Ollama infrastructure. A remote or cloud model can reduce
local inference memory pressure, but it can make multiple billable calls and
receives requested tool results, which may contain workspace data.

Stopping a run or preview keeps the workspace. Deleting a Work task removes its
workspace permanently, so copy out anything you need first.

## Use Personas for Repeatable Work

Create personas for workflows you repeat:

- A concise code reviewer with low temperature.
- A writing editor with a clear style guide.
- A research assistant with document search enabled.
- A support assistant with a fixed tone and response structure.

Personas store the selected model, system prompt, generation parameters, avatar/background, and optional memory/mutation settings. They can also be exported and imported as JSON.

## Keep Durable Notes Beside Your Work

Open **Notes** from the create menu when information should remain independent
of one chat or Work task. Notes support Markdown preview, explicit editing,
search, and automatic saving. The preview also renders inline SVG and basic
HTML embedded in a note, sanitized so scripts, event handlers, and unsafe
URLs never execute. The note tools drawer adds revision history
with restore, file attachments, pinning, per-user sharing (view or edit),
Markdown export, and an AI edit sidebar that previews every proposal as a
diff before it is applied — and since applying snapshots the previous
version first, any AI edit can be undone. Notes are account-scoped and are
included in a full user archive; revision history and attachments stay on
the instance and are not part of the archive.

## Make Artifacts More Reliable

Libre WebUI detects explicit artifact tags, fenced code blocks, standalone HTML documents, and common multi-file HTML bundles. To get the best artifact output from a model, ask for:

```text
Create one complete self-contained HTML file.
Inline the CSS and JavaScript.
Do not rely on external files unless they are CDN URLs.
```

If you want separate blocks, name them clearly:

````markdown
```html filename="index.html"
...
```

```css filename="style.css"
...
```

```js filename="app.js"
...
```
````

Libre WebUI will try to bundle local CSS and JavaScript blocks into the HTML preview.

## Queue Prompts While a Reply Streams

Sending during generation queues the prompt instead of dropping it: queued
prompts appear above the composer, can be edited, reordered, and removed,
and are sent one by one as each reply finishes. The queue is stored with
the chat, so it survives a reload or reconnect.

## Fork a Conversation

The fork button on any message copies the conversation up to that point
into a new chat, variants included, and records where it came from. The
original stays untouched, so exploratory tangents never pollute the main
thread.

## Compare Models in One Turn

The columns button beside the tool picker fans your next prompt out to up
to three extra models. Each reply is its own generation with its own model
label, statistics, and cancel control, so slow or failing models never
block the others.

## Use Document Chat Deliberately

Document Chat accepts PDF, Office (DOCX/PPTX/XLSX), Markdown, HTML, code, and CSV files up to 10 MB. Search works in two modes:

- Keyword search (BM25) is always available.
- Hybrid search fuses semantic and keyword rankings when embeddings are enabled in Settings and an embedding model is available.

Install `nomic-embed-text` if you want an easy local embedding model:

```bash
ollama pull nomic-embed-text
```

For best results, upload focused documents per chat instead of one huge mixed document set.

## Tune Generation Settings

| Setting        | Practical use                                                       |
| -------------- | ------------------------------------------------------------------- |
| Temperature    | Lower for accuracy, higher for creative exploration                 |
| Top P / Top K  | Leave defaults unless you are deliberately tuning sampling          |
| Context window | Increase for long chats only if your model and memory can handle it |
| Max tokens     | Limit long answers or raise for code/artifact generation            |
| Repeat penalty | Raise slightly when a model loops                                   |

When a model behaves badly, first lower temperature, then reduce context pressure, then try another model.

## Decide How Hard a Model Thinks

The control beside the model name in the composer opens the reasoning levels:
**off**, **on**, **low**, **medium**, and **high**. The choice belongs to the
conversation, so it survives a reload and applies to a regenerate; Settings >
Generation holds the default for new replies, and the chat controls panel shows
the same value.

Leave it unset and nothing is sent, which is what every release before this one
did. Set it and the server translates the one value for whichever provider
answers: Ollama takes it in the request body, OpenAI-style providers take a
reasoning effort, and Anthropic and Gemini take a token budget with room
reserved for the answer.

Two things are worth knowing. A model Ollama reports as unable to reason never
receives the setting at all, so the control is simply absent for it. And the
named levels only exist on the models that publish them, such as gpt-oss; on a
model that reasons without levels, a named level simply behaves as **on**, so a
chat that moves between models never errors over it. When a global or pinned
default is set, the composer button shows the level the next reply actually
runs with, and the "Default" entry names what it currently resolves to.

## Watch the Context Window

The ring beside the model name fills as the conversation grows. Hover it for how
full the window is, the tokens used, and the window they run against. It turns
amber past four fifths and red at the window; a model whose window is unknown
shows a dashed ring rather than an empty one.

The count covers what the next request will actually send — compacted history
and abandoned branches cost nothing. It anchors to what the provider measured
for the last reply when it reported one, plus an estimate at four characters
per token for what the conversation added since, marked with a `~` when no
measurement exists yet. A window capped below what the model was trained for
says so: the meter
measures the window the request actually runs with, which is
`OLLAMA_MAX_CONTEXT` (32,768 by default) rather than the model's full trained
length. Raise that variable and both the real window and the meter follow.

Provider models show a window only when their model listing publishes one. When
it does not, the meter still counts the tokens and simply has nothing to divide
them by.

## Let Long Chats Compact Themselves

Administrators can turn on **context compaction** in Settings > Generation. Once a conversation's estimated context passes the token threshold, the server asks a model to summarize the older messages and keeps only the most recent ones verbatim. The summary appears as a conversation-summary card at the point in the chat where the history was folded, and the summarized messages render dimmed: still readable, no longer sent to the model. With compaction on, the "recent messages kept" count is also the rolling window a conversation sends, so raising it genuinely widens what the model sees.

| Setting               | What it controls                                                       |
| --------------------- | ---------------------------------------------------------------------- |
| Token threshold       | Estimated context size that triggers a compaction                      |
| Recent messages kept  | How many of the latest messages always stay verbatim                   |
| Compaction model      | Which model writes summaries; defaults to the conversation's own model |
| Custom summary prompt | Your own instructions, with `{{PREVIOUS_SUMMARY}}` and `{{MESSAGES}}`  |

Compaction is off by default and applies to every user on the server, but each chat keeps a say: the chat controls panel can switch compaction off for one conversation, and every summary card carries an undo — restoring reactivates exactly the messages that summary replaced, one compaction at a time. It never splits a turn: the messages kept verbatim always start on one of your own. Each new compaction folds the previous summary into the new one, so a conversation carries a single running summary. If the summarizer fails, generation continues with the uncompacted history rather than blocking on it.

## Keep Provider Keys Per User

Provider plugins can read environment keys, but user-level credentials are usually cleaner for shared installs. Add keys in Settings so each user controls their own provider access.

Use backend environment variables for deployment-wide defaults or automated installs.

## Make Remote Access Predictable

For phone or LAN access, bind the dev server to the network interface:

```bash
npm run dev:host
```

Then open the machine’s LAN or Tailscale IP **on port 8080** from the other device (`dev:host` serves the frontend on 8080, not Vite's default). In production, set `CORS_ORIGIN` and the frontend API URL explicitly so browsers do not fall back to localhost.

## Check Your Version Without Leaving the App

**Settings → About** compares your build against the latest GitHub release: it
tells you when you're current, links the release page when you're behind, and
says so when a `-dev` build is running ahead of the pinned release. The same
line has a **View changelog** button that reopens the release notes you saw
after upgrading — and if Libre WebUI is useful to you, the **Star on GitHub**
link there is the easiest way to help others find it.

## Keep Docs and UI in Sync

The product changes quickly. Prefer durable docs that describe behavior and workflows, and let the UI show live model lists from providers. Avoid copying long provider catalogs into docs unless the list is generated by the app.

## Related Docs

- [Work: Isolated Workspaces](./WORKSPACES)
- [Working with Models](./WORKING_WITH_MODELS)
- [Calendar](./CALENDAR)
- [Automations](./AUTOMATIONS)
- [Document Chat](./RAG_FEATURE)
- [Notes](./NOTES)
- [Artifacts](./ARTIFACTS_FEATURE)
- [Personas](./PERSONA_DEVELOPMENT_FRAMEWORK)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
