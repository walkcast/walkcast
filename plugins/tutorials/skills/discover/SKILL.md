---
description: Map every user-facing feature of this app by reading its code and exploring the running UI, then write tutorials/features.yaml. Use when the user wants to find out what the app does, or as the first step before planning tutorial videos and SOPs.
argument-hint: "[app url or area to focus on]"
---

# Discover the app's features

Build a complete, accurate inventory of what users can do in this app. Read the code, explore the running UI with the helper scripts, and merge both into `tutorials/features.yaml`, which `/tutorials:plan` builds on.

Before writing anything under `tutorials/`, read `${CLAUDE_PLUGIN_ROOT}/references/formats.md`.

If the user passed arguments, they are either the app's URL or an area to focus on: $ARGUMENTS

## Helper scripts

Run them from the project root with Node 22 or later. Each prints a JSON result; `"ok": false` comes with an `error` that says what to fix.

| Script | What it does |
| --- | --- |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --for discover` | Checks Node, the plugin's packages, the browser and the app, and says how to fix what's missing |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/detect.mjs"` | Guesses the framework, start command and local URL |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/app.mjs" start\|stop\|reset\|status` | Starts the app with `app.start` and waits for it, stops what it started, or runs `app.reset` |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" --role <id>` | Logs in and saves the session to `tutorials/.auth/<id>.json`. Add `--manual` to open a browser window the user logs in through |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/crawl.mjs" --role <id>` | Visits pages by following links and saves `tutorials/discovery/<id>/pages.json`, a screenshot and an accessibility snapshot per page |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/probe.mjs" --role <id>` | Submits each crawled page's forms and clicks its buttons, resetting the data around each try, and saves what really happened to `tutorials/discovery/<id>/probe.json` |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/look.mjs"` | Measures the app's brand color from its buttons and links, a dark color for behind the video's browser window, its language, its public address and its icons, and saves `tutorials/discovery/look.json` |
| `node "${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs" features` | Validates features.yaml |

Start with `doctor.mjs --for discover`, and fix whatever it reports before going on.

## 1. Set up tutorials/config.yaml

If the file exists, read it and go to step 2. Otherwise:

1. Run detect.mjs. Confirm what it found against the README, package scripts or compose files, because its port guess can be wrong.
2. Find the roles in the code, such as admin and member, and the login page.
3. Find how to put the app's demo data back: a seed script, a database reset, fixtures, or for an app that keeps data in memory, a restart or a test-only reset endpoint. Every later stage replays tours that change data, and each run has to start from the same data. Set it as `app.reset`.
4. Write `tutorials/config.yaml`, and a `tutorials/.gitignore` containing `.auth/`, `.env`, `discovery/`, `.cache/`, `*/storyboard/`, `*/storyboard.html`, `*/produce/` and `dist/`.
5. Credentials go in `tutorials/.env` as `ADMIN_EMAIL=...` lines, referenced from config as `${ADMIN_EMAIL}`. Ask the user for a test account for each role. Ask whether login uses single sign-on or one-time codes; if it does, set `manual: true` for that role.

Ask only what the code can't tell you, and ask it all at once: the test accounts, how sign-in works if the code doesn't show it, and how to reset the demo data if you couldn't find a way.

## 2. Make sure the app is running

Run `app.mjs start`. It leaves an app that already answers alone; otherwise it runs `app.start` in the background and waits until `app.url` answers. If the app won't start, the result has the last lines of its output: show them to the user and ask. Leave it running for the rest of the session, then run `app.mjs reset` to check that `app.reset` works.

## 3. Log in once per role

Run login.mjs for each role that has a `login` block. If it fails, try once more with the field labels from the login page set in config (`username_field`, `password_field`, `submit`). If it still fails, or the role uses single sign-on or one-time codes, run it with `--manual`. Tell the user a browser window has opened for them to log in; the script saves the session once they're in.

## 4. Read the code

Write `tutorials/discovery/code-map.md`. It should cover:

- Routes and pages, and the navigation between them: sidebar, menus, tabs
- The objects users work with, and every action on each: create, edit, delete, duplicate, share, import, export, invite, search, filter, sort
- Roles and permission checks: who can see and do what
- Feature flags, plan or paywall gates, and code that looks unfinished or internal
- Settings, integrations, and things users receive, such as emails, notifications and exports
- The exact UI text of buttons, menu items, field labels and headings, from components or translation files

For a large codebase, split this across Explore subagents by area, run them in parallel, and merge their notes.

## 5. Explore the UI

Run crawl.mjs for each role, then:

1. Read `tutorials/discovery/<role>/pages.json`.
2. Look at the screenshots of the main pages, reading the .jpg files, so you know what users actually see. Open a page's accessibility snapshot when you need its exact structure or labels.
3. Compare with the code map. A feature the crawler couldn't reach because it lives behind a button, in a modal, in a multi-step wizard or behind drag and drop gets `reach: interaction`. The storyboard step drives those flows later.
4. If the crawl reports pages redirected to login, the session expired. Log in again and re-crawl.
5. If whole areas are missing, add their paths to `crawl.start` and crawl again.

Then run probe.mjs for each role, and read `probe.json`. Code and screenshots show what a feature looks like; the probe shows whether it works:

- A form that `saved` is live. One whose result says `nothing was saved`, or `nothing happened`, is unfinished, even when the page looks complete. Check the code to confirm.
- A button where `nothing happened` is usually unfinished. One that `opened a dialog` leads to a feature with `reach: interaction`.
- A button that `changed the page, but not after a reload` only changes the page in the browser. Say so in the feature's notes.
- The probe skips destructive-sounding controls and sign-in forms. Judge those from the code.

Then run look.mjs, and set the videos' look in config.yaml from it and the code:

- **`brand.color` and `brand.background`:** start from `suggest.brand`. Check them against the code's theme: Tailwind config, CSS custom properties such as `--primary`, or a theme file. Use the code's value when it names the brand color and look.mjs picked something else.
- **`app.display_url`:** the address the videos show instead of localhost. Use `public_url` if look.mjs found one. Otherwise look in the code: `homepage` in package.json, the README, `.env.example` (`APP_URL`, `NEXT_PUBLIC_SITE_URL` and similar), deploy config such as `CNAME`, `vercel.json` or `fly.toml`, or a canonical link. Leave it unset if none of these say.
- **The narrator:** if `lang` isn't English, set `voice.lang` (Ming speaks German, Spanish, French, Korean, Japanese and Chinese) and note it for the report. Without Apple Silicon the narrator is Kokoro, which has no German, for example.

## 6. Write tutorials/features.yaml

- Write one entry per user-facing capability, in the user's words ("Invite a teammate"), not one per page or component.
- Use the exact UI labels in `entry` and `labels`.
- Back each feature with evidence: code paths, screenshots, or both.
- Mark features honestly: `flagged` for behind a flag, `unfinished` for anything the probe or the code shows doesn't work, and `internal` for admin tools and debug pages.
- Judge `importance` from the user's point of view; see formats.md.

Run `check.mjs features`. Fix every error, and fix warnings when they point at a real gap.

## 7. Report back

Keep it short:

- How many features you found, by area, with the core ones named
- What doesn't work: the features the probe showed are unfinished
- What you're unsure about: code-only features, pages that errored, roles you couldn't log in as, controls the probe skipped
- The look you set: the brand color and where it came from, and the public address, or that you couldn't find one. Ask the user to correct either if it's wrong
- The next step: `/tutorials:plan`, optionally with an audience or focus, such as `/tutorials:plan admins`
