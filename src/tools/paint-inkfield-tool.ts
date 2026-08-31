/**
 * paint_inkfield tool — renders an InkField ink painting by driving the
 * real published app (https://ileivoivm.github.io/inkField/) headlessly via
 * the inkfield-bridge service, and writes the PNG to the shared workspace.
 *
 * This tool only produces the file — call attach_file afterwards with the
 * returned path to actually deliver it to Discord/Signal (same two-step
 * composition save_attachment/attach_file already use elsewhere).
 *
 * Three ways to specify what to paint (exactly one required):
 *   - strokes: a stroke PLAN — gestures, not line segments: each stroke has
 *     a path (straight, bent `via` a point, or splined `through` several),
 *     a length in samples (`points`: a dab or a long pull), a speed profile
 *     (`easing` — the engine reads hand speed as ink density), a color by
 *     measured name, a `voice` (named brush at its natural size), wetness,
 *     white ink, an optional bleed (`flow`) right after it, and a `data`
 *     door to any raw strokeData field. The bridge composes the full
 *     recording (inkfield-bridge/lib/score.js), validates it against the
 *     engine's playback rules, and relays non-fatal notes back here.
 *   - recording: a full InkField recording JSON object/string, for callers
 *     that want direct control over the event stream.
 *   - workspace_path: render a recording that's already in the shared
 *     workspace (e.g. a human-submitted painting dropped via the inbox).
 *
 * Render time is real and expected, not a bug: default resolution (700x700,
 * pix 1.0 — see render.js's cost model) costs roughly 40s + a few seconds
 * per stroke, and inkfield-bridge computes a generous timeout to match. A
 * render that's slow because it asked for more/bigger strokes is working as
 * intended — the fix for a timeout is a higher timeout_sec or a split, never
 * a simpler painting by default.
 */

import fs from 'fs';
import path from 'path';
import type { ToolHandler } from '@connectome/agent-core';

const WORKSPACE_RENDERS_DIR = '/workspace/shared/inkfield/renders';

/**
 * Anti-loop guard state: hash of the exact call input → failure count.
 * Entries expire after 5 minutes so a genuinely fixed situation (bridge came
 * back up, input corrected next turn) isn't blocked by stale history.
 */
const recentFailedCalls = new Map<string, { count: number; lastError: string; at: number }>();
const FAILED_CALL_TTL_MS = 5 * 60_000;

function recordFailure(callKey: string, message: string): string {
  // Opportunistic TTL prune — the map only ever holds a handful of entries.
  const now = Date.now();
  for (const [k, v] of recentFailedCalls) {
    if (now - v.at > FAILED_CALL_TTL_MS) recentFailedCalls.delete(k);
  }
  const prior = recentFailedCalls.get(callKey);
  const count = (prior?.count ?? 0) + 1;
  recentFailedCalls.set(callKey, { count, lastError: message, at: now });
  if (count >= 2) {
    return (
      `${message}\n\nNOTE: this is failure #${count} for this EXACT same call. ` +
      'Repeating it unchanged will keep failing. Change the input to fix the error above, or stop and tell the user.'
    );
  }
  return message;
}

interface StrokePlan {
  from?: { x: number; y: number } | [number, number];
  to?: { x: number; y: number } | [number, number];
  /** legacy naming, still accepted */
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  via?: { x: number; y: number } | [number, number];
  through?: Array<{ x: number; y: number } | [number, number]>;
  easing?: 'linear' | 'in' | 'out' | 'inout';
  color?: number | string;
  voice?: 'ink' | 'wash' | 'marker' | 'gothic' | 'pen' | 'spray' | 'fly' | 'special';
  brushMode?: number;
  size?: number;
  wetness?: number;
  wobble?: number;
  jitter?: number;
  points?: number;
  white?: boolean;
  colorIndex?: number;
  data?: Record<string, unknown>;
  flow?: boolean | FlowPlan;
  pauseAfterMs?: number;
}

interface FlowPlan {
  bounds?: [number, number, number, number];
  strength?: number;
  durationMs?: number;
  blendType?: number;
  lastStrokeOnly?: boolean;
}

const POINT = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
  description: 'A canvas point {x, y} in pixels; [x, y] arrays are also accepted.',
};

const FLOW = {
  type: 'object',
  description:
    'A flow pass: the engine bleeds and distorts ink already on the canvas. {bounds?: [minX, minY, maxX, maxY] ' +
    'normalised 0-1 over the canvas (default whole canvas), strength?: number (default 100), durationMs?: number ' +
    '(>= 1200 to be visible; default 1500), blendType?: 1-8 (default 3), lastStrokeOnly?: boolean}. ' +
    'Pass true for the defaults.',
  properties: {
    bounds: { type: 'array', items: { type: 'number' } },
    strength: { type: 'number' },
    durationMs: { type: 'number' },
    blendType: { type: 'number' },
    lastStrokeOnly: { type: 'boolean' },
  },
};

export function createPaintInkfieldTool(): ToolHandler {
  return {
    name: 'paint_inkfield',
    description:
      'Paint with InkField — an ink-painting engine (brush physics + shader ink diffusion; results look hand-painted, ' +
      'not drawn). A painting is a recording of GESTURES: each stroke is a hand moving for a while, and the engine reads ' +
      'hand speed as ink density (slow passages pool dark and wet, fast ones dry out and break into dots). ' +
      'Provide exactly one of: strokes (a stroke plan, described below — the normal path), recording (a full InkField ' +
      'recording JSON string, for direct control of every event), or workspace_path (render a recording already in the ' +
      'shared workspace, e.g. one a human painted and dropped in via the InkField inbox page). ' +
      'Default canvas 700x700 at pix 1.0 (real resolution, not a thumbnail). Render time is normal and can be 30s to ' +
      'several minutes depending on stroke count and resolution — expected, not a failure; if a render times out, raise ' +
      'timeout_sec or split into fewer strokes per call rather than simplifying the painting. ' +
      'Returns a file path in the shared workspace — call attach_file with that path afterwards to actually show the image. ' +
      'CRAFT NOTES (from studying practised InkField recordings): a finished piece is rarely a few strokes — 10-40 is ' +
      'ordinary; about half of a practised painter\'s marks are short dabs and touches (points 5-15, small size) and the ' +
      'other half long lingering pulls (points 100-300); bleed AS you go — a flow pass after nearly every stroke ' +
      '(per-stroke "flow": true, which bleeds only that stroke) reads as wet ground answering each gesture, far better ' +
      'than one big flow at the end; keep palettes to 2-8 inks, mostly near-monochrome with one or two accents; let ' +
      'expression ride gesture and pacing, not parameter spread; dark grounds (background_color "night") make white ink ' +
      'speak. There is no eraser: compose, render, look, then paint again in a new call if the image asks for it. ' +
      'MINIMAL EXAMPLE: {"strokes":[{"from":{"x":80,"y":420},"to":{"x":620,"y":400},"via":{"x":350,"y":180},' +
      '"voice":"wash","color":"prussian_blue","easing":"inout","points":160,"flow":true},' +
      '{"from":{"x":120,"y":560},"to":{"x":580,"y":570},"voice":"pen","color":"rust","easing":"out","points":200}]} ' +
      '— omit every optional field you do not actively want; never pass empty arrays, empty strings or null as ' +
      'placeholders. If this tool returns an Error, READ it and change the input — repeating the exact same call fails ' +
      'the exact same way.',
    parameters: {
      strokes: {
        type: 'array',
        description:
          'The stroke plan, in painting order (max 30 strokes per call; flow passes are free). Each stroke: ' +
          '{from, to: points (canvas pixels, origin top-left; "start"/"end" also accepted); via?: one point the path ' +
          'bends through; through?: [points...] the path splines through; easing?: linear|in|out|inout — the hand\'s ' +
          'speed profile ("in" starts slow and pools ink at the start, "out" ends slow, "inout" pools at both ends and ' +
          'dries in a fast middle — the single biggest lever for a stroke reading as a gesture, not a line); ' +
          'points?: gesture length in ~16ms samples, 3-500 (default ~55-74; ~8 is a dab, 200+ a slow lingering pull; ' +
          'a long path with few points breaks into dots — which can itself be a texture); color?: palette name or id ' +
          '(omit for a random real hue); voice?: a named brush; brushMode?: 1-7; size?: brush width; wetness?: 0-1 ink ' +
          'bleed (default 0.45); wobble?: px of sine sway (default 4); jitter?: px of hand tremor (default 1.5); ' +
          'white?: true paints in white ink (needs a dark ground); flow?: true | {…} bleeds this stroke right after it ' +
          'is laid (lastStrokeOnly by default); pauseAfterMs?: rest before the next stroke; colorIndex?: 0-3 minor ' +
          'variation; data?: any raw InkField strokeData field (spring, friction, pathRotation, shapeType, hueShift, ' +
          'spraySize, maxUpdates…) — the open door past the named fields; only what breaks playback is refused}. ' +
          'COLORS (names are what the ink actually dries to, measured from renders): black 0, white 1, charcoal 2, ' +
          'slate 3, gray 4, olive_dark 5, orange 6, wheat 7 (warm sand), teal 8, ultramarine 9 (the vivid blue), ' +
          'lavender 10, moss 11, stone 12, rust 13, umber 14, chartreuse 15, pink 16, wine_red 17, golden_yellow 18, ' +
          'salmon 21, pale_gray 22, beige 23, blush 25, pale_cyan 27, red 30, yellow 31, prussian_blue 32 (the dark ' +
          'blue), coral 34, mint 35 — no plain green exists; the greens are olive_dark, teal, moss, chartreuse, mint. ' +
          'VOICES (brush at the size it reads as itself; explicit size/wetness override): ink (standard, 25), wash ' +
          '(standard, 42, wetter), marker (flat and even, 30), gothic (rough edges, 28), pen (hairline 4 — dry ' +
          'stippled line), spray (airbrush dust, 32), fly (scattered branching particles, 24), special (dense grainy ' +
          'bar, 25). All seven brush modes render.',
        items: {
          type: 'object',
          properties: {
            from: POINT,
            to: POINT,
            start: POINT,
            end: POINT,
            via: POINT,
            through: { type: 'array', items: POINT, description: 'Waypoints the path splines through, in order.' },
            easing: { type: 'string', enum: ['linear', 'in', 'out', 'inout'] },
            points: { type: 'number', description: 'Gesture length in samples, 3-500. ~8 is a dab; 200+ lingers and pools.' },
            color: {
              type: ['number', 'string'],
              description:
                'Ink color — a palette name or id 0-35. Names are what the ink actually DRIES to (measured from ' +
                'renders, not the docs): black 0, white 1, charcoal 2, slate 3, gray 4, olive_dark 5, orange 6, wheat 7 ' +
                '(warm sand, not earth-brown), teal 8, ultramarine 9 (the vivid blue), lavender 10, moss 11, stone 12, ' +
                'rust 13, umber 14, chartreuse 15, pink 16, wine_red 17, golden_yellow 18, salmon 21, pale_gray 22, ' +
                'beige 23, blush 25, pale_cyan 27, red 30, yellow 31, prussian_blue 32 (the dark blue), coral 34, ' +
                'mint 35. There is no plain green — the greens are olive_dark, teal, moss, chartreuse, mint. ' +
                'Omit for a random real hue (never black/white by accident).',
            },
            voice: {
              type: 'string',
              enum: ['ink', 'wash', 'marker', 'gothic', 'pen', 'spray', 'fly', 'special'],
              description:
                'A named brush: brushMode paired with the size at which it reads as itself. ink (standard, 25), ' +
                'wash (standard, 42, wetter), marker (flat and even, 30), gothic (rough textured edges, 28), ' +
                'pen (hairline, 4 — dry stippled line), spray (airbrush dust, 32), fly (scattered branching ' +
                'particles, 24), special (dense grainy bar, 25). An explicit size/wetness overrides the voice\'s.',
            },
            brushMode: {
              type: 'number',
              description: 'Raw brush mode 1-7 (1 Standard, 2 Marker, 3 Gothic, 4 Pen, 5 Spray, 6 Fly, 7 Special) — prefer voice. All seven render.',
            },
            size: { type: 'number', description: 'Brush width. Hairline ~3-4, ink ~25, wash ~42, a field laid in one pass up to ~250.' },
            wetness: { type: 'number', description: 'Ink bleed/diffusion 0-1 (default 0.45 — practised recordings rarely move it). Higher = wetter, softer edges.' },
            wobble: { type: 'number', description: 'Sine sway across the path in px (default 4).' },
            jitter: { type: 'number', description: 'Hand tremor in px (default 1.5). 0 for a mechanical line.' },
            white: { type: 'boolean', description: 'Paint in white ink (palette 1). Speaks on a dark ground; invisible on paper.' },
            flow: { ...FLOW, type: ['boolean', 'object'], description: 'Bleed this stroke right after laying it. true = defaults (lastStrokeOnly). ' + FLOW.description },
            pauseAfterMs: { type: 'number', description: 'Rest after this stroke before the next (default ~700ms).' },
            colorIndex: { type: 'number', description: 'Minor per-stroke color variation 0-3. NOT a hue selector.' },
            data: { type: 'object', description: 'Raw InkField strokeData fields, passed through as-is.' },
          },
        },
      },
      flow: { ...FLOW, type: ['boolean', 'object'], description: 'A final flow pass over the whole canvas (or bounds) after all strokes — a closing breath. ' + FLOW.description },
      background_color: {
        type: ['array', 'string'],
        description:
          'OPTIONAL — omit for the default paper. [r, g, b] 0-255, a "#rrggbb" hex, or one of paper/cream/ivory/beige/' +
          'black/white/ink/night. Dark grounds ("night") make white ink speak. Never pass an empty array or stroke data here.',
        items: { type: 'number' },
      },
      seed: { type: 'number', description: 'OPTIONAL integer. Same plan + same seed = the identical painting; omit for a fresh variation each call.' },
      recording: {
        type: 'string',
        description: 'Advanced mode: a full InkField recording JSON (as a string) for direct event-stream control.',
      },
      workspace_path: {
        type: 'string',
        description: 'Render an existing recording already in the shared workspace, e.g. "inkfield/inbox/2026-08-16-title.json".',
      },
      canvas_width: { type: 'number', description: 'OPTIONAL — omit for 700. Canvas width in px (strokes mode). Output resolution = canvas_width * pix.' },
      canvas_height: { type: 'number', description: 'OPTIONAL — omit for 700. Canvas height in px (strokes mode).' },
      pix: {
        type: 'number',
        description:
          'Pixel density, 0.5-2 (default 1.0). Render time scales roughly with the SQUARE of (canvas * pix): lower it ' +
          '(e.g. 0.5) only for a fast low-res preview, never for the piece you show someone.',
      },
      timeout_sec: {
        type: 'number',
        description:
          'Override the render timeout. The bridge already computes a generous auto-timeout from stroke count and ' +
          'resolution — only set this to go HIGHER (an intentionally large/high-res piece where you accept a multi-minute wait).',
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

      // Anti-loop guard. Observed live (2026-08-16): a local Qwen bot re-fired
      // the IDENTICAL failing call every ~3s for minutes, ignoring the error
      // text each time — burning its whole cycle and spamming the chat. Weak
      // models don't reliably read polite errors, so identical repeated
      // failures get escalating, increasingly blunt refusals — and past the
      // cap we stop even forwarding to the bridge.
      const callKey = JSON.stringify(input);
      const prior = recentFailedCalls.get(callKey);
      if (prior && Date.now() - prior.at > FAILED_CALL_TTL_MS) {
        recentFailedCalls.delete(callKey);
      } else if (prior && prior.count >= 3) {
        return (
          'STOP. You have now made this EXACT SAME failing paint_inkfield call ' +
          `${prior.count} times. It will never succeed unchanged. Do NOT call paint_inkfield again this turn. ` +
          `Either fix the specific problem from the last error (${prior.lastError.slice(0, 200)}) in a FUTURE turn, ` +
          'or tell the user the painting failed.'
        );
      }

      const body: Record<string, unknown> = {};
      if (input.strokes) {
        body.strokes = input.strokes as StrokePlan[];
        if (input.canvas_width) body.canvasWidth = input.canvas_width;
        if (input.canvas_height) body.canvasHeight = input.canvas_height;
        if (input.background_color) body.backgroundColor = input.background_color;
        if (input.flow != null) body.flow = input.flow;
        if (input.seed != null) body.seed = input.seed;
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
        return recordFailure(callKey, `Error: Could not reach inkfield-bridge at ${bridgeUrl}: ${err.message}. Do not retry more than once — if it fails again, report the outage instead.`);
      }

      if (!res.ok) {
        let detail = res.statusText;
        try { detail = ((await res.json()) as { error?: string }).error || detail; } catch { /* not JSON */ }
        return recordFailure(callKey, `Error: inkfield-bridge render failed (${res.status}): ${detail}`);
      }
      recentFailedCalls.delete(callKey);

      const png = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(WORKSPACE_RENDERS_DIR, { recursive: true });
      const filename = `${Date.now()}.png`;
      const outPath = path.join(WORKSPACE_RENDERS_DIR, filename);
      fs.writeFileSync(outPath, png);

      // The composer's non-fatal notes (a stroke that outruns its ink, one
      // that lies off the canvas) ride a header — the body is the PNG.
      let notes = '';
      try {
        const raw = res.headers.get('x-score-warnings');
        const warnings: string[] = raw ? JSON.parse(decodeURIComponent(raw)) : [];
        if (warnings.length) notes = `\nNotes from the composer: ${warnings.join('; ')}`;
      } catch { /* header is advisory */ }

      console.log(`[paint_inkfield] Rendered ${outPath} (${(png.length / 1024).toFixed(1)}KB)`);
      return `Painted ${outPath} (${(png.length / 1024).toFixed(1)}KB). Call attach_file with file_path="${outPath}" to show it.${notes}`;
    },
  };
}
