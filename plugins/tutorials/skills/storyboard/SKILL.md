---
description: Replay each approved tutorial tour in the running app, find the real element behind every step, and build a storyboard of screenshots next to the narration for the user to approve. Use after the plan is approved, or when the user wants to check or fix a tutorial's steps before recording.
argument-hint: "[tutorial ids, default: all]"
---

# Storyboard the tours

Replay every tour against the running app, pin each step to a real element, and screenshot each step, so the user can approve exactly what each video will show before anything is recorded.

Before you start, read `${CLAUDE_PLUGIN_ROOT}/references/formats.md` (tour.yaml, locators and the storyboard files).

If the user passed arguments, they are the tutorial ids to storyboard: $ARGUMENTS. Otherwise storyboard every item in the plan.

If `tutorials/plan.yaml` isn't approved, or there are no `tutorials/<id>/tour.yaml` files, stop and tell the user to finish `/tutorials:plan` first.

## Helper scripts

Run them from the project root.

| Script | What it does |
| --- | --- |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --for storyboard` | Checks the browser, the app, the sessions and `app.reset`, and says how to fix what's missing |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs" tours [id ...]` | Validates each tour.yaml and checks that script.md matches it line for line |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/app.mjs" start\|reset\|status` | Starts the app if it isn't running, or puts its demo data back |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/storyboard.mjs" [id ...]` | Resets the data, replays each tour with the role's saved session, resolves every target, checks each step's `expect_text`, screenshots each step, writes `tutorials/<id>/storyboard.html` and saves the locators into tour.yaml |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/storyboard.mjs" --approve [id ...]` | Marks tours approved once the user has seen them, recording a fingerprint of each so later changes are noticed |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" --role <id>` | Logs in again when a session has expired |

## 1. Check the tours

Run `doctor.mjs --for storyboard` and fix what it reports. Then run `check.mjs tours` and fix every error. Fix a warning about script.md by making the two files match: each numbered line in script.md is spoken during the tour step with the same number. A warning that a click has `expect` but no `expect_text` means nothing checks that step: add the words the page should show.

## 2. Get the app ready

1. Run `app.mjs start`, which starts the app if it isn't answering.
2. **Make sure the demo data can be put back.** Tours change the app: a tour that creates a project creates another one every time it runs, and a tour that ticks a task finds it already ticked the second time. Each tour should start from the data in its item's `demo_data` in plan.yaml. storyboard.mjs runs `app.reset` before each tour. If config.yaml has none and the tours change data (doctor warns), find the command that puts the demo data back, such as a seed or reset script, and set it as `app.reset`. If you can't tell what it is, ask the user once.

## 3. Run the storyboard

Run `storyboard.mjs`. For each tour it opens a fresh browser with the role's saved session, goes to `start`, and for each step:

- finds the element: a saved `locator` first, then the `target` as an accessible name (getByRole), a field label (getByLabel), then visible text (getByText), exact matches before partial ones
- screenshots the screen before the action, with the element's position, then performs the action and screenshots the result (a `show` step only points the element out)
- checks that the step's `expect_text` is on the page afterwards
- notes anything else that happened: console or HTTP errors, dialogs, downloads, new tabs, partial matches, a saved locator that had to be repaired

It saves each locator into tour.yaml, so later runs replay the same elements.

If a tour says the session expired, run `login.mjs` for that role and run the storyboard again.

## 4. Fix steps that fail

A tour that fails stops at the broken step. The result gives the reason, a screenshot of the page at that moment (`storyboard/NN-failed.jpg`) and its accessibility snapshot (`storyboard/NN-failed.aria.yaml`), which has every role and label on the page.

1. Look at the screenshot and the snapshot to see what the page really shows at that point. The screenshot is what the video will show, so trust it over the code.
2. Fix the tour, preferring the first fix that applies:
   - **The label is different:** set `target` to the exact label from the snapshot. If the narration names it, change `say` to match.
   - **The label matches several elements:** the result lists each candidate with a locator that selects it. Add the right one to the step as `locator`, or write one with `within`, so it survives reordering. Keep `target` as the visible label.
   - **Another element covers the target:** the reason names it. It's usually a dialog, banner or overlay that needs closing first, so add that step. If it's invisible, the app has a bug: tell the user.
   - **The expected text isn't there:** compare the screenshot with the step's `expect_text`. If the page is right and the words differ, fix `expect_text`. If the page is wrong, the flow or the demo data is: check `app.reset`, and the steps before.
   - **The flow is wrong:** the element only appears after another action (a menu, a tab, a modal), or the page isn't where the plan expected. Add or change steps, with their `say` lines, and update script.md to match.
   - **The feature doesn't work:** stop and tell the user. The plan may need to change.
3. Reset the data if the partial run changed it, and run the storyboard again for that tour.

## 5. Review every storyboard

For each tour, look at its screenshots (listed in `tutorials/<id>/storyboard/steps.json`) and check:

- The element in each before shot (`box` in steps.json) is the one the narration names.
- Each `expect` is true in that step's after shot, and each `show` rings what its line talks about.
- Nothing the narrator says contradicts the screen: names, counts, empty states, a different page.
- No error messages, empty lists that the demo data should have filled, banners or pop-ups covering the action.
- Every note in the result has been dealt with. A download or a new tab can't be shown in a recording, so the narration shouldn't depend on seeing it.

Fix what's wrong in the tour, script.md or demo data, reset, and re-run the affected tours. If a fix changes what a video covers, update plan.yaml and plan.md too.

## 6. Ask for approval

In chat, give a short summary:

- For each tour: steps, estimated length, and whether it ran cleanly
- What you changed and why
- Anything the user needs to decide

Give the path of each `storyboard.html` and offer to open them (`open <path>` on macOS, `xdg-open` on Linux). Don't paste the storyboard into chat. Ask the user to approve or say what to change. For each round of feedback, update the tours, reset the data, re-run, and summarize what changed.

## 7. When the user approves

Run `storyboard.mjs --approve` with the approved tour ids. It refuses a tour whose last storyboard failed, or that changed after it; storyboard those again and show them to the user first. Don't set `approved_at` or `approved_hash` by hand.

Tell the user how many tours are approved. The next stage is `/tutorials:produce`, which narrates, records and renders each video.
