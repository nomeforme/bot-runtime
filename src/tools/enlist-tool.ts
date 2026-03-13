/**
 * Enlist tool — peer-to-peer agent activation within substreams.
 *
 * Lets an agent "enlist" another participant to activate immediately
 * with a specific task on the CURRENT stream, rather than waiting
 * for their next autotrigger cycle.
 */

import type { ConnectomeClient } from '@connectome/grpc-common';
import type { ToolHandler } from '@connectome/agent-core';

export interface EnlistToolContext {
  grpcClient?: ConnectomeClient;
  agentName?: string;
  agentId?: string;
  currentStreamId?: string;
}

export function createEnlistTool(ctx: EnlistToolContext): ToolHandler {
  return {
    name: 'enlist',
    description: 'Request another agent in this substream to activate immediately with a specific task. Use when you need a peer to act now rather than waiting for their next cycle.',
    parameters: {
      agent: {
        type: 'string',
        description: 'Name of the agent to enlist (e.g. "opus4.5")',
      },
      task: {
        type: 'string',
        description: 'Description of what you need the agent to do',
      },
    },
    handler: async (input: Record<string, any>): Promise<string> => {
      const { agent, task } = input;
      if (!agent) return 'Error: agent name is required';
      if (!task) return 'Error: task description is required';
      if (!ctx.grpcClient) return 'Error: not connected to Connectome';
      if (!ctx.currentStreamId) return 'Error: no active stream';

      const agentId = `agent-bot-${agent.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

      try {
        const result = await ctx.grpcClient.activateAgent(
          agentId,
          ctx.currentStreamId,
          {
            reason: `enlisted by ${ctx.agentName}: ${task}`,
            priority: 'high',
            metadata: {
              targetBot: agent,
              enlistedBy: ctx.agentName || 'unknown',
              task,
              streamType: 'workflow',
            },
          },
        );

        if (result.success) {
          return `Enlisted ${agent} on stream ${ctx.currentStreamId}: ${task}`;
        }
        return `Failed to enlist ${agent}: activation unsuccessful`;
      } catch (err: any) {
        return `Error enlisting ${agent}: ${err.message}`;
      }
    },
  };
}
