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

## Manage Tabs with the Context Menu

Right-click a tab (or press `Shift + F10` on a focused tab) for:

- **Close tab**
- **Close other tabs**
- **Close tabs to the right**
- **Close all tabs**

Home is always the first tab and cannot be closed. Administrators also get
direct **User Management**, **System**, and **Provider Usage** entries in the
`+` menu — and can pin any of the three into the sidebar footer (next to
Settings) with the pin icon in the avatar menu, so they never need the menu
again.

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
**Settings > User Management > Default theme** (Light, Dark, or Pure Black). That default paints the
sign-in page, seeds every new account, and applies in any browser that has not
picked a theme of its own; a saved personal preference is always respected.
Libre WebUI does not follow the operating system's theme setting; switch
explicitly with `Cmd/Ctrl + D`, the sun/moon button, or from Settings. The
toggle cycles Light, Dark, and Pure Black.

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
