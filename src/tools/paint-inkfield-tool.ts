/**
 * paint_inkfield tool — renders an InkField ink painting by driving the
 * real published app (https://ileivoivm.github.io/inkField/) headlessly via
 * the inkfield-bridge service, and writes the PNG to the shared workspace.
 *
 * This tool only produces the file — call attach_file afterwards with the
 * returned path to actually deliver it to Discord/Signal (same two-step
 * composition save_attachment/attach_file already use elsewhere; keeps
 * this tool from having to duplicate the blob-store upload logic).
 *
 * Three ways to specify what to paint (exactly one required):
 *   - strokes: a short list of {start, end, color?, brushMode?, easing?, size?,
 *     wetness?} straight-line strokes, expanded server-side into InkField's full
 *     stroke-physics event schema (spring/friction/wobble) — the easy path for
 *     an agent. See render.js's strokeData()/PALETTE for the ground-truth-verified
 *     color/palette fix (colorIndex is NOT a hue selector, brushColorMode is —
 *     every painting rendered before that fix was solid black regardless of what
 *     "color" was requested, despite InkField's own examples suggesting otherwise).
 *   - recording: a full InkField recording JSON object/string, for callers
 *     that want direct control over the event stream (see InkField's own
 *     agent-api-spec, embedded as JSON in its index.html — read the cloned
 *     reference repo if you need shapeType/flow-effects/effectControl-level
 *     detail this tool doesn't expose in simple mode).
 *   - workspace_path: render a recording that's already in the shared
 *     workspace (e.g. a human-submitted painting dropped via the InkField
 *     inbox page) instead of generating a new one.
 *
 * Render time is real and expected, not a bug: default resolution (700x700,
 * pix 1.0 — see render.js's cost model) costs roughly 40s + ~3.5s/stroke at
 * that resolution, and inkfield-bridge computes a generous timeout to match.
 * A render that's slow because it asked for more/bigger strokes is working
 * as intended — don't treat a slow render as a signal to simplify the
 * painting; if one genuinely times out, prefer raising timeout_sec over
 * cutting content, or split into multiple calls.
 */

import fs from 'fs';
import path from 'path';
import type { ToolHandler } from '@connectome/agent-core';

const WORKSPACE_RENDERS_DIR = '/workspace/shared/inkfield/renders';

interface StrokePlan {
  start: { x: number; y: number };
  end: { x: number; y: number };
  color?: number;
  brushMode?: number;
  wobble?: number;
  easing?: 'linear' | 'in' | 'out' | 'inout';
  size?: number;
  wetness?: number;
  colorIndex?: number;
}

export function createPaintInkfieldTool(): ToolHandler {
  return {
    name: 'paint_inkfield',
    description:
      'Paint an image with InkField, an organic ink-painting engine (WebGL brush physics + shader-based ink ' +
      'diffusion, not a raster drawing API — results look hand-drawn, not geometric). ' +
      'Provide exactly one of: strokes (simple mode — a list of line segments, described below), recording (a full ' +
      'InkField recording JSON string for direct control of every event), or workspace_path (render an existing ' +
      'recording already in the shared workspace, e.g. one a human painted and dropped in via the InkField inbox page). ' +
      'Default output is 700x700px at full pixel density (pix 1.0) — real resolution, not a thumbnail; use pix/' +
      'canvas_width/canvas_height to trade resolution for speed if you want a quick preview instead. ' +
      'Render time is normal and can be 30s to several minutes depending on stroke count and resolution — that is ' +
      'expected, not a failure; if a render times out, raise timeout_sec or split into fewer strokes per call rather ' +
      'than defaulting to a smaller/simpler painting. ' +
      'Returns a file path in the shared workspace — call attach_file with that path afterwards to actually show the image.',
    parameters: {
      strokes: {
        type: 'array',
        description:
          'Simple mode: list of straight-line strokes, each expanded into a wobbly, physically-simulated brush ' +
          'stroke (spring/friction dynamics, ~55 interpolated points per stroke, automatic ink-decay pause between ' +
          'strokes). 3-8 strokes make a solid single composition; more strokes work fine, they just cost more render ' +
          'time (max 30 per call — split into multiple paint_inkfield calls for more, or layer separate calls into ' +
          'one piece using workspace_path/recording to build on a prior render). ' +
          'Example: [{"start":{"x":50,"y":100},"end":{"x":450,"y":120},"color":9,"brushMode":3}]',
        items: {
          type: 'object',
          properties: {
            start: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
            end: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
            color: {
              type: 'number',
              description:
                'The color, 0-35 (omit for a random real hue — never defaults to black/white). Verified by ' +
                'rendering, not just reading InkField\'s docs (their own example scripts wire this field ' +
                'confusingly): 0=black, 1=white, 33=reserved. Everything else is a named hue: 2=dark_gray, ' +
                '3=medium_gray_new, 4=light_gray_new, 5=green, 6=orange, 7=brown (renders warm ochre/sand, not ' +
                'earth-brown), 8=green_dark, 9=blue_dark (a vivid violet-leaning blue — the "blue" most people ' +
                'picture), 10=purple, 11=lime, 12=light_gray, 13=blue_gray, 14=terra_cotta, 15=olive_green, ' +
                '16=pink, 17=wine_red, 18=gold_orange, 19=gray_brown, 20=sage_gray, 21=brick_red, 22=silver, ' +
                '23=beige, 24=gray_green, 25=tan, 26=khaki, 27=dusty_rose, 28=mauve_gray, 29=medium_gray, ' +
                '30=red (crimson), 31=yellow, 32=blue (dark navy, not vivid — use 9 for a punchier blue), ' +
                '34=coral, 35=mint.',
            },
            brushMode: {
              type: 'number',
              description:
                'Brush character — ONLY 1, 2, 3, 6, or 7 are usable (default 1/Standard). Per InkField\'s own ' +
                'agent-facing spec: 1=Standard (most versatile ink brush), 2=Marker (flat, uniform, softer/more ' +
                'delayed strokes — good for slow calligraphy), 3=Gothic (textured, rough edges), 6=Fly (light, ' +
                'scattered particle strokes with branching fly-detail), 7=Special (experimental effects). ' +
                'DO NOT USE 4 ("Pen") or 5 ("Spray") — root-caused (not a strokeData issue on our end): InkField\'s ' +
                'own ?snapshot=1 replay path, which every render here goes through, silently drops strokes using ' +
                'these two modes regardless of parameters — confirmed by isolating live-paint vs. artist-mode ' +
                'replay (both draw fine) vs. snapshot-mode replay (blank) of the engine\'s own recordings. This ' +
                'tool rejects 4/5 outright rather than waste a render on nothing. Mixing the usable modes across ' +
                'strokes in one piece reads much more intentional than uniform mode-1 lines. Pair with size/wetness ' +
                'for real variety — brushMode alone still reads samey at a fixed size. Rough voices: ' +
                'ink={brushMode:1,size:25}, wash={brushMode:1,size:42,wetness:0.6}, marker={brushMode:2,size:30}.',
            },
            wobble: { type: 'number', description: 'Sinusoidal wobble amplitude in px (default 4) — how much the line deviates from perfectly straight.' },
            easing: {
              type: 'string',
              enum: ['linear', 'in', 'out', 'inout'],
              description:
                'How speed varies along the stroke (default linear = constant speed). Gesture speed IS ink density ' +
                'in this engine — slow passages pool ink dark and wet, fast passages dry out into broken texture. ' +
                '"inout" pools at both ends and breaks up in a fast middle — the single biggest lever for a stroke ' +
                'reading as a real gesture instead of a uniform line.',
            },
            size: { type: 'number', description: 'Brush width (initialSize), roughly 10-50 (default 38). Pen-like strokes: ~12. Wide wash strokes: ~42.' },
            wetness: { type: 'number', description: 'Ink bleed/diffusion, 0.1-0.8 (default 0.45). Higher = wetter, softer-edged, more of a "wash". Lower = drier, more controlled.' },
            colorIndex: { type: 'number', description: 'Minor per-stroke color variation, 0-3 (optional, randomized if omitted). NOT a hue selector — use "color" for that.' },
          },
          required: ['start', 'end'],
        },
      },
      recording: {
        type: 'string',
        description: 'Advanced mode: a full InkField recording JSON (as a string) for direct event-stream control — shapeType, flow effects, effectControl, spectral color mixing, etc.',
      },
      workspace_path: {
        type: 'string',
        description: 'Render an existing recording already in the shared workspace, e.g. "inkfield/inbox/2026-08-16-title.json".',
      },
      canvas_width: { type: 'number', description: 'Canvas width in px (default 700, only used with strokes mode). Actual output resolution = canvas_width * pix.' },
      canvas_height: { type: 'number', description: 'Canvas height in px (default 700, only used with strokes mode). Actual output resolution = canvas_height * pix.' },
      pix: {
        type: 'number',
        description:
          'Pixel density, 0.5-2 (default 1.0). Multiplies canvas_width/canvas_height for the actual output resolution ' +
          '— e.g. 700 canvas * pix 1.0 = 700px output (the default, real art resolution). Render time scales roughly ' +
          'with the SQUARE of (canvas * pix), so pushing this up is expensive: pix 1.5 on a 500px canvas measured ' +
          '~70s for a single stroke vs ~33s at pix 0.5. Lower it (e.g. 0.5) only for a fast low-res preview, not for ' +
          'the final piece you show someone.',
      },
      background_color: {
        type: 'array',
        description: 'RGB background color, e.g. [222,212,195] (only used with strokes mode)',
        items: { type: 'number' },
      },
      timeout_sec: {
        type: 'number',
        description:
          'Override the render timeout. inkfield-bridge already computes a generous auto-timeout from your stroke ' +
          'count and resolution — only set this to go HIGHER than that (e.g. for an intentionally large/high-res ' +
          'piece where you accept a multi-minute wait).',
      },
    },
    required: [],
    handler: async (input) => {
      const bridgeUrl = process.env.INKFIELD_BRIDGE_URL;
      if (!bridgeUrl) return 'Error: INKFIELD_BRIDGE_URL is not configured for this bot.';

      const provided = ['strokes', 'recording', 'workspace_path'].filter((k) => input[k] != null);
      if (provided.length !== 1) {
        return 'Error: Provide exactly one of strokes, recording, or workspace_path.';
      }

      const body: Record<string, unknown> = {};
      if (input.strokes) {
        body.strokes = input.strokes as StrokePlan[];
        if (input.canvas_width) body.canvasWidth = input.canvas_width;
        if (input.canvas_height) body.canvasHeight = input.canvas_height;
        if (input.background_color) body.backgroundColor = input.background_color;
      } else if (input.recording) {
        body.recording = input.recording;
      } else {
        body.workspacePath = input.workspace_path;
      }
      if (input.pix) body.pix = input.pix;
      if (input.timeout_sec) body.timeoutSec = input.timeout_sec;

      console.log(`[paint_inkfield] Called with mode=${provided[0]}`);

      let res: Response;
      try {
        res = await fetch(`${bridgeUrl}/render`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err: any) {
        return `Error: Could not reach inkfield-bridge at ${bridgeUrl}: ${err.message}`;
      }

      if (!res.ok) {
        let detail = res.statusText;
        try { detail = ((await res.json()) as { error?: string }).error || detail; } catch { /* not JSON */ }
        return `Error: inkfield-bridge render failed (${res.status}): ${detail}`;
      }

      const png = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(WORKSPACE_RENDERS_DIR, { recursive: true });
      const filename = `${Date.now()}.png`;
      const outPath = path.join(WORKSPACE_RENDERS_DIR, filename);
      fs.writeFileSync(outPath, png);

      console.log(`[paint_inkfield] Rendered ${outPath} (${(png.length / 1024).toFixed(1)}KB)`);
      return `Painted ${outPath} (${(png.length / 1024).toFixed(1)}KB). Call attach_file with file_path="${outPath}" to show it.`;
    },
  };
}
