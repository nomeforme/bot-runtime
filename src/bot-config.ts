/**
 * Bot configuration types and loader.
 *
 * Reads the existing v1 config.json format (shared with discord-axon) and
 * extracts a single bot's configuration, merging in environment variables.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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
// Wallet config
// ---------------------------------------------------------------------------

/** Configuration for a single blockchain network */
export interface WalletChainConfig {
  chain: 'evm' | 'solana';
  network: string;          // "base", "solana-mainnet", etc.
  rpc_url: string;
  chain_id?: number;        // EVM only
}

/** Wallet configuration — chains + credential references */
export interface WalletConfig {
  chains: WalletChainConfig[];
  evm_private_key?: string;
  solana_private_key?: string;
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
  /** Skip system prompt entirely (send no system prompt to the model) */
  skip_system_prompt?: boolean;
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
  /** Force API key auth instead of OAuth (for models not on Claude subscription) */
  use_api_key?: boolean;
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

  // Wallet — on-chain capabilities (keys from Docker secrets or env)
  wallet?: WalletConfig;

  // Compute hosts — remote machines reachable via SSH (from COMPUTE_HOSTS env)
  compute_hosts?: ComputeHost[];

  // Credential isolation — API key read from Docker secret, not env var
  anthropic_api_key?: string;

  // gRPC mTLS configuration
  tls?: { caCertPath?: string; certPath?: string; keyPath?: string };

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
  skip_system_prompt?: boolean;
  max_tokens?: number;
  tools?: string[];
  mcp?: string[];
  prompt_caching?: boolean;
  use_api_key?: boolean;
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

  // Read API key from Docker secret first, fall back to env var
  const anthropicApiKey = readPlaintextSecret('anthropic_api_key', env);

  // Build TLS config from env vars
  const tls = buildTlsConfig(env);

  return {
    name: botEntry.name,
    model: botEntry.model || 'claude-sonnet-4-20250514',
    prompt: botEntry.prompt,
    skip_identity_prompt: botEntry.skip_identity_prompt,
    skip_system_prompt: botEntry.skip_system_prompt,
    max_tokens: botEntry.max_tokens,
    tools: botEntry.tools,
    skill_paths: botEntry.skill_paths,
    rlm: botEntry.rlm,
    prompt_caching: botEntry.prompt_caching,
    use_api_key: botEntry.use_api_key,
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
    wallet: buildWalletConfig(env),
    anthropic_api_key: anthropicApiKey,
    tls,
  };
}

// ---------------------------------------------------------------------------
// Secret encryption (AES-256-GCM + scrypt, zero external deps)
// ---------------------------------------------------------------------------

const ENC_SALT_LEN = 32;
const ENC_IV_LEN = 16;
const ENC_TAG_LEN = 16;
const ENC_SCRYPT_N = 16384; // 2^14 — strong KDF, ~32MB memory
const ENC_KEY_LEN = 32;
/** Required prefix on encrypted wallet secrets */
const ENC_MAGIC = 'enc:';

function decryptSecret(blob: string, masterKey: string): string {
  const combined = Buffer.from(blob.slice(ENC_MAGIC.length), 'base64');
  if (combined.length < ENC_SALT_LEN + ENC_IV_LEN + ENC_TAG_LEN + 1) {
    throw new Error('Encrypted secret too short — corrupted or wrong format');
  }
  const salt = combined.subarray(0, ENC_SALT_LEN);
  const iv = combined.subarray(ENC_SALT_LEN, ENC_SALT_LEN + ENC_IV_LEN);
  const tag = combined.subarray(ENC_SALT_LEN + ENC_IV_LEN, ENC_SALT_LEN + ENC_IV_LEN + ENC_TAG_LEN);
  const ciphertext = combined.subarray(ENC_SALT_LEN + ENC_IV_LEN + ENC_TAG_LEN);

  const key = crypto.scryptSync(masterKey, salt, ENC_KEY_LEN, {
    N: ENC_SCRYPT_N, r: 8, p: 1,
  });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
}

/**
 * Read a plaintext secret from Docker secrets file or env var fallback.
 * Docker secrets (/run/secrets/) are preferred because they don't appear
 * in process.env, /proc/<pid>/environ, or docker inspect.
 */
function readPlaintextSecret(name: string, env: NodeJS.ProcessEnv): string | undefined {
  // Docker secrets: /run/secrets/<name>
  try {
    const val = fs.readFileSync(`/run/secrets/${name}`, 'utf8').trim();
    if (val) return val;
  } catch {}
  // Fallback to env var (dev/local)
  return env[name.toUpperCase()] || undefined;
}

/**
 * Read an encrypted wallet secret from Docker secrets file or env var fallback.
 * Wallet keys MUST be encrypted (prefixed with "enc:"). Plaintext wallet keys
 * are rejected — use scripts/encrypt-secret.ts to encrypt them first.
 */
function readSecret(name: string, env: NodeJS.ProcessEnv): string | undefined {
  let raw: string | undefined;

  // Docker secrets: /run/secrets/<name>
  try { raw = fs.readFileSync(`/run/secrets/${name}`, 'utf8').trim(); } catch {}
  // Fallback to env var
  if (!raw) raw = env[name.toUpperCase()];
  if (!raw) return undefined;

  if (!raw.startsWith(ENC_MAGIC)) {
    throw new Error(
      `Secret "${name}" is plaintext — wallet keys must be encrypted at rest. ` +
      `Run: ./scripts/setup-wallet.sh --bot <name> to generate an encrypted wallet.`,
    );
  }

  const masterKey = readMasterKey(env);
  if (!masterKey) {
    throw new Error(
      `Secret "${name}" is encrypted but master key file not found. ` +
      `Mount secrets/wallet_master_key at /workspace/secrets/wallet_master_key or /run/secrets/wallet_master_key`,
    );
  }
  return decryptSecret(raw, masterKey);
}

/**
 * Read the master key from a file — NEVER from env vars.
 * The master key must not be in the process environment where
 * agent tools (terminal, process) could read it via `env` or `printenv`.
 *
 * Searched paths (first match wins):
 *   1. /run/secrets/wallet_master_key  (Docker secret)
 *   2. /workspace/secrets/wallet_master_key  (bind-mounted file)
 */
function readMasterKey(_env: NodeJS.ProcessEnv): string | undefined {
  const paths = [
    '/run/secrets/wallet_master_key',
    '/workspace/secrets/wallet_master_key',
  ];
  for (const p of paths) {
    try { return fs.readFileSync(p, 'utf8').trim(); } catch {}
  }
  return undefined;
}

/**
 * Build wallet config from secrets + WALLET_CHAINS env var.
 * Format: WALLET_CHAINS=evm|base|https://mainnet.base.org|8453,solana|mainnet|https://api.mainnet-beta.solana.com
 */
function buildWalletConfig(env: NodeJS.ProcessEnv): WalletConfig | undefined {
  const evmKey = readSecret('evm_private_key', env);
  const solKey = readSecret('solana_private_key', env);
  if (!evmKey && !solKey) return undefined;

  const chains: WalletChainConfig[] = [];
  const chainsStr = env.WALLET_CHAINS || '';
  for (const entry of chainsStr.split(',').filter(Boolean)) {
    const [chain, network, rpc_url, chainIdStr] = entry.trim().split('|');
    if (chain && network && rpc_url) {
      chains.push({
        chain: chain as 'evm' | 'solana',
        network,
        rpc_url,
        chain_id: chainIdStr ? parseInt(chainIdStr) : undefined,
      });
    }
  }

  return { chains, evm_private_key: evmKey, solana_private_key: solKey };
}

/**
 * Build TLS config from env vars.
 * GRPC_TLS=true enables mTLS. Cert paths default to /workspace/certs/.
 */
function buildTlsConfig(env: NodeJS.ProcessEnv): { caCertPath: string; certPath: string; keyPath: string } | undefined {
  if (env.GRPC_TLS !== 'true') return undefined;
  return {
    caCertPath: env.GRPC_CA_CERT || '/workspace/certs/ca.crt',
    certPath: env.GRPC_CERT || '/workspace/certs/bot-runtime.crt',
    keyPath: env.GRPC_KEY || '/workspace/certs/bot-runtime.key',
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

  if (env.WHATSAPP_PHONE && env.WHATSAPP_AXON_HOST) {
    bindings.push({
      platform: 'whatsapp',
      axon_host: env.WHATSAPP_AXON_HOST,
      credentials: { phone: env.WHATSAPP_PHONE },
    });
  }

  return bindings;
}

/**
 * Build compute hosts from COMPUTE_HOSTS env var.
 * Format: name:host:user:cap1+cap2+cap3,...
 * Example: COMPUTE_HOSTS=dream:HOST:root:gpu+cuda+python3,other:HOST:coder:cpu
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
