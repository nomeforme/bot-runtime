/**
 * Process tool — manage background processes spawned by the terminal tool.
 *
 * Actions: list, poll, log, submit, kill
 */

import type { ToolHandler } from '@connectome/agent-core';
import type { ProcessRegistry } from '../process-registry.js';

export interface ProcessToolConfig {
  type: 'terminal';  // shares 'terminal' type in config — differentiated by name
  name: string;
  description: string;
}

export function createProcessTool(
  config: ProcessToolConfig,
  registry: ProcessRegistry,
): ToolHandler {
  return {
    name: config.name,
    description: config.description,
    parameters: {
      action: {
        type: 'string',
        description: 'Action: "list" | "poll" | "log" | "submit" | "kill"',
      },
      session_id: {
        type: 'string',
        description: 'Session ID (required for poll/log/submit/kill)',
      },
      data: {
        type: 'string',
        description: 'Input to send (for submit action)',
      },
      lines: {
        type: 'number',
        description: 'Number of trailing lines to return (for log action)',
      },
    },
    required: ['action'],
    handler: async (input: Record<string, any>): Promise<string> => {
      const action = input.action;

      try {
        switch (action) {
          case 'list': {
            const sessions = registry.list();
            const summary = sessions.map((s) => ({
              session_id: s.id,
              command: s.command.slice(0, 100),
              pid: s.pid,
              status: s.exited ? 'exited' : 'running',
              exit_code: s.exitCode,
              started: new Date(s.startedAt).toISOString(),
              output_length: s.outputBuffer.length,
            }));
            return JSON.stringify(summary, null, 2);
          }

          case 'poll': {
            if (!input.session_id) return 'Error: session_id required for poll';
            const poll = registry.poll(input.session_id);
            return JSON.stringify(poll);
          }

          case 'log': {
            if (!input.session_id) return 'Error: session_id required for log';
            const output = registry.log(input.session_id, input.lines);
            if (output.length > 50000) {
              return output.slice(-50000) + '\n... (truncated)';
            }
            return output || '(no output yet)';
          }

          case 'submit': {
            if (!input.session_id) return 'Error: session_id required for submit';
            if (input.data === undefined) return 'Error: data required for submit';
            registry.submit(input.session_id, input.data);
            // Brief pause to let the process react
            await new Promise((r) => setTimeout(r, 500));
            const poll = registry.poll(input.session_id);
            return JSON.stringify({
              submitted: input.data,
              ...poll,
            });
          }

          case 'kill': {
            if (!input.session_id) return 'Error: session_id required for kill';
            registry.kill(input.session_id);
            return JSON.stringify({ killed: input.session_id, status: 'terminated' });
          }

          default:
            return `Error: Unknown action "${action}". Use: list, poll, log, submit, kill`;
        }
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };
}
