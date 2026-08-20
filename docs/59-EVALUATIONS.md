---
sidebar_position: 59
title: 'Evaluations'
description: 'Reply feedback, blind model arena with Elo, and repeatable eval runs.'
slug: /EVALUATIONS
keywords: [evaluations, feedback, arena, elo, model quality]
---

# Evaluations

The evaluation platform turns everyday use into comparable model quality
signals: quick feedback on individual replies, blind head-to-head arena
matches with an Elo leaderboard, and reusable evaluation sets whose runs
are reproducible durable jobs. Everything runs under your own identity
and provider credentials, and the sensitive parts — snapshots, comments,
set prompts, and run outputs — are encrypted at rest.

## Message feedback

Rating an assistant reply records more than a thumb: a compact panel
offers topic tags (accuracy, style, incomplete, harmful, formatting) and
an optional comment, and Libre snapshots the rated exchange — your
prompt and the reply — so the datapoint survives later chat edits and
deletions. One feedback row exists per user and message; re-rating
replaces it and clearing the thumb deletes it. Your dataset lives under
**Evaluations → Feedback**; administrators can read the instance-wide
dataset for curation. Private sessions never produce feedback rows.

## Arena and leaderboard

An arena match sends one prompt to two models of your choice and shows
both replies in randomized order. Model identities stay hidden until the
vote lands — first, second, tie, or both bad — and each user votes once
per match. The leaderboard replays every vote in insertion order through
a deterministic Elo rating (K=32, base 1000), so recomputing it always
produces the same standings; "both bad" counts participation without
moving ratings.

## Evaluation sets and runs

An evaluation set is a named list of up to 50 prompts. Running a set
against a model executes as a durable job: each prompt runs one at a
time under your credentials, progress is visible while it runs, item
failures are recorded per item rather than aborting the run, and
cancellation marks the run cancelled. A completed run stores the exact
model, every output, and per-item latency — encrypted — and exports as
JSON for side-by-side comparison or regression tracking across model,
prompt, or provider changes.
