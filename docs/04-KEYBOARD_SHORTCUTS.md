---
sidebar_position: 5
title: 'Keyboard Shortcuts'
description: 'Keyboard shortcuts available in Libre WebUI.'
slug: /KEYBOARD_SHORTCUTS
keywords: [libre webui shortcuts, keyboard shortcuts, productivity]
---

# Keyboard Shortcuts

Libre WebUI includes app-level shortcuts for navigation and message composition.

## Global Shortcuts

| Shortcut               | Action                                            |
| ---------------------- | ------------------------------------------------- |
| `Cmd/Ctrl + K`         | Open or close the command palette                 |
| `Cmd/Ctrl + Shift + O` | Start a new chat in a tab                         |
| `Cmd/Ctrl + Shift + U` | Start a new Work task in a tab (with Work access) |
| `Cmd/Ctrl + B`         | Toggle the sidebar                                |
| `Cmd/Ctrl + ,`         | Open Settings                                     |
| `Cmd/Ctrl + D`         | Toggle light/dark theme                           |
| `?` or `Shift + /`     | Open Settings on the Shortcuts tab                |
| `Esc`                  | Close the settings modal                          |

Global shortcuts never fire while an input has focus, and dialogs such as the
command palette, artifact panel, image lightbox, and model selector each close
with their own `Esc`. `Cmd/Ctrl + K` is the exception to the focus rule: it
also works while a message composer has focus, so you can jump somewhere else
without clearing what you were typing.

### Command Palette

The palette fuzzy-searches your chats, Work tasks, and app actions, highlights
the matched characters, and ranks results by relevance.

| Shortcut      | Action                   |
| ------------- | ------------------------ |
| `Up` / `Down` | Move the selection       |
| `Enter`       | Open the selected result |
| `Esc`         | Close the palette        |

## Chat Input

| Shortcut        | Action            |
| --------------- | ----------------- |
| `Enter`         | Send the message  |
| `Shift + Enter` | Insert a new line |

## Editing a Sent Message

While editing one of your own messages:

| Shortcut | Action                                      |
| -------- | ------------------------------------------- |
| `Enter`  | Save the edit and resubmit the conversation |
| `Esc`    | Cancel editing                              |

## Artifact Viewer

The artifact pane uses normal browser controls:

- Drag the panel edge to resize.
- Use Preview and Code tabs to switch views.
- Copy, download, open, or expand artifacts from the toolbar.
- In interactive HTML artifacts, click inside the preview first when the artifact needs keyboard focus.

## Work

### Composer

| Shortcut        | Action             |
| --------------- | ------------------ |
| `Enter`         | Start the Work run |
| `Shift + Enter` | Insert a new line  |

### File Editor

With the code editor focused:

| Shortcut          | Action                                     |
| ----------------- | ------------------------------------------ |
| `Cmd/Ctrl + S`    | Save the open workspace file               |
| `Shift + Alt + F` | Format a supported file within size limits |

### Conversation and Workspace Split

On desktop, focus the divider between the conversation and workspace panes:

| Shortcut               | Action                                          |
| ---------------------- | ----------------------------------------------- |
| `Left` / `Right Arrow` | Resize the conversation by 2 percentage points  |
| `Shift + Left/Right`   | Resize the conversation by 10 percentage points |
| `Home`                 | Use the smallest allowed conversation pane      |
| `End`                  | Use the largest allowed conversation pane       |
| `Enter`                | Reset the split to its default                  |

You can also drag the divider or double-click it to reset. The selected split
is remembered for the current user. Arrow behavior follows the visual direction
of the interface, including Arabic and other right-to-left layouts.

### Workspace Tabs

With one of the **Files**, **Activity**, **Git**, **Terminal**, or **Preview**
tabs focused:

| Shortcut               | Action                                                       |
| ---------------------- | ------------------------------------------------------------ |
| `Left` / `Right Arrow` | Select the adjacent tab in visual direction, wrapping around |
| `Home`                 | Select Files                                                 |
| `End`                  | Select Preview                                               |

## Notes

Browser, OS, and input method shortcuts can take precedence over app shortcuts. If a shortcut does not fire, check whether the browser already owns that key combination.
