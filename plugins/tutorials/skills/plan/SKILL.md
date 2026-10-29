---
description: Propose the set of tutorial videos and SOPs for this app from tutorials/features.yaml, with steps and draft narration for each, and revise it until the user approves. Use after discover, or when the user wants to plan, add or change tutorials.
argument-hint: "[audience or focus, e.g. admins, onboarding]"
---

# Plan the tutorials

Turn `tutorials/features.yaml` into a proposal the user approves: which videos and SOPs to make, what each covers, and a draft of what the narrator says. Nothing is recorded in this step.

Before writing, read `${CLAUDE_PLUGIN_ROOT}/references/formats.md` (plan.yaml and tour.yaml) and `${CLAUDE_PLUGIN_ROOT}/references/narration-style.md`.

If `tutorials/features.yaml` doesn't exist, stop and tell the user to run `/tutorials:discover` first.

If the user passed arguments, use them to narrow the plan to an audience, an area or a single feature: $ARGUMENTS

If `tutorials/plan.yaml` already exists, you're revising it. Keep the ids of items that stay, so their folders and later recordings still match.

## 1. Design the set

- **One job per video.** "Invite a teammate", not "The settings page". Aim for 1 to 3 minutes and 4 to 10 steps.
- **Order the videos as a learning path:** getting started first, then everyday work, then advanced and admin tasks.
- **Cover every live `core` feature** in at least one item. Group `advanced` and `admin` features where they belong together.
- **Make an SOP** for procedures people repeat or must get exactly right, usually admin and operations tasks. An item can be both a video and an SOP (`kind: both`).
- **Leave out** `internal`, `unfinished` and `flagged` features unless the user asks for them.
- **Ground every step** in features.yaml and what the screenshots show. If a flow has `reach: interaction`, look at the code to get its steps right.
- **List the demo data each item needs,** such as "three projects with tasks" or "a second member to invite", so the recordings don't show an empty app.
- **Estimate duration_sec** from the narration (words ÷ 2.5) plus about a second per action.

## 2. Write the proposal

Write `tutorials/plan.yaml` with `status: proposed`, and `tutorials/plan.md` as the readable version:

1. A summary table: number, title, kind, audience, length
2. One section per item: goal, audience and role, prerequisites, demo data, the numbered steps, and the opening and closing lines

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs" plan`. Fix every error. A warning about an uncovered core feature means the plan has a gap: cover it, or tell the user why you left it out.

## 3. Ask for approval

In chat, give a short summary:

- How many videos and SOPs, and the total running time
- The list of titles with their lengths
- Any choices you want the user to make, such as merging two videos

Point to `tutorials/plan.md` for the details, and don't paste the whole plan. Then ask the user to approve it or say what to change.

For each round of feedback, update both files, rerun the check, and summarize what changed.

## 4. When the user approves

1. In plan.yaml, set `status: approved` and set `approved_at` to today's date.
2. For each item, create `tutorials/<id>/` containing:
   - `tour.yaml`: the steps from the plan, following formats.md. Leave `target` as the visible label; the storyboard turns labels into exact locators. Then, for each step:
     - `expect_text`: after any click that changes what's on screen, the exact words the page shows when it worked, such as a heading, a confirmation or the new item's name. Storyboard and record check them, which catches broken flows and wrong demo data. Keep `expect` as the description for people.
     - `cue`: when the narration doesn't say the target's label (`target: Website relaunch`, `say: Click a project's name to open it.`), the words where the action should land (`cue: a project's name`).
     - `do: show`: for a narration-only step that talks about a particular part of the screen ("the headline numbers"), so the video rings it while the line is spoken.
   - `script.md`, for `video` and `both` items: the full narration, one numbered line per step, following narration-style.md
   - `sop.md`, for `sop` and `both` items: purpose, scope, roles, prerequisites, the numbered procedure with UI labels in bold, the expected result, and troubleshooting. Add the step screenshots narration-style.md describes, numbered by the steps in tour.yaml
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs" tours` and fix every error. Fix the warnings too, unless one doesn't apply.
4. Tell the user how many tutorial folders you created. The next stage is `/tutorials:storyboard`, which replays each tour in the app and shows a screenshot of every step next to its narration for approval.
