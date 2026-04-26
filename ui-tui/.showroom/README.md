# TUI Showroom

Cinematic demos of the real `ui-tui`. Workflows are built from actual Ink-rendered ANSI captured from `MessageLine`, `Panel`, and friends — replayed in xterm.js with timeline overlays (captions, spotlights, fades, highlights).

```bash
npm run showroom            # dev server at http://127.0.0.1:4317
npm run showroom:record     # re-record all workflows (regenerates JSON)
npm run showroom:build      # builds dist/<name>.html for every workflow
npm run showroom:type-check
```

## Bundled workflows

| File                                   | Demonstrates                                          |
| -------------------------------------- | ----------------------------------------------------- |
| `workflows/feature-tour.json`          | Plan → tool trail → result highlight                  |
| `workflows/subagent-trail.json`        | Parallel subagents, hot lanes, summary                |
| `workflows/slash-commands.json`        | `/skills`, `/model`, `/agents` panels                 |
| `workflows/voice-mode.json`            | VAD capture, transcript, TTS ducking                  |

Use the dropdown in the top-right or pass `?w=<name>` to deep-link a workflow.

## Architecture

```
record.tsx           ─┐
  ↳ MessageLine,      │  Ink renders → custom Writable → ANSI string
    Panel, Box, Text  │
                      ▼
workflows/<name>.json
                      │  served at /api/workflow/<name>
                      ▼
showroom.js           │  xterm.js writes ANSI; DOM overlays target frame ids
                      ▼
browser
```

Every `frame` action embeds the ANSI bytes from a real Ink render; the browser replays them via `@xterm/xterm` (loaded from jsDelivr) so the surface is the actual TUI, not a CSS approximation. Cinematic overlays (captions, spotlights, highlights, fades) are positioned by frame `id` and rendered via DOM.

## Workflow Shape

```json
{
  "title": "Hermes TUI · Feature Tour",
  "viewport": { "cols": 80, "rows": 16 },
  "composer": "ask hermes anything",
  "timeline": [
    { "at": 200, "type": "frame", "id": "user-row", "ansi": "..." },
    { "at": 1500, "type": "frame", "id": "assistant", "ansi": "..." },
    { "at": 1700, "type": "spotlight", "target": "assistant" },
    { "at": 1900, "type": "caption", "target": "assistant", "text": "..." }
  ]
}
```

## Timeline Actions

| Action      | Required             | Optional                                              |
| ----------- | -------------------- | ----------------------------------------------------- |
| `frame`     | `ansi`               | `id`                                                  |
| `status`    | `text`               | `detail`                                              |
| `compose`   | `text`               | `duration` (typewriter)                               |
| `caption`   | `target`, `text`     | `position` (`left`/`right`/`top`), `duration`         |
| `spotlight` | `target`             | `pad`, `duration`                                     |
| `highlight` | `target`             | `duration`                                            |
| `fade`      | `target`             | `to` (default `0`), `duration`                        |
| `clear`     | —                    | —                                                     |

`target` references the `id` of an earlier `frame`. `viewport.scale` (default = best-fit integer) controls the upscale factor; manual buttons offer 1x–4x for capture-ready output.

## Player

- Restart, Clear, 1x–4x scale, 0.5x/1x/2x speed.
- Keyboard: `R` restart, `C` clear, `1`/`2`/`3` speed.
- Progress bar tracks elapsed/total based on the slowest action's `at + duration`.

## Adding a workflow

1. Add a scene fn to `record.tsx` that returns a `{ title, viewport, composer, timeline }` shape.
2. Compose Ink primitives (`Box`, `Text`) or import real ui-tui components (`MessageLine`, `Panel`).
3. Snap each scene with `await snap(<Component />)` to capture ANSI.
4. Run `npm run showroom:record`.

Components rendered to ANSI must be **state-free** at first paint — `useEffect` hooks usually haven't fired by the time the recorder unmounts. For accordions like the live `ToolTrail`, render an inline scene with `Box` + `Text` instead.
