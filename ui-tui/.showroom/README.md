# TUI Showroom

Scripted, record-ready demos for `ui-tui`. Drop a JSON workflow into `workflows/`, hit play.

```bash
npm run showroom
npm run showroom:build
npm run showroom:type-check
```

`npm run showroom` serves every workflow in `workflows/` at `http://127.0.0.1:4317`. Use the dropdown in the top-right or pass `?w=<name>` to deep-link a workflow.

```bash
npm run showroom -- --port 4318
npm run showroom -- --workflow .showroom/workflows/feature-tour.json
npm run showroom:build                                  # builds dist/<name>.html for every workflow + dist/index.html
npm run showroom:build .showroom/workflows/voice-mode.json dist/voice.html
```

## Bundled workflows

| File                                   | Demonstrates                           |
| -------------------------------------- | -------------------------------------- |
| `workflows/feature-tour.json`          | Plan → tool trail → result highlight   |
| `workflows/subagent-trail.json`        | Parallel subagents, hot lanes, summary |
| `workflows/slash-commands.json`        | Slash palette: /skills, /model, /agents |
| `workflows/voice-mode.json`            | VAD capture, transcript, TTS ducking   |

## Workflow Shape

```json
{
  "title": "Hermes TUI Feature Tour",
  "viewport": { "cols": 96, "rows": 30, "scale": 4 },
  "timeline": [
    { "at": 0, "type": "status", "text": "summoning hermes..." },
    { "at": 250, "type": "message", "id": "prompt", "role": "user", "text": "Build a plan." },
    { "at": 900, "type": "caption", "target": "prompt", "text": "Named targets drive overlays." }
  ]
}
```

## Timeline Actions

| Action      | Required             | Optional                                    |
| ----------- | -------------------- | ------------------------------------------- |
| `status`    | `text`                | `detail`                                    |
| `compose`   | `text`                | `duration` (typewriter)                     |
| `message`   | `role`, `text`        | `id`, `duration`                            |
| `tool`      | `title`, `items`      | `id`                                        |
| `caption`   | `target`, `text`      | `position` (`left`/`right`/`top`), `duration` |
| `spotlight` | `target`              | `pad`, `duration`                           |
| `highlight` | `target`              | `duration`                                  |
| `fade`      | `target`              | `to` (default `0`), `duration`              |
| `clear`     | —                     | —                                           |

`target` references the `id` of an earlier `message`, `tool`, or caption. `viewport.scale` is the upscale factor — `scale: 4` produces a 4x capture surface without rescaling the source terminal proportions.

## Player

- Restart, Clear, and 0.5x / 1x / 2x speed buttons under the stage.
- Keyboard: `R` restart, `C` clear, `1`/`2`/`3` speed.
- Progress bar tracks elapsed/total based on the slowest action's `at + duration`.

## Authoring tips

- Keep `at` values in milliseconds; sort happens automatically.
- Use `id`s on every element you want to spotlight, fade, or caption later.
- Captions auto-position next to their target; pass `position: "left"` or `"top"` when the right side is busy.
- Test at a non-default speed before recording — fast reads are unforgiving.
