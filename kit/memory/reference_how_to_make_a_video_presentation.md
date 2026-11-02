---
name: How to make a video presentation, explainer or promo clip
description: Video, animated presentation, explainer video, promo clip, teaching video, screen demo: how to plan, script, build and check one by watching it as the viewer. Read before making any video.
type: reference
metadata:
  type: reference
  asserted: 2026-11-02
  updated: 2026-11-02
  kit_version: 1
  kit_hash: e4f504dab7db8b4b
---

# How to make a video presentation, explainer or promo clip

A video holds a viewer only while every second serves one message. A deck that prints to PDF is a different job: [[reference_how_to_make_a_presentation_deck]].

The assistant cannot record, edit or hear. It writes the script, builds animated scenes as code, drives a renderer, screen recorder or text-to-speech service the owner already has, and inspects frames. With none of these, deliver the script and a timed shot list, and say that no video was made.

## What good looks like

- One message for one viewer, in one sentence first: who watches, where, and what they should know or do afterwards.
- A hook in the first two or three seconds: a pain, a surprising claim or the result, shown rather than written, never a logo.
- One idea per scene and one main thing on screen. Key words on screen, full sentences only in the captions.
- A visible change every 2 to 4 seconds while the voice speaks, never about 8 seconds with none (working estimates). Move in short bursts, then hold still so the text can be read. Motion points at what is said; decorative motion lowers learning.
- A teaching part runs 2 to 4 minutes. A promo runs 30 to 60 seconds, shows one task from broken to fixed, and ends on one call to action.

## Steps, in order

1. **Brief.** Recall the owner's saved style, voice and language; if there are none, ask once and save them ([[reference_how_to_save_a_memory]]).
2. **Script before visuals.** Spoken lines written for the ear, then one row per scene: seconds, line, on screen, motion. Facts, numbers and names come from the source, never from an image generator, which garbles text. Show the script first: an edit takes minutes, a re-render hours.
3. **Voice next** ([[reference_how_to_make_voice_audio]]), with word timings from the service or from transcribing it, so timing and captions follow the real audio.
4. **Build.** A presentation given live stays an HTML page: each slide replays its entrance animations when shown (pop with slight overshoot, rise, fade, staggered 0.2 to 0.3 seconds), and a still mode shows the final state for screenshots. An editable slide-file copy (.pptx) keeps only simple entrance fades. A video file needs no paid service: paused animations driven by one time function, a headless browser capturing a frame per step, and FFmpeg to encode. For screen demos, capture at twice the display scale, crop whole interface blocks, and cut between crops instead of panning.
5. **Sound and captions.** Music 12 to 20 dB under the voice, or none, composed or licensed with the licence kept. One loudness target for every clip (about -14 LUFS suits phones). Captions in the video's own language, each line held about a second plus 0.3 second per word.
6. **Watch it as the viewer**, then deliver a playable file or a link, never the HTML source. Chat apps recompress video, so test one real send.

## Checks before calling it done

| Check | How |
|---|---|
| Hook, scenes, ending | Contact sheet of frames at a steady interval (a live deck: screenshot every slide); first and last frames at full size |
| Text inside the margin | Measure text boxes on sampled frames (about 60 px each side of 1080), never by eye |
| Voice, length, loudness | Transcribe and compare with the script; measure length and loudness |

If a check cannot run, say so and ask the owner to watch the first ten seconds and the ending. A file that plays is not evidence that the video is good ([[feedback_verify_before_claiming]]).

## Mistakes that cost the most

- Still screenshots on slow zooms, placeholder pages, a permanent "sample data" line: use real content and one small label.
- A synthetic voice reading generic claims: use a real person's voice or face for any "we made this" message, and disclose synthetic voices.

## The learning loop

Ask what held attention and where they would have stopped. Study one strong video of the same kind: hook, shot length, sound, ending. If a video-capable review model is available, ask it for a pairwise comparison against that video with timestamped weaknesses, never a stand-alone score: one such model rated a clip 8 to 10 out of 10 that its owner called bad. Change one or two things per version, log each result, and save what worked as one memory each, at once ([[feedback_write_it_the_moment_you_learn_it]]).

## Related
[[reference_how_to_make_voice_audio]] [[reference_how_to_make_a_presentation_deck]] [[reference_how_to_review_work_before_calling_it_done]] [[reference_how_to_save_a_memory]]
