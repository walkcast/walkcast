# Narration style

The narration is read by a synthetic voice over a screen recording, so write for the ear.

- **Short sentences, one idea each.** Keep each `say` line under 25 words so it fits while its action happens on screen.
- **Speak to the viewer, in the present tense.** "Click New project." Not "The user then clicks the button."
- **Use the exact UI labels**, taken from `labels` in features.yaml. In narration, say them plainly with no quotes; in SOPs, put them in bold.
- **Open with the outcome**, in one sentence: what the viewer will be able to do. Close with the result and what to watch next.
- **Say why when it isn't obvious.** "Share it, so your team sees every update." Skip it when it is obvious.
- **Don't narrate every movement.** Let the screen carry obvious steps, and talk about what matters.
- **Write things the way they're spoken**: "CSV", "two-factor", "about a minute".
- **Avoid** "simply", "just", "easy" and "obviously"; filler and jokes; marketing claims; and prices, dates or counts that will go stale.
- **Only describe what the app actually does.** Every claim must match features.yaml or what's on screen. Never invent a feature or a result.

Pacing: about 150 words a minute, so seconds ≈ words ÷ 2.5. Add about 1 second per click or form step for the action itself.

## script.md layout

```markdown
# Create your first project

Audience: New team leads · Length: about 90 seconds · Role: admin

1. Everything in Acme lives in a project. Let's create one.
2. Open Projects from the sidebar.
3. Then click New project.
...
```

Number the lines to match the steps in tour.yaml, so each line is spoken during its step.

## sop.md layout

```markdown
# Create a project

**Purpose:** ...
**Scope:** who and when this applies to
**Roles:** who can do it
**Prerequisites:** what must be true first

## Procedure
1. In the sidebar, click **Projects**.
2. Click **New project**.
...

## Expected result
...

## Troubleshooting
- **Problem:** fix
```

### Screenshots in SOPs

`![The members table](step:4)` puts in the storyboard screenshot of tour step 4, cropped around its target with the target ringed. `step:4:after` is the screen after step 4, uncropped. bundle.mjs swaps them for image files when it builds the PDF. The numbers are tour.yaml's steps, which count narration-only lines, so they often differ from the procedure's numbers.

- Put one under each procedure step where the reader has to find something on screen, indented into the list item with a blank line before and after. Skip steps the text makes obvious.
- Put the result of the last action under "Expected result", as `step:N:after`.
- The alt text says what the screenshot shows.

```markdown
2. Click **Members**.

   ![Members on the Settings page](step:3)

3. Check the table to make sure the person isn't already listed.
```
