# walkcast: notes for working on this repo

This repo is a Claude Code plugin (plus its marketplace) that turns an app into narrated tutorial videos and SOPs. The user talks to Claude in their app's repo, and Claude:

1. reads the code and explores the running UI to map every feature
2. proposes the videos and SOPs, with a script for each
3. revises them until the user approves
4. records, narrates, renders and bundles them

It's a free, personal open-source project. It uses Claude only. Don't add multi-model abstractions, compliance features or safety rails nobody asked for.

## Layout

```
.claude-plugin/marketplace.json   marketplace "walkcast", lists the plugin (install: /plugin install tutorials@walkcast)
plugins/tutorials/                the plugin (manifest name "tutorials")
  .claude-plugin/plugin.json
  skills/<stage>/SKILL.md         each stage is a skill, run as /tutorials:<stage>
  references/formats.md           file formats for everything under tutorials/ (keep in sync with check.mjs)
  references/narration-style.md   how scripts and SOPs are written
  scripts/*.mjs                   Node ESM helpers the skills run; print JSON, exit 1 on failure
  scripts/lib/common.mjs          config loading, .env, browser launch, route patterns, app.reset, locks
  scripts/lib/locate.mjs          finds a step's element from its saved locator or target label
  scripts/lib/tour.mjs            the step actions, the tour fingerprint, expected-text and visible-text helpers
  scripts/lib/produce.mjs         the recording and render fingerprints, and whether a finished video is still current
  scripts/voice/ming_tts.py       the Ming-3.0 voice engine (MLX, Apple Silicon), with Qwen3-ForcedAligner for word timings
  scripts/voice/kokoro_tts.py     the Kokoro voice engine, for other machines; each runs in its own Python environment
  assets/voice/narrator.wav       the default narrator's reference clip, with its words in narrator.txt
  package.json, package-lock.json pinned deps (playwright 1.63.0, yaml, marked, hyperframes 0.8.216, gsap 3.14.2, and an override lifting hyperframes' undici to 7.30.1 for its security fixes); Claude Code installs them automatically on marketplace install
examples/sample-app/              server-rendered test app with a login, plus example tutorials/ output
examples/spa-app/                 single-page test app (no login, modal, custom menu, toasts, long list), with two tours
tests/e2e.test.mjs                end-to-end test of the scripts on both apps
```

Plugin rules from the Claude Code docs:
- Skills live at `skills/<name>/SKILL.md`, invoked as `/tutorials:<name>`. Write new stages as skills, not `commands/`.
- `${CLAUDE_PLUGIN_ROOT}` is substituted in skill text. `${CLAUDE_PLUGIN_DATA}` is a persistent folder that survives updates.
- Keep each SKILL.md under about 500 lines, and put detail in `references/`.
- No CLAUDE.md inside the plugin folder, because it isn't loaded there and the validator warns.
- plugin.json has no `version` on purpose, so installs follow each commit. `claude plugin validate` warns about this; add a version once you start cutting releases.

## Status

Done: **start** (status), **discover** (doctor, detect, app, login, crawl, probe, look, check features), **plan** (check plan), **storyboard** (storyboard, check tours), **produce** (voice, music, record, render) and **bundle**. The checks once planned as a separate stage are part of produce.

`node --test tests/e2e.test.mjs` covers login, crawl, probe, the checks, storyboard, approval, a tour changed after approval, missing expected text, a missing app.reset and bundling the SOPs, on both sample apps, in about a minute. `E2E_FULL=1` adds a narrated, recorded, rendered and bundled video per app, with no differences from its storyboard and no review problems. Run it after changing any script.

`/tutorials:discover` and `/tutorials:plan` have been run end to end in a live session on the sample app. `/tutorials:start`, `/tutorials:storyboard`, `/tutorials:produce` and `/tutorials:bundle` were added during that session, so their scripts were run directly but the skills haven't been invoked as slash commands yet. Do that next.

How the pipeline keeps itself honest (details in formats.md):
- **Demo data.** `app.reset` (a shell command) runs before each tour in probe, storyboard and record, so every run starts from the same data. discover sets it up. Both sample apps have a test-only `POST /__reset`.
- **Does it work?** probe.mjs submits each form with a marker and reloads to see whether it was saved, and clicks each button to see what happens. That's how discover tells a finished feature from one that only looks finished; on the sample app it flags Share and Change plan, and on the helpdesk the feedback form that saves nothing.
- **Expected text.** A step's `expect_text` must be on the page afterwards, in storyboard and in record.
- **Approval.** `storyboard.mjs --approve` stores `approved_hash`, a fingerprint of the steps. record.mjs refuses a tour that changed since, and check.mjs warns.
- **Same as approved.** storyboard saves the page's visible text at each step; record compares and reports `differences`, which caught leftover data from an earlier tour in the first produce run.
- **Review.** render.mjs writes review.html: a frame after every action, and where each line's speech starts compared with its step, measured with silencedetect before music is mixed in.
- **Runs don't collide.** Each tour's storyboard, recording and render take a lock and build in a temp folder, then swap in. A stuck recorder once deleted another run's frames.
- **Up to date.** record.mjs fingerprints the tour and narration it recorded, and render.mjs the recording, narration, settings and its own version (`RENDER_VERSION`), so it skips unchanged videos and refuses stale recordings. bundle.mjs leaves out any video that no longer matches. All three use `lib/produce.mjs`. That's the base refresh needs.

How storyboard works:
- A locator is a small map, `{ role: link, name: Projects }`, with `label`, `text` or `css` instead of a role, plus optional `exact`, `nth` and `within`. It's saved into tour.yaml and tried first on later runs; if it stops matching, the step is re-resolved from `target` and the result notes the repair. That's the repair path refresh will use.
- Each step gets a before screenshot with the target's box, and an after screenshot. The HTML shows the after shot only for steps with an `expect` and for the last step, since the next step's before shot already shows the result.
- A failed click says which element covers the target, from Playwright's log, instead of just "timeout".

How produce works:
- **Voice: two engines, in the `ENGINES` table in voice.mjs.** Each lives in a uv-managed Python 3.12 venv under `${CLAUDE_PLUGIN_DATA}` (falling back to `~/.cache/app-tutorials`), with models in `huggingface/` there, and resolves its packages with `uv pip install --exclude-newer <snapshot>`. Clips are trimmed to 50 ms of silence at each end, and cached in `tutorials/.cache/voice/` by a hash of engine version, voice, speed, language and text. A new engine is a Python script that prints the same JSON lines (word timings, or `[]`).
  - **Ming-3.0 0.5B (MIT), the default on Apple Silicon.** It runs through mlx-audio 0.6.1, the first release with Ming-3.0 support, at about real time on an M5 Pro, with Qwen3-ForcedAligner (Apache-2.0) timing the words. The models and venv are about 4.5 GB. It has built-in voices (US_Emma, US_James, US_Stella, UK_George, UK_Charlotte) and copies a reference clip.
  - **The default `narrator`.** It's a reference clip in `assets/voice/`, made by Ming from a description ("a warm, friendly woman in her thirties… relaxed, upbeat and conversational"). A voice made from a description drifts from line to line, so the plugin keeps one recording and copies it. `--describe` and `--keep` do the same for a project's own narrator.
  - **Kokoro (Apache-2.0, 82M), the default everywhere else.** The `kokoro` package (0.9.4, PyTorch), not `kokoro-onnx`, because only it returns word timestamps: about 1.2 GB. transformers needs a `>=4.45,<5` floor, or the resolver falls back to 4.12, whose tokenizers won't build. Its cache key is unchanged from before Ming, so existing clips stay valid. The helpdesk example pins it, so the tests cover both engines.
- **Record.** Headless Chromium's screencast only delivers 1x frames, even with deviceScaleFactor 2 (checked in 1.63), so record.mjs loops `page.screenshot` instead: about 20 fps at 2x, keeping a frame only when it changed. Raw CDP `Page.captureScreenshot` from a second session hangs for seconds across navigations, and so can a page.screenshot in flight when a navigation commits, so captures time out after 300 ms and the next one goes ahead. Frames are encoded with ffmpeg's concat demuxer (H.264 4:4:4, CRF 12). Each step lasts its clip plus 0.45 s. The action lands at the end of its `cue`, else the end of the spoken label, else the end of the phrase after an action verb ("tick its box"), else a distinctive label word, else halfway through. The real mouse follows the same eased path the renderer draws, so hover styles line up. Real-time capture held up on the single-page app (async loading, a modal, a menu, a scroll), so deterministic virtual-time capture isn't needed yet.
- **Render.** render.mjs writes one HyperFrames composition per video (index.html with GSAP, the recording and the clips) and renders it with the pinned CLI, with telemetry off (`HYPERFRAMES_NO_TELEMETRY=1`). Nearby actions on one page share a zoom, capped at `video.max_zoom` (1.6). A single click on a readable-size target (30 px or taller) that leaves the page gets no zoom, which avoids bouncing in and out on every navigation. Rings go at once when the page changes or the element vanishes, such as a menu item. `show` steps ring an element for the rest of their line. The music ducking and loudness levelling run in an ffmpeg pass afterwards (`sidechaincompress`, `loudnorm`), because HyperFrames' volume automation isn't documented in its CLI. The closing card's "Up next" only points to other videos.
- Only `video` and `both` items are produced. SOP-only items stop at the storyboard.

The sample app's forms save in memory: create project, add or tick a task, invite. Share, Search projects, the Reports date range and Change plan are unfinished on purpose, so discover has something to flag. The helpdesk's feedback form is unfinished the same way.

How start works: status.mjs reads tutorials/ (it changes nothing) and names the next stage, its ids, why, and whether it's waiting for the user. The skill runs that stage's skill, then status again, and keeps going until the user is needed. It never approves for them. It also counts the app's commits since the storyboards ran, to offer a check after the app changes.

How the look is chosen:
- **Brand and address.** look.mjs measures the running app: the most-used saturated color on buttons (then links), darkened until white text on it reads, and a dark sidebar or header for behind the video window. It reads `public_url` from canonical or og:url. discover checks these against the code's theme and deploy config, sets them, and tells the user.
- **Voice.** `voice.mjs --samples` reads the plan's first line in the narrator, Ming's five built-in voices and two Kokoro voices into `.cache/voice/samples.html`, mixing engines on one page. Both engine scripts take a voice per line for this. Kokoro's Spanish, French, Italian, Portuguese and Hindi voices work but have no word timings, and Japanese and Mandarin need packages it doesn't install. Ming speaks German, Spanish, French, Korean, Japanese and Chinese, set by `voice.lang`, and the aligner times all of them.
- **Music.** music.mjs uses incompetech's own catalog JSON (incompetech.com/llms.txt invites agents to). Kevin MacLeod's ~1,400 tracks are CC BY 4.0. Search keeps calm or bright tracks without vocals, ranks busy or fast ones down, and writes a listening page. pick downloads the track into `tutorials/assets/music/` and writes `music: { file, credit, isrc }` with incompetech's exact credit. render shows the credit on the closing card, and bundle on the index page.
- **Sources ruled out.** Pixabay's API has no music. Openverse's audio search timed out on music queries, and its CC0 results were mostly sound effects. Jamendo needs a key, and its terms require a paid license for commercial use.

How bundle works:
- One `tutorials/dist/<id>/` per item, files named by id so they stay recognizable once downloaded, plus `index.html` and `tutorials.json`. It rebuilds the whole folder each run in a temp folder and swaps it in, and `--out` refuses a folder it didn't make.
- The MP4 is remuxed (no re-encode) with its title and a chapter per step, named by the narration. Captions go inside only when they aren't burned in, because MP4 players turn on the first caption track by default and they'd show twice.
- Thumbnails come from the storyboard's last screen, framed like the video (window, address bar with `display_url`, brand background), because every frame of the video has a caption on it.
- SOP screenshots: `![alt](step:N)` in sop.md is the storyboard's before shot of tour step N, ringed in the brand color, the rest dimmed, and cropped to about two thirds of the screen around the target (snapped to an edge when close) so its text is readable in a PDF. `step:N:after` is the uncropped after shot. Markdown is converted with `marked` (`breaks: true`, so the Purpose/Scope lines stay on their own lines), and Playwright prints the PDF (A4, or `bundle.paper: letter`).
- index.html is one self-contained file. Captions are attached from a Blob built from the page's own data, because Chrome won't load a `<track>` file from `file://`.

## Next stage (design decided)

**refresh**: re-run the tours, repair broken steps by re-resolving them from the accessibility tree, re-render only what changed (the input fingerprints already make render skip unchanged videos), and summarize what changed.

Decided against: a separate check stage (its checks are in produce). There's no default music track; set `music` in config.yaml.

## Voice tests

**October 2026, M5 Pro.** The user found Kokoro a little robotic. Three tutorial lines were read in eight voices, and the user picked blind from a page with names hidden.
- **The picks:** Ming-3.0 described in words, Ming copying a designed narrator, Ming's US_James, and Kokoro af_heart. The first and last were the favourites. Kokoro holding its own blind suggests some of the robotic feel was pacing.
- **Not picked:** Qwen3-TTS 1.7B (Apache-2.0), with its preset Aiden or a designed voice, and Chatterbox Turbo (MIT) copying a reference.
- **Accuracy:** every clip was read word for word, checked with Qwen3-ASR.
- **Timing:** Qwen3-ForcedAligner timed every word, within 26 ms (median) and 89 ms (worst) of Kokoro's own timings.
- **Speed:** seconds to generate one second of speech: Chatterbox 0.28, Qwen3-TTS 0.4, Ming 0.9.
- **Licences ruled out:** Fish Drama 3 (35B; free only under $500k revenue), and Breeze TTS 2, Voxtral TTS and Higgs v3 (non-commercial).

**From planning, on a 2-core CPU with no GPU.** Kokoro generated at 1.6× real time, Pocket TTS (MIT) at 1.5×, Chatterbox Turbo at 0.17× and Qwen3-TTS 0.6B at 0.11×. All read the line with no word errors.

## Dev loop

Node 22+, plus `brew install ffmpeg uv` for produce.

```bash
node --test tests/e2e.test.mjs              # about a minute; run after changing any script
E2E_FULL=1 node --test tests/e2e.test.mjs   # also produces a video per app, a few minutes
```

```bash
npm install --prefix plugins/tutorials
(cd plugins/tutorials && npx playwright install chromium)
node examples/sample-app/server.mjs                          # terminal 1
cd examples/sample-app && claude --plugin-dir ../../plugins/tutorials   # terminal 2
claude plugin validate ./plugins/tutorials && claude plugin validate .  # before committing
```

Credentials for the sample app are in `examples/sample-app/tutorials/.env`, which is gitignored:

```
ACME_EMAIL=demo@example.com
ACME_PASSWORD=demo1234
```
