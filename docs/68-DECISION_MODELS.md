---
sidebar_position: 68
title: 'Decision Models'
description: 'Use decision models in Libre WebUI: typed yes/no, choice, and score answers with probabilities, from Ollama, llama.cpp, Baseten, OpenRouter, OpenAI, and Gemini.'
slug: /DECISION_MODELS
keywords:
  [
    decision models,
    system one,
    decisions api,
    classification,
    routing,
    ollama,
    nimble,
    clef,
    jev,
    openrouter,
    baseten,
  ]
---

# Decision Models

A decision model answers questions about an input with probabilities instead
of writing text. You give it a **state** (a message, a JSON object, or an
image) and **questions**, and every answer comes back typed:

| Question type | What you define                             | What comes back                                             |
| ------------- | ------------------------------------------- | ----------------------------------------------------------- |
| Yes/no        | A question, optionally what yes and no mean | The probability that the answer is yes                      |
| Choice        | 2 to 255 named options                      | The likeliest option and every option's probability         |
| Score         | 2 to 10 levels, lowest first                | The probability-weighted level, from 0 to the highest level |

They are fast and cheap, which makes them good at routing, classification,
moderation, and checking a draft against a rubric. They cannot write.

## Where decision models come from

| Provider   | How Libre WebUI finds them                                   | API                         |
| ---------- | ------------------------------------------------------------ | --------------------------- |
| Ollama     | Installed models with the `decision` capability              | `POST /v1/systemone`        |
| llama.cpp  | Models whose listing reports the `decisions` output modality | `POST /v1/systemone`        |
| Baseten    | The `decision-models/…` namespace of its model list          | `POST /v1/systemone`        |
| OpenRouter | Its catalog of decision models                               | `POST /api/alpha/decisions` |
| OpenAI     | `gpt-6-luna-decisions`, sent to OpenAI as `gpt-6-luna`       | `POST /v1/decisions`        |
| Gemini     | `gemini-decision-1`                                          | `POST /v1beta/decisions`    |

Ollama added decision models in 0.35.0, and newer models need newer
releases (Clef Flash 0.35.1, Kev 0.40.4). When a pull says the model needs a
newer Ollama, update Ollama and pull again. Pull a decision model from the
model picker's **Ollama** tab under **Decision**, or from a terminal:

```shell
ollama pull nimble
```

Nimble and Tev read text; Clef and Clef Flash also read images. Provider
decision models use the API key you already saved for that provider. On
OpenAI, `gpt-6-luna` stays a chat model; its decision model is listed as
`gpt-6-luna-decisions` so the two never mix. A llama.cpp server or an
OpenAI-compatible endpoint with a changed **Base URL** sends its decisions to
the same place.

## In Chat

Decision models appear in the model picker with a **Decision** badge. Pick one
and the composer shows its decision questions. There are two ways to use it.

**With questions set.** Click **Set questions** and add yes/no, choice, or
score questions. Each message you send is then a new state, and the reply
shows each question with its answer, that answer's probability, and the full
spread. Attach an image to judge it with a model that reads images.

**Without questions.** The chat works like `ollama run` with a decision model:
your first message is the state, and each line you send after it is a yes/no
question about it, so you can paste several at once. Send `/clear` to start
over with a new state.

The questions are saved with the chat. Web search, tools, thinking, and model
comparison are hidden while a decision model is selected, because none of them
mean anything to it. Titles, follow-up suggestions, and context compaction
never call a decision model.

## Decisions API

`POST /api/decisions` answers one request. API tokens need the `chat` scope.

```bash
curl https://your-instance/api/decisions \
  -H "Authorization: Bearer lwk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nimble",
    "state": "I was charged twice. Please refund the extra payment.",
    "questions": {
      "refund": { "type": "noul", "instructions": "Is a refund requested?" },
      "team": {
        "type": "choice",
        "instructions": "Which team should handle this?",
        "criteria": { "billing": "Payments and refunds", "technical": null }
      }
    }
  }'
```

Add `providerType` and `providerId` to pick a provider's model, for example
`"providerType": "plugin", "providerId": "baseten"`. `images` takes up to four
PNG, JPEG, or WebP images as base64 or data URLs. Libre WebUI translates the
request to each provider's format and returns the same answer shape from all
of them, with the token usage the provider reported.
`GET /api/decisions/models` lists the decision models your account can reach.

## Access

Decision models are for administrators until an administrator opens them to
everyone with the **Decision models** card in **User Management**. Set
`DECISION_MODELS_ACCESS_MODE` to `admins` or `all-users` to pin the choice and
lock the card. The check runs on every chat turn and every API request.
Provider decision calls appear on the **Provider Usage** page with their model
and token counts.

## Limits

A request takes at most 64 questions and 4 images of 4 MiB each (8 MiB in
all), which is the tightest limit any supported provider documents. Each
provider can be stricter: Nimble takes at most 26 options in a choice, Baseten's
models take 16,384 tokens of input, and Ollama's local server takes 64 KiB of
text. A provider's own error is shown as it gave it.

## Related Docs

- [Provider Connections](./35-PROVIDER_CONNECTIONS.md)
- [Plugins](./08-PLUGIN_ARCHITECTURE.md)
- [Public API](./53-PUBLIC_API.md)
