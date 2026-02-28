/**
 * Delegate tool — cross-bot task delegation via VEIL activations.
 *
 * Lets a bot send a task to another bot (by name or capability).
 * Uses the existing activation pipeline: emitEvent('agent:activate') →
 * server creates agent-activation facet → target bot's fireActivation() picks it up.
 */

import { randomBytes } from 'crypto';
import type { ConnectomeClient } from '@connectome/grpc-common';
import type { ToolHandler } from '@connectome/agent-core';
import type { DelegateToolConfig } from '../bot-config.js';

/**
 * Mutable activation context — set by BotRuntime before each activation
 * so the delegate tool can link workspace streams to the triggering stream.
 */
export interface DelegateActivationContext {
  streamId?: string;
}

export function createDelegateTool(
  config: DelegateToolConfig,
  grpcClient: ConnectomeClient,
  agentName: string,
  agentId: string,
  activationCtx: DelegateActivationContext = {},
): ToolHandler {
  return {
    name: config.name,
    description: config.description,
    parameters: {
      task: {
        type: 'string',
        description: 'What to do (becomes the activation message)',
      },
      target_bot: {
        type: 'string',
        description: 'Specific bot name (e.g. "claude-sonnet-4-6")',
      },
      capabilities: {
        type: 'array',
        description: 'Match by capability instead of name (e.g. ["search", "web"])',
      },
      workspace: {
        type: 'string',
        description: 'Project name — creates/reuses workspace:{name} stream',
      },
      workdir: {
        type: 'string',
        description: 'Subdirectory within /workspace/shared/ for the task',
      },
    },
    required: ['task'],
    handler: async (input: Record<string, any>): Promise<string> => {
      const task = input.task;
      if (!task) return 'Error: No task provided';

      const suffix = randomBytes(3).toString('hex');
      const streamId = input.workspace
        ? `workspace:${input.workspace}`
        : `workspace:${agentId}:delegate-${suffix}`;

      const workdir = input.workdir
        ? `/workspace/shared/${input.workdir}`
        : `/workspace/shared/${input.workspace || 'default'}`;

      // Parent stream = the stream that triggered this activation
      const parentStreamId = activationCtx.streamId;

      try {
        // Create workspace stream with parent linkage (inherits context up to fork point)
        await grpcClient.createStream(streamId, 'workspace', {
          createdBy: agentName,
          purpose: task,
        }, parentStreamId);

        // Emit agent-activation targeting the other bot
        await grpcClient.emitEvent('agent:activate', {
          reason: task,
          targetBot: input.target_bot,
          capabilities: input.capabilities,
          streamId,
          messageContent: task,
          authorName: agentName,
          streamType: 'workspace',
          workdir,
        });

        const target = input.target_bot || 'capable agent';
        return JSON.stringify({
          delegated: true,
          target,
          stream: streamId,
          workdir,
          message: `Task delegated to ${target} on stream ${streamId}. The target bot will work in ${workdir}.`,
        });
      } catch (err: any) {
        return `Error delegating task: ${err.message}`;
      }
    },
  };
}
