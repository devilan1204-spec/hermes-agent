# TUI Showroom

Scripted, record-ready demos for `ui-tui`.

```bash
npm run showroom
npm run showroom:build
npm run showroom:type-check
```

`npm run showroom` serves the default workflow at `http://127.0.0.1:4317`.

```bash
npm run showroom -- --workflow .showroom/workflows/feature-tour.json --port 4318
npm run showroom:build -- .showroom/workflows/feature-tour.json .showroom/dist/feature-tour.html
```

## Workflow Shape

Workflows are JSON so the renderer has no extra deps.

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

- `status`: set top status text, with optional `detail`
- `compose`: type into the composer
- `message`: append a transcript line; supports `role`, `id`, `text`, `duration`
- `tool`: append a tool activity card; supports `id`, `title`, `items`
- `caption`: fade in a caption near `target`; supports `position`, `duration`
- `spotlight`: draw a spotlight around `target`; supports `pad`, `duration`
- `highlight`: temporarily emphasize `target`
- `fade`: set `target` opacity over `duration`
- `clear`: reset transcript and overlays

Targets are `id` values from `message`, `tool`, and captions. The stage is rendered at `viewport.scale`, so `scale: 4` creates a 4x capture surface without changing the source terminal proportions.
