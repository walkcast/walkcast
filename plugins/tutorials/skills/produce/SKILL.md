---
description: Turn the approved tours into finished tutorial videos. Narrates each line with a local voice, records the app as the narrator performs each step, and renders the video with a pointer, zooms, highlights and captions, then reviews it. Use after the storyboards are approved, or to remake videos after a tour changes.
argument-hint: "[tutorial ids, default: every video in the plan]"
---

# Produce the videos

Make the finished MP4 for each video in the plan, and check it. Everything runs on this machine: Ming-3.0 (on Apple Silicon Macs) or Kokoro reads the narration, Playwright records the app, and HyperFrames renders the video, with ffmpeg for encoding and sound.

Before you start, read `${CLAUDE_PLUGIN_ROOT}/references/formats.md` (the `voice`, `brand`, `video`, `music`, `app.reset` and `app.display_url` settings, and the produce output).

If the user passed arguments, they are the tutorial ids to produce: $ARGUMENTS. Otherwise produce every item in plan.yaml whose `kind` is `video` or `both`. SOP-only items have no video.

## Helper scripts

Run them from the project root. Each takes tutorial ids, or does every video in the plan.

| Script | What it does |
| --- | --- |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --for produce` | Checks Node 22, ffmpeg, uv, the browser, HyperFrames, the app, the sessions and `app.reset`, and says how to fix what's missing |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/app.mjs" start\|reset\|status` | Starts the app if it isn't running, or puts its demo data back |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/voice.mjs"` | Reads each `say` line aloud, one clip per line, with the time of every word. Clips are cached, so only new or changed lines are made. `--samples` reads one line in several voices instead, on a page to compare them |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/music.mjs" search\|pick` | Finds free background music in Kevin MacLeod's catalog (CC BY 4.0) and writes a page to listen to it; `pick "<title>"` downloads one and sets it, with its credit |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/look.mjs"` | Reads the brand color and public address from the running app |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/record.mjs"` | Resets the data, then replays each approved tour paced by its narration, with the pointer acting as the narrator names each target, and captures the screen at twice its size. Checks each step's `expect_text`, and compares the page's text with the approved storyboard |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/render.mjs"` | Composes, renders and reviews each video. Skips videos whose inputs haven't changed; `--force` renders them anyway, `--draft` renders faster, `--html-only` stops before rendering |

## 1. Check what's ready

1. Run `doctor.mjs --for produce` and fix what it reports. If ffmpeg or uv is missing, tell the user how to install it (`brew install ffmpeg uv` on macOS) and stop.
2. Run `app.mjs start` so the app is up.
3. Each tour to produce must be approved as it stands. `check.mjs tours` warns about any that changed since approval, and record.mjs refuses them. Send those back through `/tutorials:storyboard`.
4. If config.yaml has no `app.reset` and the tours change data, doctor warns. Ask the user for a command that puts the demo data back, and add it, before recording: without it, each recording starts from whatever the last one left.

## 1b. Choose the voice and music, once

Skip this if config.yaml already has `voice.voice` and `music` (a track, or `none`). Otherwise, prepare both choices before asking, and ask about them in one message:

1. Run `voice.mjs --samples`. The first time, this installs the voice engine (see below). Offer to open `tutorials/.cache/voice/samples.html`. It plays one line in the plugin's narrator and Ming's built-in voices, plus two Kokoro voices; on machines without Apple Silicon, six Kokoro voices. If the user wants a voice that isn't there, describe it: `voice.mjs --samples --describe "a calm, friendly man in his forties, unhurried"` makes three takes of a new narrator, and `voice.mjs --keep <take>` keeps one for this project. They can also use a recording of a real voice, with that person's permission: set `voice.reference` and `voice.reference_text` (see formats.md).
2. Run `music.mjs search`. Offer to open `tutorials/.cache/music/choices.html`. If the app has a clear mood, pass `--feel` (Bright, Relaxed, Calming, Uplifting, Grooving, Bouncy) or `--q` with an instrument such as piano. The tracks are free under CC BY 4.0, which needs a credit; pick adds it to each video's closing card and to the bundle.
3. When the user answers, set `voice.engine` and `voice.voice` in config.yaml (or run `--keep`), and run `music.mjs pick "<title>"` or set `music: none`.

If `brand.color` isn't set either, run look.mjs and set `brand` from `suggest.brand`, and tell the user which color you used.

## 2. Narrate

Run `voice.mjs`. The first run sets up the voice engine in the plugin's data folder and downloads it and its models, about 4.5 GB for Ming or 1.2 GB for Kokoro, so tell the user it takes a few minutes once. Ming takes about as long as the narration lasts; Kokoro is quicker.

The result lists any steps without word timings. That happens with Kokoro's non-English voices; for those steps the action lands at its `cue` or halfway through the line, instead of on the spoken label. Ming's clips are timed by an aligner in every language it speaks.

## 3. Record

Run `record.mjs`. A tour takes about as long to record as its video.

- **A step fails** when its target is gone or its `expect_text` isn't on the page. The app no longer matches the storyboard: run `/tutorials:storyboard` for that tour, fix it, have it approved again, and record again.
- **`differences`** lists steps where the page's text didn't match the approved storyboard. It usually means the demo data differed: check `app.reset`, reset, and record again. Text that changes by itself, such as dates or "2 minutes ago", differs every time and can be ignored.

## 4. Render

Run `render.mjs`. For each tour it writes `tutorials/<id>/produce/`:

- `video.mp4`: 1920×1080, 30 fps, with the sound levelled to −16 LUFS
- `captions.vtt`: the captions, for video players and video sites
- `review.html`: the video, a frame just after every action, when each line's speech starts, and any problems
- `video.json`: when each step happens in the video

The look comes from config.yaml: `brand` for the colours, `video` for the zoom and the burned-in captions, `music` for a track mixed in under the voice, and `app.display_url` for what the address bar shows instead of localhost. Suggest `display_url` if the videos would otherwise show `localhost`.

## 5. Review every video

Read each video's `problems` in the render result, then look at its frames in `tutorials/<id>/produce/review/` (one per step, named by step number). Check that:

- the pointer is on the target when it clicks, and the ring is around the element the narration names
- a zoom frames the target and doesn't cut off what the narration talks about
- the page shows what the narration says, with no error messages
- the captions match the narration
- the title card and the closing card show the right titles

The review flags two problems on its own. **Speech in the wrong place** means a line starts more than 0.8 seconds from its step, or runs into the line before; look at the narration for that step. **A page that differed from the storyboard** usually means demo data that wasn't reset.

Fix the cause, not the frame: a wrong word in the tour or script, missing demo data, a timing problem in a tour. Then run the stages again from the first one the fix affects. Voice clips are cached, and render skips videos that haven't changed, so re-running is cheap.

## 6. Report back

Keep it short:

- Each video's path and length, and whether its review found problems
- What you fixed along the way, and anything the user should look at themselves
- How to watch them: `open tutorials/<id>/produce/review.html` shows each video with its frames
- The next stage is `/tutorials:bundle`, which gathers the videos and SOPs into one folder with an index page
