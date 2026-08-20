# Voice Mode

Voice mode turns a chat into a hands-free, turn-based conversation:
Libre listens, transcribes what you said, generates a reply, and speaks
it back — then listens again. Interrupt a spoken reply just by talking
over it. Everything runs through the same speech-to-text and
text-to-speech contracts as the composer's dictation and read-aloud
features; voice mode adds only orchestration, never a new audio path.

## Starting a conversation

Open a chat and press the voice-mode button next to the microphone in
the composer. The button appears whenever speech input is available:
either a provider speech-to-text model (the same catalog as composer
dictation, documented in the speech-to-text page) or the browser's own
speech recognition. Spoken replies use your configured text-to-speech
model and voice — including a saved voice with active consent — and are
primed against browser autoplay policy by the opening gesture itself.

## The conversation loop

One turn is active at a time, moving through four visible phases:

| Phase        | What is happening                                                        |
| ------------ | ------------------------------------------------------------------------ |
| Listening    | The microphone records; a pause of about 1.5 s ends your turn            |
| Transcribing | The recording is transcribed by the selected provider or the browser     |
| Thinking     | The transcript is sent as a normal chat message and the reply generates  |
| Speaking     | The reply plays through your text-to-speech settings                     |

Controls while the overlay is open:

- **Done speaking** ends your turn immediately — useful in noisy rooms
  or when no audio analysis is available for automatic endpointing.
- **Mute** pauses capture without leaving the conversation; unmuting
  starts a fresh turn.
- **Skip reply** stops playback and returns to listening.
- **Barge-in:** start talking while the reply plays and playback stops,
  returning to listening for your next turn.
- **Close** tears the session down: the microphone stream stops, any
  in-flight transcription aborts, and playback cancels.

Failures never end the conversation. A microphone error, a rejected
recording, a transcription failure, or a reply timeout surfaces inline
and voice mode returns to listening for the next turn.

## Governance and privacy

Voice mode is governed by its own access mode (`voice-mode`) in User
Management's Voice access card, separate from speech-to-text,
text-to-speech, and voice cloning; the `VOICE_MODE_ACCESS_MODE`
environment variable pins it. Transcription and speech synthesis run
under their own feature gates too, so restricting either disables that
part of the loop. Recordings follow the speech-to-text contract:
validated, bounded, and ephemeral — a turn's audio exists only long
enough to transcribe it, and only the transcript enters the chat as a
normal message.

## Boundaries

- Voice mode is turn-based, not full-duplex: it does not stream
  microphone audio and model speech simultaneously over one realtime
  connection.
- Automatic endpointing and barge-in need audio analysis; when the
  browser cannot provide it, the manual **Done speaking** control ends
  the turn.
- Turn-based replies run one at a time; words spoken during a barge-in
  are not carried into the next turn's transcript.
