/**
 * Stream awareness tools — lets agents discover and peek at other streams.
 *
 * list_streams: Shows all registered streams in the VEIL space.
 * get_stream_context: Fetches recent conversation from a specific stream.
 *
 * These give agents pull-based cross-stream awareness: they can actively
 * seek context from other channels when relevant, without being drowned
 * in passive noise from all streams.
 */

import type { ConnectomeClient } from '@connectome/grpc-common';
import type { ToolHandler } from '@connectome/agent-core';

/** Shared context updated per-activation so tools know the current stream */
export interface StreamToolContext {
  agentId?: string;
  currentStreamId?: string;
  grpcClient?: ConnectomeClient;
}

export function createListStreamsTool(ctx: StreamToolContext): ToolHandler {
  return {
    name: 'list_streams',
    description:
      'List all active streams (channels, conversations) in this connectome space. ' +
      'Use this to discover what other channels exist before fetching their context.',
    parameters: {},
    handler: async (): Promise<string> => {
      if (!ctx.grpcClient) return 'Error: not connected to connectome';

      try {
        const snapshot = await ctx.grpcClient.getStateSnapshot({
          facetTypes: ['__none__'], // Don't load facets, just streams/agents
          timeoutMs: 10000,
        });

        if (!snapshot.streams || snapshot.streams.length === 0) {
          return 'No streams registered.';
        }

        const lines: string[] = [`${snapshot.streams.length} stream(s):\n`];
        for (const stream of snapshot.streams) {
          const isCurrent = stream.id === ctx.currentStreamId;
          const marker = isCurrent ? ' (current)' : '';
          const name = stream.name ? ` — ${stream.name}` : '';
          const parent = stream.parentId ? ` [fork of ${stream.parentId}]` : '';
          const meta = stream.metadata && Object.keys(stream.metadata).length > 0
            ? ` ${JSON.stringify(stream.metadata)}`
            : '';
          lines.push(`• ${stream.id}${name}${parent}${meta}${marker}`);
        }

        return lines.join('\n');
      } catch (error: any) {
        return `Error listing streams: ${error.message}`;
      }
    },
  };
}

export function createGetStreamContextTool(ctx: StreamToolContext): ToolHandler {
  return {
    name: 'get_stream_context',
    description:
      'Fetch recent conversation from another stream (channel). ' +
      'Use this to check what\'s happening in a different channel when relevant to the current conversation. ' +
      'Returns the last N messages from the target stream.',
    parameters: {
      stream_id: {
        type: 'string',
        description: 'The stream ID to fetch context from (use list_streams to discover IDs)',
      },
      max_messages: {
        type: 'number',
        description: 'Maximum messages to return (default: 20, max: 50)',
      },
    },
    required: ['stream_id'],
    handler: async (input: Record<string, any>): Promise<string> => {
      if (!ctx.grpcClient) return 'Error: not connected to connectome';
      if (!ctx.agentId) return 'Error: agent not registered';

      const streamId = input.stream_id;
      if (!streamId) return 'Error: stream_id is required';

      const maxMessages = Math.min(Math.max(input.max_messages || 20, 1), 50);

      try {
        const result = await ctx.grpcClient.getContext(ctx.agentId, streamId, {
          maxFrames: maxMessages * 2, // Frames don't map 1:1 to messages
          timeoutMs: 15000,
        });

        const context = result.context as any;
        const conversation: any[] = context?.conversation || [];

        if (conversation.length === 0) {
          return `No conversation found in stream ${streamId}.`;
        }

        // Take last maxMessages entries
        const messages = conversation.slice(-maxMessages);
        const lines: string[] = [`Stream ${streamId} — last ${messages.length} message(s):\n`];

        for (const msg of messages) {
          const role = msg.role || 'unknown';
          const content = msg.content || '';
          const speaker = msg.metadata?.agentName || msg.metadata?.source || '';
          const prefix = speaker ? `[${speaker}] ` : '';

          // Truncate very long messages
          const display = content.length > 500
            ? content.substring(0, 500) + '...'
            : content;

          lines.push(`${role.toUpperCase()}: ${prefix}${display}`);
        }

        return lines.join('\n');
      } catch (error: any) {
        return `Error fetching stream context: ${error.message}`;
      }
    },
  };
}
