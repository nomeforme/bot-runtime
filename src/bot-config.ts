/**
 * Bot configuration types and loader.
 *
 * Reads the existing v1 config.json format (shared with discord-axon) and
 * extracts a single bot's configuration, merging in environment variables.
 */

import fs from 'fs';
import path from 'path';
import type { MCPServerConfig } from '@connectome/grpc-common';

// ---------------------------------------------------------------------------
// Tool config — unified definition for all tool types
// ---------------------------------------------------------------------------

/** CLI tool: wraps an executable binary */
export interface CliToolConfig {
  type: 'cli';
  /** Unique name (e.g. "polymarket") */
  name: string;
  /** Path or name of the binary (resolved via PATH) */
  binary: string;
  /** Description shown to the agent */
  description: string;
  /** Args prepended to every invocation (e.g. ["-o", "json"]) */
  default_args?: string[];
  /** Optional whitelist of allowed first arguments */
  allowed_subcommands?: string[];
  /** Execution timeout in ms (default 30000) */
  timeout_ms?: number;
  /** Environment variables to set for the process */
  env?: Record<string, string>;
}

/** HTTP tool: fetches a URL */
export interface HttpToolConfig {
  type: 'http';
  /** Unique name (e.g. "fetch") */
  name: string;
  /** Description shown to the agent */
  description: string;
  /** Timeout in ms (default 30000) */
  timeout_ms?: number;
  /** Default User-Agent header */
  user_agent?: string;
  /** Max response body bytes to return (default 50000 chars) */
  max_response_length?: number;
}

/** Terminal tool: PTY-based shell execution */
export interface TerminalToolConfig {
  type: 'terminal';
  /** Unique name (e.g. "terminal" or "process") */
  name: string;
  /** Description shown to the agent */
  description: string;
  /** Default working directory (default: process.cwd()) */
  default_cwd?: string;
  /** Execution timeout in ms (default 120000) */
  timeout_ms?: number;
  /** Max output characters to return (default 50000) */
  max_output_chars?: number;
}

/** Delegate tool: cross-bot task delegation via VEIL activations */
export interface DelegateToolConfig {
  type: 'delegate';
  /** Unique name (e.g. "delegate") */
  name: string;
  /** Description shown to the agent */
  description: string;
}

/** Union of all tool config types */
export type ToolConfig = CliToolConfig | HttpToolConfig | TerminalToolConfig | DelegateToolConfig;

/** Remote compute host reachable via SSH over Tailscale */
export interface ComputeHost {
  name: string;
  /** Tailscale hostname or IP */
  host: string;
  user: string;
  capabilities?: string[];
  /** Remote workspace root (default: ~/workspace) */
  workspaceDir?: string;
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/** RLM (recursive sub-agent) configuration */
export interface RlmConfig {
  maxDepth?: number;
  maxCalls?: number;
  budget?: number;
  timeoutSeconds?: number;
  model?: string;
  childModel?: string;
  cwd?: string;
}

/** Per-bot configuration extracted from registry + env */
export interface BotRuntimeConfig {
  /** Bot display name (used as agent ID) */
  name: string;
  /** Pi-ai model identifier */
  model: string;
  /** System prompt (or "Standard" for default) */
  prompt?: string;
  /** Skip identity injection in system prompt */
  skip_identity_prompt?: boolean;
  /** Max output tokens per API call */
  max_tokens?: number;
  /** Tool names this bot should use (references global tool_configs) */
  tools?: string[];
  /** Paths to skill directories */
  skill_paths?: string[];
  /** RLM configuration */
  rlm?: RlmConfig;
  /** Enable prompt caching (default true) */
  prompt_caching?: boolean;
  /** MCP server names this bot should use */
  mcp?: string[];
  /** Global MCP server configurations */
  mcp_servers?: MCPServerConfig[];
  /** Global tool configurations (resolved from registry) */
  tool_configs?: ToolConfig[];

  // Connectome
  connectome_host: string;
  connectome_port: number;

  // Axon bindings — advertise credentials to axons
  axon_bindings?: AxonBindingConfig[];

  // Compute hosts — remote machines reachable via SSH (from COMPUTE_HOSTS env)
  compute_hosts?: ComputeHost[];

  // Runtime settings
  max_conversation_frames?: number;
  max_message_length?: number;
  random_reply_chance?: number;
  max_bot_mentions_per_conversation?: number;
}

/** Axon binding config: which axon to advertise credentials to */
export interface AxonBindingConfig {
  /** Platform identifier: "discord" | "signal" */
  platform: string;
  /** Axon binding server host:port (e.g. "discord-axon:50052") */
  axon_host: string;
  /** Platform-specific credentials (token, phone, uuid, etc.) */
  credentials: Record<string, string>;
}

/** V1 config.json format (shared with discord-axon and signal-axon) */
interface V1BotEntry {
  name: string;
  model?: string;
  prompt?: string;
  skip_identity_prompt?: boolean;
  max_tokens?: number;
  tools?: string[];
  mcp?: string[];
  prompt_caching?: boolean;
  guild_id?: string | null;
  auto_join_channels?: string[];
  skill_paths?: string[];
  rlm?: RlmConfig;
}

interface V1Config {
  active_bots?: string[];
  bots: V1BotEntry[];
  mcp_servers?: MCPServerConfig[];
  tool_configs?: ToolConfig[];
  max_conversation_frames?: number;
  max_bot_mentions_per_conversation?: number;
  random_reply_chance?: number;
  max_message_length?: number;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load a single bot's configuration from a v1 registry config.json.
 *
 * @param registryPath  Path to config.json
 * @param botName       Name of the bot to extract
 * @param env           Process environment (for tokens, host, etc.)
 */
export function loadBotConfig(
  registryPath: string,
  botName: string,
  env: NodeJS.ProcessEnv = process.env,
): BotRuntimeConfig {
  // Read and parse registry
  const raw = fs.readFileSync(path.resolve(registryPath), 'utf8');
  const registry: V1Config = JSON.parse(raw);

  // Find the bot entry
  const botEntry = registry.bots.find((b) => b.name === botName);
  if (!botEntry) {
    const available = registry.bots.map((b) => b.name).join(', ');
    throw new Error(`Bot "${botName}" not found in registry. Available: ${available}`);
  }

  // Parse gRPC host from env
  const grpcHostEnv = env.CONNECTOME_GRPC_HOST || 'localhost:50051';
  const [host, portStr] = grpcHostEnv.split(':');
  const port = parseInt(portStr) || 50051;

  return {
    name: botEntry.name,
    model: botEntry.model || 'claude-sonnet-4-20250514',
    prompt: botEntry.prompt,
    skip_identity_prompt: botEntry.skip_identity_prompt,
    max_tokens: botEntry.max_tokens,
    tools: botEntry.tools,
    skill_paths: botEntry.skill_paths,
    rlm: botEntry.rlm,
    prompt_caching: botEntry.prompt_caching,
    mcp: botEntry.mcp,
    mcp_servers: registry.mcp_servers,
    tool_configs: registry.tool_configs,
    connectome_host: host,
    connectome_port: port,
    max_conversation_frames: registry.max_conversation_frames,
    max_message_length: registry.max_message_length,
    random_reply_chance: registry.random_reply_chance,
    max_bot_mentions_per_conversation: registry.max_bot_mentions_per_conversation,
    axon_bindings: buildAxonBindings(env),
    compute_hosts: buildComputeHosts(env),
  };
}

/**
 * Build axon bindings from env vars.
 * DISCORD_TOKEN + DISCORD_AXON_HOST → discord binding
 * SIGNAL_PHONE + SIGNAL_AXON_HOST → signal binding
 */
function buildAxonBindings(env: NodeJS.ProcessEnv): AxonBindingConfig[] {
  const bindings: AxonBindingConfig[] = [];

  if (env.DISCORD_TOKEN && env.DISCORD_AXON_HOST) {
    bindings.push({
      platform: 'discord',
      axon_host: env.DISCORD_AXON_HOST,
      credentials: { token: env.DISCORD_TOKEN },
    });
  }

  if (env.SIGNAL_PHONE && env.SIGNAL_AXON_HOST) {
    const creds: Record<string, string> = { phone: env.SIGNAL_PHONE };
    if (env.SIGNAL_UUID) {
      creds.uuid = env.SIGNAL_UUID;
    }
    bindings.push({
      platform: 'signal',
      axon_host: env.SIGNAL_AXON_HOST,
      credentials: creds,
    });
  }

  return bindings;
}

/**
 * Build compute hosts from COMPUTE_HOSTS env var.
 * Format: name:host:user:cap1+cap2+cap3,...
 * Example: COMPUTE_HOSTS=dream:REDACTED_IP:root:gpu+cuda+python3,other:10.0.0.5:coder:cpu
 * User defaults to "root", capabilities are optional.
 */
function buildComputeHosts(env: NodeJS.ProcessEnv): ComputeHost[] {
  const hostsStr = env.COMPUTE_HOSTS;
  if (!hostsStr) return [];

  return hostsStr.split(',').map((entry) => {
    const parts = entry.trim().split(':');
    const [name, host, user, caps] = parts;
    if (!name || !host) return null;

    const capabilities = caps ? caps.split('+').map((c) => c.trim()) : undefined;

    return { name, host, user: user || 'root', capabilities };
  }).filter(Boolean) as ComputeHost[];
}

/**
 * Parse --registry and --bot from process.argv.
 * Returns { registryPath, botName }.
 */
export function parseCliArgs(argv: string[] = process.argv): {
  registryPath: string;
  botName: string;
} {
  let registryPath = '';
  let botName = '';

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--registry' && argv[i + 1]) {
      registryPath = argv[++i];
    } else if (argv[i] === '--bot' && argv[i + 1]) {
      botName = argv[++i];
    }
  }

  // Fall back to env vars
  if (!registryPath) {
    registryPath = process.env.BOT_REGISTRY || 'config.json';
  }
  if (!botName) {
    botName = process.env.BOT_NAME || '';
  }

  if (!botName) {
    throw new Error('Bot name required: use --bot <name> or BOT_NAME env var');
  }

  return { registryPath, botName };
}
