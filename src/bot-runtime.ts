/**
 * BotRuntime — lifecycle orchestrator for a single standalone bot.
 *
 * Pure cognitive loop: receives activations via gRPC subscription,
 * runs the agent, records speech back through VEIL. No platform clients.
 *
 * Composes:
 * - ConnectomeAgent (LLM + tools + skills)
 * - ConnectomeEffector (activation → cycle → delivery)
 * - ConnectomeBridge (gRPC context provider + speech recorder)
 */

import { execFile } from 'child_process';
import { ConnectomeClient, MCPManager } from '@connectome/grpc-common';
import type { MCPServerConfig, FacetDelta } from '@connectome/grpc-common';
import {
  ConnectomeAgent,
  ConnectomeEffector,
  resolveModel,
} from '@connectome/agent-core';
import type { ToolHandler, UnifiedActivation } from '@connectome/agent-core';
import type { BotRuntimeConfig, ToolConfig, CliToolConfig, HttpToolConfig, TerminalToolConfig } from './bot-config.js';
import { ConnectomeBridge } from './connectome-bridge.js';
import { NullPlatformAdapter } from './adapters/null-adapter.js';
import { ProcessRegistry } from './process-registry.js';
import { createTerminalTool } from './tools/terminal-tool.js';
import { createProcessTool } from './tools/process-tool.js';
import { createDelegateTool } from './tools/delegate-tool.js';

export class BotRuntime {
  private config: BotRuntimeConfig;
  private grpcClient: ConnectomeClient;
  private agent?: ConnectomeAgent;
  private effector?: ConnectomeEffector;
  private bridge?: ConnectomeBridge;
  private mcpManager?: MCPManager;
  private processRegistry: ProcessRegistry;
  private agentId: string;
  private unsubscribeActivations?: () => void;

  constructor(config: BotRuntimeConfig) {
    this.config = config;
    this.agentId = config.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    // Create gRPC client
    this.grpcClient = new ConnectomeClient({
      host: config.connectome_host,
      port: config.connectome_port,
      clientId: `bot-${this.agentId}`,
    });

    this.processRegistry = new ProcessRegistry();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    console.log(`\n========================================`);
    console.log(`  BotRuntime: ${this.config.name}`);
    console.log(`  Model: ${this.config.model}`);
    console.log(`  Connectome: ${this.config.connectome_host}:${this.config.connectome_port}`);
    console.log(`========================================\n`);

    // 1. Connect to Connectome via gRPC
    console.log(`[BotRuntime:${this.config.name}] Connecting to Connectome...`);
    await this.grpcClient.connect();

    // 2. Register agent
    const regResult = await this.grpcClient.registerAgent(
      `agent-bot-${this.agentId}`,
      this.config.name,
      {
        agentType: 'standalone-bot',
        capabilities: ['send-message', 'receive-message', 'tool-use'],
        metadata: {
          clientId: `bot-${this.agentId}`,
          model: this.config.model,
        },
      },
    );
    if (!regResult.success) {
      throw new Error(`Agent registration failed: ${regResult.error}`);
    }
    console.log(`[BotRuntime:${this.config.name}] Agent registered: ${regResult.agentId}`);

    // 3. Connect MCP servers (if configured)
    const toolHandlers = await this.initTools();

    // 4. Resolve model and create ConnectomeAgent
    const model = resolveModel(this.config.model);
    if (!model) {
      throw new Error(`Model not found: ${this.config.model}`);
    }

    this.agent = new ConnectomeAgent({
      name: this.config.name,
      systemPrompt: this.config.prompt || 'Standard',
      model,
      toolHandlers,
      promptCaching: this.config.prompt_caching,
      maxOutputTokens: this.config.max_tokens,
      skillPaths: this.config.skill_paths,
      rlm: this.config.rlm,
    });
    console.log(`[BotRuntime:${this.config.name}] ConnectomeAgent created (${this.config.model})`);

    // 5. Create bridge (ContextProvider + SpeechRecorder)
    this.bridge = new ConnectomeBridge({
      client: this.grpcClient,
      agentName: this.config.name,
      agentId: regResult.agentId,
      systemPrompt: this.config.prompt || 'Standard',
      skipIdentityPrompt: this.config.skip_identity_prompt,
    });

    // 6. Create effector with NullPlatformAdapter (no direct platform delivery)
    this.effector = new ConnectomeEffector({
      agent: this.agent,
      adapter: new NullPlatformAdapter(),
      contextProvider: this.bridge,
      speechRecorder: this.bridge,
      maxFrames: this.config.max_conversation_frames ?? 100,
      onError: (error, activation) => {
        console.error(
          `[BotRuntime:${this.config.name}] Cycle error on ${activation.streamId}: ${error.message}`,
        );
      },
    });

    // 7. Subscribe to activation events via gRPC
    this.subscribeToActivations();

    console.log(`\n[BotRuntime:${this.config.name}] Started successfully\n`);
  }

  async stop(): Promise<void> {
    console.log(`[BotRuntime:${this.config.name}] Stopping...`);

    // Unsubscribe from activations
    if (this.unsubscribeActivations) {
      this.unsubscribeActivations();
      this.unsubscribeActivations = undefined;
    }

    // Kill all managed processes
    this.processRegistry.destroy();

    // Disconnect MCP servers
    if (this.mcpManager) {
      await this.mcpManager.disconnectAll();
    }

    // Disconnect from Connectome
    this.grpcClient.disconnect();

    console.log(`[BotRuntime:${this.config.name}] Stopped`);
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  getAgent(): ConnectomeAgent | undefined {
    return this.agent;
  }

  getEffector(): ConnectomeEffector | undefined {
    return this.effector;
  }

  getBridge(): ConnectomeBridge | undefined {
    return this.bridge;
  }

  getGrpcClient(): ConnectomeClient {
    return this.grpcClient;
  }

  // ---------------------------------------------------------------------------
  // Activation subscription
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to agent-activation + rendered-context facets via gRPC.
   * Pairs them by activationId and fires effector.handleActivation().
   * Mirrors discord-axon/src/grpc/client.ts:342-410.
   */
  private subscribeToActivations(): void {
    const pendingActivations = new Map<string, any>();  // activationId -> facet
    const pendingContexts = new Map<string, any>();     // activationId -> context facet

    this.unsubscribeActivations = this.grpcClient.subscribe(
      {
        filters: [
          { types: ['agent-activation'] },
          { types: ['rendered-context'] },
        ],
        includeExisting: false,
        streamIds: [],
      },
      (delta: FacetDelta) => {
        if (delta.type !== 'added' || !delta.facet) return;

        const facet = delta.facet;

        if (facet.type === 'agent-activation') {
          const activationId = facet.id;

          // Check if we already have context for this activation
          const context = pendingContexts.get(activationId);
          if (context) {
            pendingContexts.delete(activationId);
            this.fireActivation(facet, context);
          } else {
            pendingActivations.set(activationId, facet);
            setTimeout(() => pendingActivations.delete(activationId), 30000);
          }
        } else if (facet.type === 'rendered-context') {
          const activationId = facet.state?.activationId;
          if (!activationId) {
            console.warn(`[BotRuntime:${this.config.name}] Received rendered-context without activationId, skipping`);
            return;
          }

          const activation = pendingActivations.get(activationId);
          if (activation) {
            pendingActivations.delete(activationId);
            this.fireActivation(activation, facet);
          } else {
            pendingContexts.set(activationId, facet);
            setTimeout(() => pendingContexts.delete(activationId), 30000);
          }
        }
      },
    );

    console.log(`[BotRuntime:${this.config.name}] Subscribed to activation events`);
  }

  /**
   * Build UnifiedActivation from paired facets and dispatch to the effector.
   */
  private fireActivation(activationFacet: any, _contextFacet: any): void {
    if (!this.effector) return;

    const streamId = activationFacet.streamId;
    const state = activationFacet.state || {};

    // Filter: only handle activations targeted at this bot
    const targetBot = state.metadata?.targetBot;
    if (targetBot && targetBot !== this.config.name) {
      return;
    }

    const activation: UnifiedActivation = {
      streamId,
      platformContext: {
        streamId,
        streamType: state.metadata?.streamType || 'veil',
        platformData: state.metadata || {},
      },
      messageContent: state.metadata?.messageContent || '',
      authorName: state.metadata?.authorName || 'system',
    };

    console.log(`[BotRuntime:${this.config.name}] Activation on ${streamId} (reason: ${state.reason || 'unknown'})`);

    this.effector.handleActivation(activation).catch((err) => {
      console.error(`[BotRuntime:${this.config.name}] Activation error on ${streamId}: ${err.message}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /** Initialize tools from config: tool_configs (cli/http) + MCP servers */
  private async initTools(): Promise<ToolHandler[]> {
    const toolHandlers: ToolHandler[] = [];
    const requestedTools = this.config.tools ?? [];
    const allConfigs = this.config.tool_configs ?? [];

    // Resolve each requested tool name against tool_configs
    for (const toolName of requestedTools) {
      const toolConfig = allConfigs.find((t) => t.name === toolName);
      if (!toolConfig) {
        console.warn(`[BotRuntime:${this.config.name}] Tool "${toolName}" not found in tool_configs, skipping`);
        continue;
      }
      toolHandlers.push(this.createToolFromConfig(toolConfig));
      console.log(`[BotRuntime:${this.config.name}] ${toolConfig.type} tool "${toolName}" enabled`);
    }

    // MCP servers
    if (this.config.mcp_servers && this.config.mcp_servers.length > 0 &&
        this.config.mcp && this.config.mcp.length > 0) {
      this.mcpManager = new MCPManager();

      const relevantServers = this.config.mcp_servers.filter(
        (s: MCPServerConfig) => this.config.mcp!.includes(s.name),
      );

      if (relevantServers.length > 0) {
        await this.mcpManager.connectAll(relevantServers);
        const mcpTools = this.mcpManager.getAllToolHandlers();
        toolHandlers.push(...(mcpTools as unknown as ToolHandler[]));
        console.log(`[BotRuntime:${this.config.name}] ${mcpTools.length} MCP tool(s) from [${this.config.mcp.join(', ')}]`);
      }
    }

    return toolHandlers;
  }

  /** Dispatch tool creation by config type, with access to runtime instances */
  private createToolFromConfig(config: ToolConfig): ToolHandler {
    switch (config.type) {
      case 'cli':  return createCliTool(config);
      case 'http': return createHttpTool(config);
      case 'terminal':
        // Differentiate terminal vs process by name
        if (config.name === 'process') {
          return createProcessTool(config, this.processRegistry);
        }
        return createTerminalTool(config, this.processRegistry);
      case 'delegate':
        return createDelegateTool(config, this.grpcClient, this.config.name, this.agentId);
      default:
        throw new Error(`Unknown tool type: ${(config as any).type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone tool factories (cli, http) — no runtime dependencies
// ---------------------------------------------------------------------------

/** HTTP fetch tool — config-driven replacement for the old hardcoded createFetchTool */
function createHttpTool(config: HttpToolConfig): ToolHandler {
  const timeoutMs = config.timeout_ms ?? 30000;
  const userAgent = config.user_agent ?? 'Mozilla/5.0 (compatible; ConnectomeBot/1.0)';
  const maxLen = config.max_response_length ?? 50000;

  return {
    name: config.name,
    description: config.description,
    parameters: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from (must be a valid HTTP/HTTPS URL)',
      },
    },
    handler: async (input: Record<string, any>): Promise<string> => {
      const url = input.url;
      if (!url) return 'Error: No URL provided';

      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'User-Agent': userAgent },
          redirect: 'follow',
        });

        if (!response.ok) {
          return `Error fetching ${url}: HTTP ${response.status} ${response.statusText}`;
        }

        const text = await response.text();
        const content = text.substring(0, maxLen);
        return content;
      } catch (error: any) {
        return `Error fetching ${url}: ${error.message}`;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// CLI tool helpers
// ---------------------------------------------------------------------------

/**
 * Parse a command string into an args array, respecting quoted strings.
 * "markets search \"US election\" --limit 5" → ["markets", "search", "US election", "--limit", "5"]
 */
function parseArgs(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

/** CLI tool: executes a binary via execFile (no shell) with subcommand whitelist */
function createCliTool(config: CliToolConfig): ToolHandler {
  const timeoutMs = config.timeout_ms ?? 30000;

  return {
    name: config.name,
    description: config.description,
    parameters: {
      command: {
        type: 'string',
        description: `Arguments to pass to the ${config.name} CLI (e.g. "markets search bitcoin --limit 5")`,
      },
    },
    handler: async (input: Record<string, any>): Promise<string> => {
      const command = input.command;
      if (!command) return `Error: No command provided for ${config.name}`;

      const userArgs = parseArgs(command);

      // Subcommand whitelist check
      if (config.allowed_subcommands && config.allowed_subcommands.length > 0) {
        const firstArg = userArgs[0];
        if (firstArg && !config.allowed_subcommands.includes(firstArg)) {
          return `Error: "${firstArg}" is not an allowed subcommand for ${config.name}. Allowed: ${config.allowed_subcommands.join(', ')}`;
        }
      }

      const finalArgs = [...(config.default_args || []), ...userArgs];

      return new Promise<string>((resolve) => {
        const proc = execFile(
          config.binary,
          finalArgs,
          {
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
            env: config.env ? { ...process.env, ...config.env } : undefined,
          },
          (error, stdout, stderr) => {
            if (error) {
              resolve(`Error running ${config.name}: ${stderr?.trim() || error.message}`);
              return;
            }
            const output = (stdout || '').trim();
            if (!output) {
              resolve(`${config.name}: (no output)`);
              return;
            }
            resolve(output.length > 50000
              ? output.substring(0, 50000) + '\n... (truncated)'
              : output);
          },
        );

        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
        }, timeoutMs + 5000);
      });
    },
  };
}
