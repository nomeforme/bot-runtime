/**
 * Terminal tool — PTY-based shell execution for the LLM.
 *
 * Supports foreground (wait for completion) and background (return session_id) modes.
 * Uses the shared ProcessRegistry for lifecycle management.
 */

import type { ToolHandler } from '@connectome/agent-core';
import type { ProcessRegistry, SpawnOptions } from '../process-registry.js';

export interface TerminalToolConfig {
  type: 'terminal';
  name: string;
  description: string;
  default_cwd?: string;
  timeout_ms?: number;
  max_output_chars?: number;
}

/**
 * Mutable VEIL context — set by BotRuntime before each activation
 * so background processes can emit speech facets on exit.
 */
export interface TerminalVeilContext {
  streamId?: string;
  grpcClient?: SpawnOptions['grpcClient'];
  agentId?: string;
  agentName?: string;
  pendingAttachments?: Array<{
    id: string;
    contentType: string;
    data: string;          // base64
    filename: string;
    sizeBytes: number;
  }>;
}

export function createTerminalTool(
  config: TerminalToolConfig,
  registry: ProcessRegistry,
  veilCtx: TerminalVeilContext = {},
): ToolHandler {
  const defaultCwd = config.default_cwd || process.cwd();
  const timeoutMs = config.timeout_ms ?? 120_000;
  const maxOutput = config.max_output_chars ?? 50_000;

  return {
    name: config.name,
    description: config.description,
    parameters: {
      command: {
        type: 'string',
        description: 'Shell command to execute',
      },
      background: {
        type: 'boolean',
        description: 'Run in background and return session_id (default: false)',
      },
      pty: {
        type: 'boolean',
        description: 'Use pseudo-terminal for interactive CLIs (default: true)',
      },
      workdir: {
        type: 'string',
        description: 'Working directory (default: /workspace/shared)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in ms (default: 120000, only for foreground)',
      },
    },
    required: ['command'],
    handler: async (input: Record<string, any>): Promise<string> => {
      const command = input.command;
      if (!command) return 'Error: No command provided';

      const cwd = input.workdir || defaultCwd;
      const usePty = input.pty !== false;
      const background = input.background === true;
      const timeout = input.timeout ?? timeoutMs;

      try {
        // Pass VEIL context for background processes (emit speech on exit)
        const spawnOpts: SpawnOptions = { cwd, pty: usePty };
        if (background && veilCtx.streamId) {
          spawnOpts.streamId = veilCtx.streamId;
          spawnOpts.grpcClient = veilCtx.grpcClient;
          spawnOpts.agentId = veilCtx.agentId;
          spawnOpts.agentName = veilCtx.agentName;
        }
        const session = registry.spawn(command, spawnOpts);

        if (background) {
          return JSON.stringify({
            session_id: session.id,
            pid: session.pid,
            status: 'running',
            message: `Background process started. Use the process tool to monitor: process(action="poll", session_id="${session.id}")`,
          });
        }

        // Foreground: wait for completion or timeout
        const output = await waitForExit(registry, session.id, timeout);
        const truncated = output.length > maxOutput
          ? output.slice(-maxOutput) + '\n... (output truncated, showing last ' + maxOutput + ' chars)'
          : output;

        const poll = registry.poll(session.id);
        return JSON.stringify({
          exit_code: poll.exitCode,
          output: truncated,
        });
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };
}

/** Wait for a process to exit, with timeout. */
async function waitForExit(
  registry: ProcessRegistry,
  sessionId: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const check = () => {
      const poll = registry.poll(sessionId);
      if (poll.status === 'exited') {
        resolve(registry.log(sessionId));
        return;
      }
      if (Date.now() > deadline) {
        registry.kill(sessionId);
        resolve(
          registry.log(sessionId) + '\n\n[Process killed: timeout after ' + timeoutMs + 'ms]',
        );
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}
