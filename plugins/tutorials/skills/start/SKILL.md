---
description: Start here, or pick up where you left off. Works out where this app's tutorials stand and takes the next step, from first setup to the finished bundle, pausing only for questions and the user's approvals. Use when the user wants tutorial videos or SOPs for their app, asks what to do next, or comes back after a break or after the app changed.
argument-hint: "[optional: what you'd like, e.g. 'only the admin tasks']"
---

# Start, or carry on

Take the user from wherever they are to finished tutorials, one stage at a time, and keep going until something needs them. They shouldn't have to know the stage names.

## 1. See where things stand

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs"` from the project root. It changes nothing. It prints:
- the state of each plan item: tour, storyboard, approval, video, SOP
- the look settings, plus `suggestions` for any that are missing
- whether the bundle is current
- `app_commits_since_storyboard`
- `next`: the stage to run, the tutorial ids it's for, why, and whether it's waiting for the user

Tell the user in a sentence or two where things stand, in plain words. For example: "The plan is approved and 3 of the 5 storyboards are approved; next I'll storyboard the other two."

On a fresh start (`next.stage` is discover and there's no config), explain the whole process in a few lines first:
1. Claude maps the app's features from the code and the running app.
2. It proposes a set of videos and SOPs; **you approve the plan**.
3. It replays each one in the app with a screenshot per step; **you approve the storyboards**.
4. It narrates, records and renders the videos, checks them, and gathers everything into one folder to share.

Mention what they'll be asked for early on: a test account for each role, and a way to reset the demo data.

## 2. Take the next step, and keep going

Run the stage in `next` by following its skill (`/tutorials:<stage>`), with the ids from `next.ids` and anything the user asked for in $ARGUMENTS. When the stage finishes, run status.mjs again and go straight on to the next stage. Don't wait to be asked, and don't make the user type commands. Stop only when:
- **A stage needs the user:** a question only they can answer, or the plan or storyboards waiting for approval (`next.waiting_for_user`). Say exactly what's waiting and where to look (`tutorials/plan.md`, or the `storyboard.html` files, offering to open them), then wait. When they answer, carry on from there.
- **`next.stage` is null:** everything is done.
- **Something fails that you can't fix.** Say what you tried.

Never approve a plan or a storyboard on the user's behalf.

Before a long step, say what's about to happen and roughly how long it takes:
- The first narration installs the voice engine: about 4.5 GB on Apple Silicon Macs (1.2 GB elsewhere), a few minutes, once.
- Recording takes about as long as each video.
- Rendering takes a minute or two per video.

## 3. The look, once

When produce is next, or when everything is done, offer the `suggestions` from status, all in one message and only once. Each settles with one answer:
- **Brand colors:** `look.mjs` reads them from the app. Set them, then tell the user what you chose.
- **The address in the videos:** `app.display_url`, so they don't show localhost.
- **The narrator:** `voice.mjs --samples` writes a page that plays a few voices.
- **Music:** `music.mjs search` writes a page that plays a few free tracks, or `music: none` to keep it quiet.

Changing any of these after videos exist means rendering them again, which produce does by itself. Say so.

## 4. After the app changes

If everything is done but `app_commits_since_storyboard` is above 0, offer to check the tutorials against the app: run the storyboards again.
- **A tour that still runs** keeps its approval.
- **A tour that fails** shows what changed in the app. Fix the tour, show the user the new storyboard, and have it approved again.
- **Produce** then makes only the videos whose tours changed, and bundle rebuilds the folder.

## 5. When everything is done

Say what exists: how many videos and SOPs, and where the bundle is (`open tutorials/dist/index.html`). Say `/tutorials:start` picks up from here any time, for example after the app changes. Keep it to a few lines.
