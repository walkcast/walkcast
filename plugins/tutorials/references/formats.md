# File formats

Everything lives in a `tutorials/` folder at the root of the app's repository. These files are the source of truth: the skills read and write them, and the user reviews them like code. Commit everything except `.auth/`, `.env`, `discovery/`, `.cache/`, `dist/` and the storyboard and produce output, which are rebuilt on every run.

```
tutorials/
├── config.yaml       how to run the app, who logs in, what to crawl
├── .env              test-account credentials (gitignored)
├── .gitignore        .auth/, .env, discovery/, .cache/, */storyboard/, */storyboard.html, */produce/, dist/
├── features.yaml     every user-facing feature            (discover writes it)
├── plan.yaml         the proposed videos and SOPs         (plan writes it)
├── plan.md           readable version of plan.yaml        (plan writes it)
├── <tutorial-id>/    one folder per approved item         (plan creates it)
│   ├── tour.yaml     the steps to perform and narrate
│   ├── script.md     narration draft, for video and both items
│   ├── sop.md        SOP draft, for sop and both items
│   ├── storyboard.html   each narration line next to its screenshots   (storyboard writes it)
│   ├── storyboard/   NN-before.jpg, NN-after.jpg, steps.json             (storyboard)
│   └── produce/      voice.json, recording.*, render/, video.*, captions.vtt, review.html  (produce)
├── dist/             everything to publish, with index.html (bundle)
├── assets/music/     the background track music.mjs picked
├── assets/voice/     narrator.wav, the project's own narrator, if it has one (voice.mjs --keep)
├── .cache/           voice/ narration clips and samples.html (voice.mjs); music/choices.html (music.mjs); app.log, app.pid (app.mjs)
├── .auth/            saved login sessions, one per role   (login.mjs)
└── discovery/        working notes and crawl output       (discover)
    ├── code-map.md
    ├── look.json     the app's colors, language, public address and icons (look.mjs)
    └── <role>/pages.json, probe.json, screens/*.jpg, snapshots/*.yaml
```

Ids everywhere are lowercase with dashes: `create-project`, `invite-a-teammate`.

## config.yaml

```yaml
app:
  name: Acme Projects
  url: http://localhost:3000      # where the app is reachable
  start: npm run dev              # optional: command that starts it
  cwd: .                          # optional: folder to run start in
  ready_timeout: 120              # optional: seconds to wait for it to respond
  reset: npm run db:seed          # puts the demo data back; run before each tour is probed, storyboarded or recorded
  display_url: https://app.acme.com   # optional: what the videos' address bar shows instead of url

roles:                            # one entry per kind of user; omit for apps without login
  - id: admin
    description: Workspace owner; can change settings and billing
    login:
      url: /login                 # path or full URL of the login page
      username: ${ADMIN_EMAIL}    # ${VAR} reads the environment or tutorials/.env
      password: ${ADMIN_PASSWORD}
      success: /dashboard         # optional: path that means login worked
      manual: false               # true: open a browser and let the user log in (SSO, one-time codes)
      username_field: Work email  # optional: label of the username field if it isn't standard
      password_field: Password    # optional
      submit: Sign in             # optional: label of the submit button

crawl:
  start: [/]                      # paths to start from
  max_pages: 40
  per_pattern: 2                  # pages to keep per route pattern, e.g. /projects/:id
  exclude: ["^/api/", "^/admin/debug"]   # regexes for paths to skip
  viewport: { width: 1440, height: 900 }

audience: Team leads new to the product   # default audience for the plan

voice:                            # optional: the narrator; voice.mjs --samples plays a few to choose from
  engine: ming                    # ming (the default on Apple Silicon Macs) or kokoro (the default elsewhere)
  voice: narrator                 # ming: narrator (the plugin's own), US_Emma, US_James, US_Stella, UK_George, UK_Charlotte
                                  # kokoro: af_heart and others; the first letter is the language (a: American English,
                                  # b: British, e: Spanish, f: French, i: Italian, p: Portuguese, h: Hindi), the second f or m
  lang: en                        # ming only: en, de, es, fr, ko, ja or zh
  speed: 1.0
  # A narrator of your own, instead of voice (ming only). voice.mjs --keep writes these after --samples --describe,
  # or point them at a recording of a real voice, with permission: 5 to 15 seconds, with its exact words.
  # reference: assets/voice/narrator.wav
  # reference_text: Hi! I'll walk you through this step by step...
  # describe: A warm, friendly woman in her thirties...   # what the narrator was made from, for the record

brand:                            # optional: the video's look
  color: "#4c6ef5"                # highlights, click ripples and title cards
  background: "#141a2e"           # behind the browser window

music:                            # optional: looped and mixed in under the voice; none for no music
  file: assets/music/inspired.mp3 # relative to tutorials/; a plain path also works: music: assets/x.mp3
  credit: |-                      # shown on each video's closing card and on the bundle's index page
    "Inspired" Kevin MacLeod (incompetech.com)
    Licensed under Creative Commons: By Attribution 4.0
    https://creativecommons.org/licenses/by/4.0/
  isrc: USUAN1100123              # the recording's code, which helps settle a copyright claim

video:                            # optional
  zoom: auto                      # auto: zoom onto small targets; off: never zoom
  max_zoom: 1.6
  captions: true                  # false: no captions burned into the video (captions.vtt is still written)

bundle:                           # optional
  paper: a4                       # a4 or letter, for the SOP PDFs
```

`reset` is optional in the format, but any app whose tours create or change data needs it: without it, every run after the first starts from different data. A seed script, a database reset, or a test-only endpoint all work.

## features.yaml

One entry per thing a user would describe as "I can ...". Not one per page or component.

```yaml
app: Acme Projects
generated_at: 2026-10-29
areas:
  - { id: projects, name: Projects }
  - { id: settings, name: Settings }
features:
  - id: create-project
    name: Create a project
    summary: Start a new project with a name, description and owner.
    area: projects
    roles: [admin, member]
    entry: ["Projects > New project", "Dashboard > New project"]   # how users get there, in UI labels
    routes: [/projects/new]
    actions: [create]
    importance: core          # core | common | advanced | admin
    status: live              # live | flagged | unfinished | internal
    reach: link               # link: the crawler reached it; interaction: needs clicks (modal, wizard, drag and drop)
    labels: ["New project", "Project name", "Create project"]   # exact UI text a tutorial will refer to
    evidence:
      code: [src/routes/projects/new.tsx, src/api/projects.ts]
      screens: [discovery/admin/screens/projects-new.jpg]          # relative to tutorials/
    notes: Owner defaults to the current user.
```

Importance: `core` is what most users need in their first week. `common` is regular but not essential. `advanced` is power-user. `admin` is settings, billing and team management.

## plan.yaml

```yaml
status: proposed              # proposed | approved
approved_at: null             # date, set on approval
audience: Team leads new to the product
items:
  - id: create-your-first-project
    kind: video               # video | sop | both
    title: Create your first project
    audience: New team leads
    role: admin               # which role from config.yaml performs it
    goal: After this video you can create a project and add its first task.
    features: [create-project, add-task]   # ids from features.yaml
    prerequisites: [Signed in]
    demo_data: [At least one other member, so the owner list isn't empty]
    duration_sec: 90          # required for video and both; words / 2.5
    steps:                    # plain English, 2 to 14
      - Open Projects from the sidebar
      - Click New project
      - Enter a name and description, then click Create project
      - Add a first task
    opening: Everything in Acme lives in a project. Let's create one.
    closing: That's your first project. Next, invite your team to it.
```

## tour.yaml

Created by plan on approval, one per item. Each step is what happens on screen and what the narrator says while it happens. `target` is the element's visible label; the storyboard resolves it to a `locator` and screenshots the step.

```yaml
id: create-your-first-project
title: Create your first project
role: admin
start: /dashboard
approved_at: null               # set with approved_hash by storyboard.mjs --approve
approved_hash: null             # fingerprint of the approved steps; record.mjs refuses a tour that differs
steps:
  - say: Everything in Acme lives in a project. Let's create one.
  - do: show                    # ring the stat cards while the line is spoken
    target: Open projects
    say: The Dashboard sums up your open projects and tasks.
    locator: { css: main .stats }
  - do: click
    target: Projects            # visible label of the element
    say: Open Projects from the sidebar.
    expect: The Projects list   # for people reading the storyboard
    expect_text: Search projects   # must be on the page after the step; storyboard and record check it
    locator: { role: link, name: Projects }   # written by storyboard
  - do: click
    target: New project
    say: Then click New project.
    expect_text: Project name
  - do: type
    target: Project name
    text: Q3 Launch
    say: Give it a name your team will recognize.
    cue: a name                 # the words in say where the action lands
  - do: click
    target: Create project
    say: Click Create project, and it opens straight away.
    expect: The Q3 Launch project page
    expect_text: [Q3 Launch, No tasks yet.]
```

`do` is one of: `goto` (with `path`), `click`, `type` (with `text`), `select` (with `option`), `check`, `hover`, `show`, `press` (with `key`), `scroll`, `wait` (with `seconds`, default 1). `click`, `type`, `select`, `check`, `hover` and `show` need a `target`; `press` and `scroll` take one optionally. A step with only `say` is narration over the current screen. Each numbered line in script.md is the `say` of the step with the same number.

- `show` points something out without touching it: the video rings it, and zooms if it's small, while the line is spoken. Use it when the narration describes a part of the screen.
- `cue` is the words in `say` at which the action lands. Without it, the action lands as the narrator finishes saying the target's label, or the phrase after a verb such as "click" or "tick", or halfway through the line. Add a cue whenever the narration doesn't say the label.
- `expect_text` is text that must be visible after the step, as a string or a list. A storyboard or recording where it's missing fails at that step. Use the exact words the page shows; parts of a line are fine. `expect` stays as the description for people.

Approval: `storyboard.mjs --approve` sets `approved_at` and `approved_hash` once a tour has a clean storyboard of its current steps. Changing anything that affects the video afterwards (steps, narration, targets, locators, cues, expected text, start or role) makes `check.mjs tours` warn and `record.mjs` refuse until it's storyboarded and approved again.

### Locators

`locator` pins a step to one element. The storyboard writes it after resolving `target`, and later runs use it first, falling back to `target` if it stops matching. Write one by hand when a label matches more than one element.

| Field | Meaning |
| --- | --- |
| `role` and `name` | An element with that ARIA role and accessible name: `{ role: button, name: Save }` |
| `label` | A form field with that label |
| `text` | An element with that visible text |
| `css` | A CSS selector, as a last resort |
| `exact` | `false` matches part of the name or text, ignoring case. Default `true` |
| `nth` | Which of several visible matches, counting from 0 |
| `within` | Another locator to search inside: `{ role: button, name: Delete, within: { role: row, name: Website relaunch, exact: false } }` |

Use exactly one of `role`, `label`, `text` or `css`.

### Storyboard output

`storyboard.mjs` rebuilds these on every run:

- `storyboard/NN-before.jpg` and `NN-after.jpg`: the viewport before and after step NN, at the config's viewport size. Narration-only steps have just a before shot. A step that fails gets `NN-failed.jpg` and `NN-failed.aria.yaml`, the page's accessibility snapshot.
- `storyboard/steps.json`: `tour_hash`, the fingerprint of the tour it ran, and for each step: the element it resolved to (`element`, such as `link "Projects"`), its `locator`, its `box` in the before shot, the URL before and after, the page's visible `text` as the step starts, and `notes` about anything else that happened (errors, dialogs, downloads, new tabs).
- `storyboard.html`: each narration line next to its screenshots, with the target ringed, for the user to approve.

## Produce output

Each video item gets `tutorials/<id>/produce/`, rebuilt by each stage:

- `voice.json` (voice.mjs): for each step, its `say` line, the clip in `.cache/voice/` (path relative to tutorials/), its `duration`, and `words` with `start` and `end` in seconds from the start of the clip.
- `recording.mp4` and `recording.json` (record.mjs): the app's viewport at twice its size and 30 fps, with no pointer. `inputs` fingerprints the tour and narration it was recorded from. For each step, `start` and `end` in seconds from the start of the recording, the narration clip and when it plays, and the `action`: when it lands (`at`), where (`x`, `y` in viewport pixels), the target's `box`, the pointer's path (`from`, `travel`), the typing window for `type` steps, and whether the element `vanished` when clicked. `differences` lists steps where the page's text didn't match the approved storyboard, which usually means the demo data was different.
- `render/` (render.mjs): the HyperFrames composition, `index.html` with its media.
- `video.mp4`: the finished video, 1920×1080, 30 fps, H.264 with AAC sound at −16 LUFS.
- `video.json`: the video's `duration`, the title card's length (`intro`), for each step its `say`, `start`, `end` and `action_at` in seconds of the video, the `problems` the review found, and `inputs`, which render.mjs uses to skip videos whose inputs haven't changed.
- `captions.vtt`: the captions, for video players and video sites.
- `review.html` and `review/`: the video, a frame just after each action (or midway through a narration-only step), when each line's speech starts relative to its step, and any problems: speech that doesn't start where its line should, or a page that differed from the storyboard.

## sop.md screenshots

An image whose address is `step:N` is the storyboard screenshot of tour step N as the step starts, cropped around its target with the target ringed: `![The members table](step:4)`. `step:N:after` is the whole screen after step N. N counts the steps in tour.yaml, narration-only ones included. bundle.mjs turns them into image files, and leaves an SOP out of the bundle if its storyboard doesn't show the approved tour.

## Bundle output

`bundle.mjs` rebuilds `tutorials/dist/` (or `--out`) on every run, in plan order:

- `<id>/<id>.mp4`: the finished video, with its title and a chapter per step inside, and its captions as a track when they aren't burned in. Moved to the start of the file for streaming.
- `<id>/<id>.vtt` and `<id>/<id>.chapters.vtt`: captions, and chapters named by each step's narration. The first chapter starts at 0 and covers the title card.
- `<id>/<id>.jpg`: a 1280×720 thumbnail, the tour's last storyboard screen in a browser window on the brand background. A video without a current storyboard gets a frame of its title card.
- `<id>/<id>.md`, `<id>/<id>.pdf` and `<id>/images/`: the SOP, with its `step:N` screenshots as files.
- `index.html`: every item as a card; each opens a page with the video beside its steps (click one to jump there), the downloads, and the SOP. It needs no server and works opened from disk.
- `tutorials.json`: `app`, `generated`, and for each item its `id`, `title`, `kind`, `audience`, `goal`, `thumbnail`, `video` (`file`, `captions`, `chapters_file`, `duration`, `chapters` with `start` and `title`) and `sop` (`markdown`, `pdf`, `images`), with paths relative to the folder.

A video is left out, and listed in the result's `not_included`, unless its tour is approved as it stands and its recording and render are of that tour and the current settings.

## Look output

`discovery/look.json` (look.mjs): the page `title`, `site_name`, `lang`, `theme_color`, `public_url` (from a canonical link or og:url that isn't local), `icons`, `logos`, and `colors`, the saturated colors on buttons and links, most used first. `suggest` has `brand` (`color`, darkened if needed so white text on it is readable, and `background`, the app's dark sidebar or header, or a deep shade of the color) and `display_url`, ready for config.yaml.

## Probe output

`discovery/<role>/probe.json` (probe.mjs) lists each form and button it tried, per route pattern: `kind` (form or button), `page`, `label`, the `fields` it filled, and `result`. For a form, `saved` means the text it typed was still there after a reload. A form `result` of `changed the page, but nothing was saved` or `nothing happened` points to an unfinished feature. For a button, it's one of `opened a dialog`, `went to <path>`, `changed the page and saved it`, `changed the page, but not after a reload`, `started a download`, `opened a new tab` or `nothing happened`. Destructive-sounding controls and sign-in forms are `skipped`.
