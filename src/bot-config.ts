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

/** Union of all tool config types */
export type ToolConfig = CliToolConfig | HttpToolConfig;

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

  // Runtime settings
  max_conversation_frames?: number;
  max_message_length?: number;
  random_reply_chance?: number;
  max_bot_mentions_per_conversation?: number;
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
  };
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
