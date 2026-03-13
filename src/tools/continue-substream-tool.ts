/**
 * continue_substream tool — gives the bot agency over autotrigger continuation.
 *
 * Instead of blindly re-activating the bot after every cycle, the bot must
 * call this tool to opt in to the next cycle. If it doesn't call it, the
 * loop ends naturally. This prevents mode collapse (agent looping with
 * nothing to do) at the source rather than relying solely on a safety net.
 *
 * The tool also serves as documentation of intent — the `reason` parameter
 * makes the substream legible by recording what the bot plans to do next.
 */

import type { ToolHandler } from '@connectome/agent-core';

/** Shared mutable context — reset before each activation, read after cycle */
export interface ContinueSubstreamContext {
  /** Whether the bot called continue_substream this cycle */
  continuationRequested: boolean;
  /** What the bot said it plans to do next */
  nextReason?: string;
  /** Whether a substream or autotrigger is active on the current stream */
  isSubstreamActive: boolean;
}

export function createContinueSubstreamContext(): ContinueSubstreamContext {
  return { continuationRequested: false, isSubstreamActive: false };
}

export function createContinueSubstreamTool(ctx: ContinueSubstreamContext): ToolHandler {
  return {
    name: 'continue_substream',
    description:
      'Signal that you want another cycle in the current autotrigger substream. ' +
      'If you do NOT call this tool, the substream ends after this cycle. ' +
      'Only works during autotrigger sessions.',
    parameters: {
      reason: {
        type: 'string',
        description: 'What you plan to do in the next cycle (shown in substream logs)',
      },
    },
    handler: async (input: Record<string, any>): Promise<string> => {
      if (!ctx.isSubstreamActive) {
        return 'No active autotrigger session — this tool only works during !autotrigger sessions.';
      }

      ctx.continuationRequested = true;
      ctx.nextReason = input.reason || undefined;

      const reason = input.reason ? `: ${input.reason}` : '';
      return `Continuation scheduled${reason}`;
    },
  };
}
