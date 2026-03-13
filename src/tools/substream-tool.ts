/**
 * Substream tools — let the bot programmatically enter/exit substreams
 * and control its own autotrigger loop.
 *
 * These are independent axes:
 * - Substream: bot "lives in" a named substream, sees its full history
 * - Autotrigger: bot gets reactivated each cycle, gated by continue_substream
 */

import type { ToolHandler } from '@connectome/agent-core';

/** Shared context between substream tools and BotRuntime */
export interface SubstreamToolContext {
  enterSubstream: (name: string) => Promise<string>;
  exitSubstream: () => Promise<string>;
  setAutotrigger: (enabled: boolean, maxSpeechOnly?: number) => string;
  getActiveSubstream: () => { name: string; streamId: string } | null;
  isAutotriggerActive: () => boolean;
}

export function createEnterSubstreamTool(ctx: SubstreamToolContext): ToolHandler {
  return {
    name: 'enter_substream',
    description:
      'Enter a named substream. Your activations will be redirected to this substream ' +
      'so you see its full history. A workspace directory is created at ' +
      '/workspace/shared/substreams/<name>/. Does NOT start autotrigger — ' +
      'call set_autotrigger separately if you want a reactivation loop.',
    parameters: {
      name: {
        type: 'string',
        description: 'Substream name (used as stream ID suffix and directory name)',
      },
    },
    handler: async (input: Record<string, any>): Promise<string> => {
      const name = input.name;
      if (!name || typeof name !== 'string') {
        return 'Error: substream name is required';
      }
      // Sanitize: alphanumeric, hyphens, underscores only
      const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '-');
      if (!sanitized) {
        return 'Error: substream name must contain at least one alphanumeric character';
      }
      return ctx.enterSubstream(sanitized);
    },
  };
}

export function createExitSubstreamTool(ctx: SubstreamToolContext): ToolHandler {
  return {
    name: 'exit_substream',
    description:
      'Leave the current substream. Activations will return to the parent channel. ' +
      'Also disables autotrigger if active (since the context would change).',
    parameters: {},
    handler: async (): Promise<string> => {
      return ctx.exitSubstream();
    },
  };
}

export function createSetAutotriggerTool(ctx: SubstreamToolContext): ToolHandler {
  return {
    name: 'set_autotrigger',
    description:
      'Enable or disable your autotrigger reactivation loop. When enabled, you will be ' +
      'reactivated after each cycle — but you must call continue_substream each cycle to ' +
      'keep going. Works with or without an active substream.',
    parameters: {
      enabled: {
        type: 'boolean',
        description: 'true to enable, false to disable',
      },
      max_speech_only: {
        type: 'number',
        description: 'Safety net: max consecutive speech-only cycles before auto-ejection (default: 5)',
      },
    },
    handler: async (input: Record<string, any>): Promise<string> => {
      const enabled = input.enabled;
      if (typeof enabled !== 'boolean') {
        return 'Error: enabled (boolean) is required';
      }
      const maxSpeechOnly = typeof input.max_speech_only === 'number' ? input.max_speech_only : undefined;
      return ctx.setAutotrigger(enabled, maxSpeechOnly);
    },
  };
}
