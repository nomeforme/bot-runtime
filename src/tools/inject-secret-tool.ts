/**
 * inject_secret tool — pipe a named secret to a remote machine's .env file
 * without exposing the value to the LLM context.
 *
 * Secrets are stored by the !secret axon command in /workspace/shared/secrets/.
 * This tool reads the value and pipes it over SSH to the target path.
 * The LLM never sees the secret value — only the name and result.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { ToolHandler } from '@connectome/agent-core';
import type { ComputeHost } from '../bot-config.js';

const SECRETS_DIR = '/workspace/shared/secrets';

export function createInjectSecretTool(computeHosts: ComputeHost[]): ToolHandler {
  const hostList = computeHosts.map(h => h.name).join(', ') || 'none configured';

  return {
    name: 'inject_secret',
    description: `Inject a stored secret into a remote .env file without exposing the value. Secrets are stored via the !secret command. Available hosts: ${hostList}. The secret value never appears in the response — only success/failure.`,
    parameters: {
      secret_name: {
        type: 'string',
        description: 'Name of the stored secret (e.g. HF_TOKEN)',
      },
      host: {
        type: 'string',
        description: `Remote host to inject into (${hostList})`,
      },
      env_file: {
        type: 'string',
        description: 'Path to the .env file on the remote host (e.g. ~/kohya/.env)',
      },
      env_var_name: {
        type: 'string',
        description: 'Environment variable name to use in the .env file. Defaults to the secret name.',
      },
      append: {
        type: 'boolean',
        description: 'If true, append to existing .env. If false (default), replace the line if it exists or append if not.',
      },
    },
    required: ['secret_name', 'host', 'env_file'],
    handler: async (input: Record<string, any>): Promise<string> => {
      const { secret_name, host, env_file, env_var_name, append } = input;
      const varName = env_var_name || secret_name;

      // Validate secret exists
      let secretValue: string;
      try {
        secretValue = readFileSync(join(SECRETS_DIR, secret_name), 'utf-8').trim();
      } catch {
        // List available secrets to help the bot
        try {
          const available = readdirSync(SECRETS_DIR);
          return `Error: Secret "${secret_name}" not found. Available: ${available.join(', ') || 'none'}`;
        } catch {
          return `Error: Secret "${secret_name}" not found. No secrets stored. Use !secret <name> <value> to store one.`;
        }
      }

      // Validate host
      const hostConfig = computeHosts.find(h => h.name === host);
      if (!hostConfig) {
        return `Error: Host "${host}" not found. Available: ${hostList}`;
      }

      // Inject: use SSH to write/update the .env file
      // The secret value is piped via stdin — never appears in the command string
      try {
        const sshTarget = `${hostConfig.user}@${hostConfig.host}`;
        const sshCmd = `ssh -i /root/.ssh/id_ed25519_new -o StrictHostKeyChecking=no ${sshTarget}`;

        if (append) {
          // Simple append
          execSync(`echo "${varName}=\$(cat)" | ${sshCmd} "cat >> ${env_file}"`, {
            input: secretValue,
            timeout: 15000,
          });
        } else {
          // Replace existing line or append
          // Uses sed to replace if exists, appends if not
          const script = `
            if grep -q "^${varName}=" ${env_file} 2>/dev/null; then
              sed -i "s|^${varName}=.*|${varName}=\$(cat)|" ${env_file}
            else
              echo "${varName}=\$(cat)" >> ${env_file}
            fi
          `;
          // Pipe the secret value through stdin to avoid it appearing in process args
          execSync(`${sshCmd} 'VALUE=$(cat); FILE="${env_file}"; VAR="${varName}"; if grep -q "^$VAR=" "$FILE" 2>/dev/null; then sed -i "s|^$VAR=.*|$VAR=$VALUE|" "$FILE"; else echo "$VAR=$VALUE" >> "$FILE"; fi'`, {
            input: secretValue,
            timeout: 15000,
          });
        }

        return `Injected ${varName} into ${host}:${env_file} (${secretValue.length} chars, value not shown)`;
      } catch (err: any) {
        return `Error injecting secret: ${err.message}`;
      }
    },
  };
}
