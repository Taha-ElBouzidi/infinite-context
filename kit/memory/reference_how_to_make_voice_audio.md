---
name: How to make voice audio for narration or a spoken brief
description: Audio, voice note, narration, text to speech, read this to me, a spoken brief for the car or a walk: how to write for the ear, keep one voice, and check the whole file before sending it. Read before making any voice audio.
type: reference
metadata:
  type: reference
  asserted: 2026-11-02
  updated: 2026-11-02
  kit_version: 1
  kit_hash: 585a795b13b4138f
---

# How to make voice audio for narration or a spoken brief

A listener cannot scroll back, skim or see a table, so write for the ear first and choose the voice second.

The assistant cannot hear. It writes the script, drives a text-to-speech service the owner already has, and checks the file by measuring and transcribing it. With no service, deliver the script ready to read aloud and say that no audio was made.

## What good looks like

- A busy listener can follow and act with nothing in front of them.
- One voice and one delivery across the whole piece and across a series.

## Write and structure for the ear

Rewrite the text; a chat reply read aloud fails.

- Remove bullet markers, headings, tables, links, file paths, code and symbols, and say what they mean ("the link is in your messages").
- Short sentences, one idea each. At most three items in a list; no brackets, dash asides or chains of numbers and names, which slow the pace.
- Say numbers and dates the way people say them ("the third of November", "about a third"); "3/11" is ambiguous.
- Put doubt in the same sentence as the claim ("probably Thursday, not yet confirmed"): a listener cannot re-read a caveat.
- Open with what it is and how long it runs. State the decision first and again at the end, because attention while driving is partial. Use at most three signposted points ("first", "second", "last").
- Set the language explicitly. For names or terms from another language, choose a voice that handles mixed languages.

## Length

Voices read 120 to 190 words a minute, depending on speed setting and pauses, so measure the first render and correct the estimate. Keep a brief to a few minutes and a teaching narration to 2 to 4 minutes a part. Test the channel's limit before splitting: a ten minute file went out as one voice note. For a video, render one clip per scene: a single long call slowed down and added silence.

## Choose a voice and keep it

- Recall the owner's saved voice and language. If there are none, ask once: a man's or a woman's voice, and how it should come across (a calm teacher, an energetic coach). Play a sample, then save the choice and settings ([[reference_how_to_save_a_memory]]).
- Keep one service, one voice and one short, plain delivery direction for every scene. In one test, pace varied about 7 percent across scenes with a minimal direction and 26.5 percent with a style tag on every scene.
- Rewrite a dense scene for the ear rather than speeding the clip up, which sounds artificial. Pace follows the text, so regenerating returns the same pace (one rewrite raised a scene from 108 to 125 words a minute).
- Bring clips to one loudness (about -14 LUFS for phones, for example with FFmpeg's loudnorm filter): raw clips differed by up to 4.7 dB, normalised ones by 0.5 dB or less.
- Never clone or imitate a real person's voice without that person's explicit consent, and disclose any synthetic voice.

## Check the whole file

A service that reports success is not evidence of good audio.

1. Wait until the file stops growing: some tools write it progressively, and a half-written file plays fine but ends early. Compare its duration with words divided by pace.
2. Transcribe it and compare with the script: language, numbers, names, ending. One Spanish script was spoken in English because the voice instruction defaulted to English while every field said Spanish. Dialects need a native listener.
3. A person must listen to the whole file once: ask the owner, naming what to check (the first and last twenty seconds, every number and name, the joins between clips), and say which parts nobody heard ([[feedback_verify_before_claiming]]).

## Deliver

Send a voice note that plays inline, in the audio format the app expects, not a file to open. Read the sent message back where the channel allows, then say "sent", not "you have it", and ask the owner to confirm when it matters. Sending to another person cannot be undone, so show it first ([[feedback_reversible_act_irreversible_ask]]).

## Related
[[reference_how_to_make_a_video_presentation]] [[reference_how_to_save_a_memory]] [[reference_how_to_review_work_before_calling_it_done]]
