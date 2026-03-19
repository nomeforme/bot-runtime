/**
 * Terminal tool — PTY-based shell execution for the LLM.
 *
 * Supports foreground (wait for completion) and background (return session_id) modes.
 * Uses the shared ProcessRegistry for lifecycle management.
 */

import type { ToolHandler } from '@connectome/agent-core';
import type { ProcessRegistry, SpawnOptions } from '../process-registry.js';
import type { ComputeHost } from '../bot-config.js';

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
  /** Incoming attachments from the current context (populated by ConnectomeBridge) */
  incomingAttachments?: Array<{
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
  computeHosts: ComputeHost[] = [],
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
      host: {
        type: 'string',
        description: computeHosts.length > 0
          ? `Remote machine to execute on via SSH. IMPORTANT: You MUST use this parameter to run commands on remote hosts — do NOT use raw "ssh" commands, because Tailscale DNS hostnames cannot be resolved from inside this container. The host parameter handles SSH routing automatically. Available: ${computeHosts.map((h) => `${h.name} [${h.capabilities?.join(', ') || 'general'}] (workspace: ${h.workspaceDir || `/home/${h.user}/workspace`})`).join('; ')}. Local workspace is /workspace/shared/. Omit for local execution.`
          : 'Remote machine name to execute on via SSH (if configured). Omit for local execution.',
      },
      push: {
        type: 'string',
        description: 'Rsync local path to remote workspace BEFORE execution (e.g. "myproject/" syncs /workspace/shared/myproject/ to remote workspace). Only works with host.',
      },
      pull: {
        type: 'string',
        description: 'Rsync remote path to local workspace AFTER execution (e.g. "output/" syncs remote workspace/output/ to /workspace/shared/output/). Only works with host.',
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

      // Resolve remote host if specified
      let actualCommand = command;
      if (input.host) {
        const host = computeHosts.find((h) => h.name === input.host);
        if (!host) {
          const available = computeHosts.map((h) => h.name).join(', ') || '(none configured)';
          return `Error: Unknown compute host "${input.host}". Available: ${available}`;
        }
        const remoteCwd = input.workdir || host.workspaceDir || `/home/${host.user}/workspace`;
        const sshTarget = `${host.user}@${host.host}`;
        const sshBase = `ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10`;

        // Build compound command: push → execute → pull
        const parts: string[] = [];

        if (input.push) {
          const localPath = `${defaultCwd}/${input.push}`.replace(/\/+$/, '') + '/';
          const remotePath = `${remoteCwd}/${input.push}`.replace(/\/+$/, '') + '/';
          // Ensure remote dir exists, then rsync
          parts.push(`${sshBase} ${sshTarget} ${shellEscape(`mkdir -p ${remotePath}`)}`);
          parts.push(`rsync -az -e ${shellEscape(sshBase)} ${shellEscape(localPath)} ${sshTarget}:${shellEscape(remotePath)}`);
        }

        const remoteCmd = `cd ${shellEscape(remoteCwd)} && ${command}`;
        parts.push(`${sshBase} ${sshTarget} ${shellEscape(remoteCmd)}`);

        if (input.pull) {
          const remotePath = `${remoteCwd}/${input.pull}`.replace(/\/+$/, '') + '/';
          const localPath = `${defaultCwd}/${input.pull}`.replace(/\/+$/, '') + '/';
          parts.push(`mkdir -p ${shellEscape(localPath)}`);
          parts.push(`rsync -az -e ${shellEscape(sshBase)} ${sshTarget}:${shellEscape(remotePath)} ${shellEscape(localPath)}`);
        }

        actualCommand = parts.join(' && ');
      }

      try {
        // Pass VEIL context for background processes (emit speech on exit)
        const spawnOpts: SpawnOptions = { cwd, pty: usePty };
        if (background && veilCtx.streamId) {
          spawnOpts.streamId = veilCtx.streamId;
          spawnOpts.grpcClient = veilCtx.grpcClient;
          spawnOpts.agentId = veilCtx.agentId;
          spawnOpts.agentName = veilCtx.agentName;
        }
        const session = registry.spawn(actualCommand, spawnOpts);

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

/** Escape a string for safe use as a single shell argument. */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
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
