---
description: Gather the finished tutorial videos and SOPs into one folder to publish or share, with captions, chapters, thumbnails, SOP PDFs with screenshots, and an index page that plays every video beside its steps. Use after the videos are produced, or when the user wants to share, publish or hand off the tutorials.
argument-hint: "[tutorial ids, default: everything in the plan]"
---

# Bundle the tutorials

Put everything the plan produced into `tutorials/dist/`, ready to upload to a help center or video site, host as a static page, or send to someone.

Before you start, read the "Bundle output" section and the SOP screenshot syntax in `${CLAUDE_PLUGIN_ROOT}/references/formats.md`.

If the user passed arguments, they are the tutorial ids to bundle: $ARGUMENTS. Otherwise bundle every item in plan.yaml.

## Helper script

`node "${CLAUDE_PLUGIN_ROOT}/scripts/bundle.mjs" [ids] [--out <folder>]`, run from the project root. It writes, for each item:

- the video as `<id>.mp4` with its title and chapters inside, its captions as `<id>.vtt`, and its chapters as `<id>.chapters.vtt`, one per step
- a thumbnail, `<id>.jpg`: the tour's last screen in a browser window on the brand background
- the SOP as `<id>.md` and `<id>.pdf`, with the screenshots sop.md asks for in `images/`

plus `index.html`, a page listing everything in plan order, and `tutorials.json`, the same as data. It takes a few seconds and needs no app running.

`--out` writes somewhere else, such as the user's docs site. It refuses a folder that has files it didn't make.

## 1. Check that SOPs have screenshots

Read each `sop.md` (for `sop` and `both` items). If it has no `![...](step:N)` images, add them before bundling:

1. Open the item's `storyboard/steps.json` to match each procedure step to its tour step. The numbers differ: tour steps include narration-only lines.
2. Under each procedure step where the reader has to find something on screen, add `![What it shows](step:N)` indented to sit inside the list item, with a blank line before and after. Skip steps the text makes obvious, such as a sidebar link right after the last screenshot showed it.
3. Under "Expected result", add `![What it shows](step:N:after)` for the step whose result it describes.

The alt text says what the screenshot shows, such as "The members table". Tell the user you added them, since sop.md is a source file.

## 2. Bundle

Run bundle.mjs.

- **not_included** lists what was left out and why. A video is left out when it hasn't been produced, or when it no longer matches its approved tour, its recording or the video settings. Offer to run `/tutorials:produce` for those ids, and bundle again afterwards. An SOP with screenshots is left out when its storyboard doesn't show the approved tour; run `/tutorials:storyboard` for it.
- **problems** lists videos whose review found something. Read them; if a video was published with a known problem, say so.

## 3. Look at the result

- Read two or three thumbnails (`tutorials/dist/<id>/<id>.jpg`) to check they show the end of the task, not an error or an empty page.
- Read each SOP PDF. Check each screenshot rings the element its step names, and that no page breaks badly. If one rings the wrong element, the step number in sop.md is off: fix it and bundle again.

## 4. Report back

Keep it short:

- What's in the bundle: how many videos and SOPs, and anything left out
- `open tutorials/dist/index.html` to see it. It works straight from disk, and the whole folder can go on any static web host as it is.
- For a video site, upload each `<id>.mp4` with its `<id>.vtt` as captions. Chapter times are in `tutorials.json` for the description.
- If they ask for Word documents, convert the Markdown with pandoc: `pandoc tutorials/dist/<id>/<id>.md --resource-path tutorials/dist/<id> -o tutorials/dist/<id>/<id>.docx`. If pandoc is missing, tell them how to install it (`brew install pandoc` on macOS).

`tutorials/dist/` is rebuilt on every run and should be gitignored; add `dist/` to `tutorials/.gitignore` if it isn't there.
