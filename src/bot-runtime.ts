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
import { AxonBindingClient } from '@connectome/axon-binding';
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
import { createTerminalTool, type TerminalVeilContext } from './tools/terminal-tool.js';
import { createProcessTool } from './tools/process-tool.js';
import { createDelegateTool, type DelegateActivationContext } from './tools/delegate-tool.js';
import { createAttachTool } from './tools/attach-tool.js';
import { createSaveAttachmentTool } from './tools/save-attachment-tool.js';
import { createListStreamsTool, createGetStreamContextTool, type StreamToolContext } from './tools/streams-tool.js';
import { createEnlistTool, type EnlistToolContext } from './tools/enlist-tool.js';
import { createContinueSubstreamTool, createContinueSubstreamContext, type ContinueSubstreamContext } from './tools/continue-substream-tool.js';
import { createEnterSubstreamTool, createExitSubstreamTool, createSetAutotriggerTool, type SubstreamToolContext } from './tools/substream-tool.js';
import { createInitExperimentTool, createRunExperimentTool, createLogExperimentTool, createExperimentDashboardTool, type ExperimentToolContext } from './tools/experiment-tool.js';

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
  private bindingClients: AxonBindingClient[] = [];
  /** Timestamp of last facet delta received from subscription */
  private lastDeltaReceived: number = Date.now();
  /** Interval handle for subscription heartbeat check */
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  /** Mutable context shared with delegate tool — updated per activation */
  private delegateActivationCtx: DelegateActivationContext = {};
  /** Mutable context shared with terminal tool — updated per activation */
  private terminalVeilCtx: TerminalVeilContext = {};
  /** Mutable context shared with stream tools — updated per activation */
  private streamToolCtx: StreamToolContext = {};
  /** Mutable context shared with continue_substream tool — reset per activation */
  private continueSubstreamCtx: ContinueSubstreamContext = createContinueSubstreamContext();
  /** Mutable context shared with experiment tools — updated per activation */
  private experimentToolCtx: ExperimentToolContext = {};

  /** Active substream — bot's activations redirect here */
  private activeSubstream?: {
    substreamName: string;
    substreamId: string;         // "substream:<name>"
    parentStreamId: string;      // originating channel
  };

  /** Autotrigger loop state (independent of substream) */
  private autotriggerState?: {
    enabled: boolean;
    delayMs: number;
    cycleCount: number;
    /** Consecutive cycles with speech-only (no tool use) — collapse indicator */
    speechOnlyCycles: number;
    /** Max speech-only cycles before ejection (configurable via --max-speech-only) */
    maxSpeechOnly: number;
  };

  /** Stream ID of last completed activation — for tool-initiated stream entry */
  private lastActivationStreamId?: string;

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

    const systemPrompt = this.config.skip_system_prompt ? '' : (this.config.prompt || 'Standard');

    this.agent = new ConnectomeAgent({
      name: this.config.name,
      systemPrompt,
      model,
      toolHandlers,
      promptCaching: this.config.prompt_caching,
      useApiKey: this.config.use_api_key,
      maxOutputTokens: this.config.max_tokens,
      skillPaths: this.config.skip_system_prompt ? undefined : this.config.skill_paths,
      rlm: this.config.skip_system_prompt ? undefined : this.config.rlm,
    });
    console.log(`[BotRuntime:${this.config.name}] ConnectomeAgent created (${this.config.model})`);

    // 5. Create bridge (ContextProvider + SpeechRecorder)
    this.bridge = new ConnectomeBridge({
      client: this.grpcClient,
      agentName: this.config.name,
      agentId: regResult.agentId,
      systemPrompt,
      skipIdentityPrompt: this.config.skip_identity_prompt || this.config.skip_system_prompt,
      veilCtx: this.terminalVeilCtx,
    });

    // 6. Create effector with NullPlatformAdapter (no direct platform delivery)
    this.effector = new ConnectomeEffector({
      agent: this.agent,
      adapter: new NullPlatformAdapter(),
      contextProvider: this.bridge,
      speechRecorder: this.bridge,
      maxFrames: this.config.max_conversation_frames ?? 500,
      onError: (error, activation) => {
        console.error(
          `[BotRuntime:${this.config.name}] Cycle error on ${activation.streamId}: ${error.message}`,
        );
      },
      drainAttachments: () => {
        const atts = this.terminalVeilCtx.pendingAttachments || [];
        this.terminalVeilCtx.pendingAttachments = [];
        return atts;
      },
    });

    // 7. Subscribe to activation events via gRPC
    this.subscribeToActivations();

    // 8. Advertise axon bindings to axons (non-blocking)
    this.advertiseAxonBindings();

    console.log(`\n[BotRuntime:${this.config.name}] Started successfully\n`);
  }

  async stop(): Promise<void> {
    console.log(`[BotRuntime:${this.config.name}] Stopping...`);

    // Stop subscription heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    // Unsubscribe from activations
    if (this.unsubscribeActivations) {
      this.unsubscribeActivations();
      this.unsubscribeActivations = undefined;
    }

    // Kill all managed processes
    this.processRegistry.destroy();

    // Withdraw axon bindings and disconnect binding clients
    for (const client of this.bindingClients) {
      client.disconnect();
    }
    this.bindingClients = [];

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
          { types: ['bot-config'] },
          { types: ['agent-command'] },
        ],
        includeExisting: false,
        streamIds: [],
      },
      (delta: FacetDelta) => {
        // Track last delta for subscription heartbeat
        this.lastDeltaReceived = Date.now();

        if (delta.type !== 'added' || !delta.facet) return;

        const facet = delta.facet;

        // Handle bot-config events (e.g. !mt command)
        if (facet.type === 'bot-config') {
          this.handleConfigUpdate(facet);
          return;
        }

        // Handle agent-command events (e.g. !stop, !steer)
        if (facet.type === 'agent-command') {
          this.handleAgentCommand(facet);
          return;
        }

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

    // Start subscription heartbeat monitor
    this.startSubscriptionHeartbeat();
  }

  // ---------------------------------------------------------------------------
  // Subscription heartbeat
  // ---------------------------------------------------------------------------

  /** How often to check for subscription liveness (ms) */
  private static readonly HEARTBEAT_CHECK_INTERVAL = 30_000;
  /** Max silence before assuming the subscription is dead (ms) */
  private static readonly HEARTBEAT_TIMEOUT = 60_000;

  /**
   * Start a periodic check that the subscription is still alive.
   * If no facet delta has been received within HEARTBEAT_TIMEOUT,
   * verify connectivity via health check and resubscribe.
   */
  private startSubscriptionHeartbeat(): void {
    // Clear any existing heartbeat interval (e.g. from a previous subscribe cycle)
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(async () => {
      const silenceMs = Date.now() - this.lastDeltaReceived;
      if (silenceMs < BotRuntime.HEARTBEAT_TIMEOUT) return;

      const prefix = `[BotRuntime:${this.config.name}]`;
      console.log(`${prefix} Subscription heartbeat timeout — no delta in ${Math.round(silenceMs / 1000)}s, checking connectivity...`);

      // Lightweight health check to verify server is reachable
      try {
        const health = await this.grpcClient.health(5000);
        if (!health.healthy) {
          console.warn(`${prefix} Health check returned unhealthy, will retry on next heartbeat`);
          return;
        }
        console.log(`${prefix} Health check OK (seq=${health.currentSequence}) — resubscribing`);
      } catch (err: any) {
        console.warn(`${prefix} Health check failed: ${err.message} — will retry on next heartbeat`);
        return;
      }

      // Unsubscribe old stream and resubscribe
      if (this.unsubscribeActivations) {
        this.unsubscribeActivations();
        this.unsubscribeActivations = undefined;
      }

      // Reset the timestamp so we don't immediately re-trigger
      this.lastDeltaReceived = Date.now();

      console.log(`${prefix} Subscription heartbeat timeout — resubscribing`);
      this.subscribeToActivations();
    }, BotRuntime.HEARTBEAT_CHECK_INTERVAL);
  }

  /**
   * Handle a bot-config facet (e.g. from !mt command).
   */
  private handleConfigUpdate(facet: any): void {
    const state = facet.state || {};
    const targetAgent = state.targetAgent;

    // Only handle config for this bot
    if (targetAgent && targetAgent !== this.config.name) return;

    if ('maxOutputTokens' in state) {
      const value = state.maxOutputTokens === null ? undefined : state.maxOutputTokens;
      if (this.agent) {
        this.agent.setMaxOutputTokens(value);
      }
    }
  }

  /**
   * Handle an agent-command facet (e.g. !stop, !steer, !stream from chat).
   */
  private handleAgentCommand(facet: any): void {
    const state = facet.state || {};
    const targetAgent = state.targetAgent;

    // Only handle commands for this bot
    if (targetAgent && targetAgent !== this.config.name) return;

    const prefix = `[BotRuntime:${this.config.name}]`;

    switch (state.type) {
      case 'stop': {
        // Clear autotrigger state — !stop always halts autonomous loops
        if (this.autotriggerState?.enabled) {
          this.autotriggerState.enabled = false;
          console.log(`${prefix} !stop: autotrigger disabled`);
        }

        if (this.effector && this.effector.abort()) {
          console.log(`${prefix} !stop: cycle aborted`);
        } else if (!this.autotriggerState) {
          console.log(`${prefix} !stop: no active cycle to abort`);
        }

        // Clear typing indicators on both substream and parent streams
        this.emitTypingStop(this.lastActivationStreamId);
        break;
      }
      case 'steer': {
        const message = state.message;
        if (!message) {
          console.warn(`${prefix} !steer: no message provided`);
          break;
        }
        if (this.effector && this.effector.steer(message)) {
          console.log(`${prefix} !steer: injected "${message.substring(0, 80)}"`);
        } else {
          console.log(`${prefix} !steer: no active cycle to steer`);
        }

        // Also emit steer message to active substream so participants
        // see it in their context on the next cycle
        if (this.activeSubstream) {
          this.grpcClient.emitEvent('agent:speech', {
            agentName: 'system',
            agentId: 'system',
            content: `[!steer] ${message}`,
            streamId: this.activeSubstream.substreamId,
          }).catch(() => {});
        }
        break;
      }
      case 'workflow': {
        const enable = state.enable !== false;
        // Event payload uses workflowName as the wire format key
        const name = state.workflowName;
        if (enable && name) {
          const sourceStreamId = state.streamId || this.lastActivationStreamId || 'unknown';
          this.enterSubstreamInternal(name, sourceStreamId).then(() => {
            console.log(`${prefix} !stream in: entered "${name}"`);
          }).catch((err: any) => {
            console.error(`${prefix} !stream in: failed to enter "${name}": ${err.message}`);
          });
        } else {
          this.exitSubstreamInternal();
          console.log(`${prefix} !stream out`);
        }
        break;
      }
      case 'autotrigger': {
        const enable = state.enable !== false;

        if (!enable) {
          if (this.autotriggerState?.enabled) {
            this.autotriggerState.enabled = false;
          }
          console.log(`${prefix} !autotrigger off`);
          break;
        }

        // Enable autotrigger — pure loop control, no substream creation
        const maxSpeechOnly = typeof state.maxSpeechOnly === 'number'
          ? state.maxSpeechOnly
          : BotRuntime.AUTOTRIGGER_DEFAULT_MAX_SPEECH_ONLY;
        this.autotriggerState = {
          enabled: true,
          delayMs: 2000,
          cycleCount: 0,
          speechOnlyCycles: 0,
          maxSpeechOnly,
        };
        console.log(`${prefix} !autotrigger on maxSpeechOnly=${maxSpeechOnly}`);
        break;
      }
      default:
        console.warn(`${prefix} Unknown agent-command type: ${state.type}`);
    }
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

    const prefix = `[BotRuntime:${this.config.name}]`;

    // Filter: ignore activations on substreams this bot hasn't entered
    // (prevents other bots from responding to relayed messages on someone else's substream)
    if (streamId?.startsWith('substream:') &&
        (!this.activeSubstream || this.activeSubstream.substreamId !== streamId)) {
      console.log(`${prefix} Ignoring activation on foreign substream ${streamId}`);
      return;
    }

    // Activation redirect: if bot is in a stream and the activation comes
    // from the parent channel, relay the user message and redirect to the stream
    if (this.activeSubstream && streamId === this.activeSubstream.parentStreamId) {
      const messageContent = state.metadata?.messageContent;
      const authorName = state.metadata?.authorName || 'user';

      console.log(`${prefix} Redirecting activation from ${streamId} → ${this.activeSubstream.substreamId}`);

      // Relay user message as agent:speech on the substream so it appears in context
      const relayAndActivate = async () => {
        if (messageContent) {
          await this.grpcClient.emitEvent('agent:speech', {
            agentName: authorName,
            agentId: 'relay',
            content: messageContent,
            streamId: this.activeSubstream!.substreamId,
            sourceStreamId: streamId,
          });
        }

        await this.grpcClient.activateAgent(
          `agent-bot-${this.agentId}`,
          this.activeSubstream!.substreamId,
          {
            reason: state.reason || 'redirected',
            metadata: { ...state.metadata, targetBot: this.config.name, redirectedFrom: streamId },
          },
        );
      };

      relayAndActivate().catch((err: any) => {
        console.error(`${prefix} Redirect failed: ${err.message}`);
      });
      return; // skip parent processing
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
      continuation: state.metadata?.continuation === 'true',
    };

    console.log(`${prefix} Activation on ${streamId} (reason: ${state.reason || 'unknown'})`);

    // Track for tool-initiated substream entry
    this.lastActivationStreamId = streamId;

    // Update shared tool contexts for this activation
    this.delegateActivationCtx.streamId = streamId;
    this.terminalVeilCtx.pendingAttachments = [];
    this.terminalVeilCtx.streamId = streamId;
    this.terminalVeilCtx.grpcClient = this.grpcClient;
    this.terminalVeilCtx.agentId = this.agentId;
    this.terminalVeilCtx.agentName = this.config.name;
    this.streamToolCtx.agentId = this.agentId;
    this.streamToolCtx.currentStreamId = streamId;
    this.streamToolCtx.grpcClient = this.grpcClient;
    (this.streamToolCtx as any).agentName = this.config.name;

    // Update experiment tool context for this activation
    this.experimentToolCtx.agentName = this.config.name;
    this.experimentToolCtx.agentId = this.agentId;
    this.experimentToolCtx.streamId = streamId;
    this.experimentToolCtx.grpcClient = this.grpcClient;
    this.experimentToolCtx.parentStreamId = this.activeSubstream?.parentStreamId;

    // Reset continue_substream context for this cycle
    this.continueSubstreamCtx.continuationRequested = false;
    this.continueSubstreamCtx.nextReason = undefined;
    this.continueSubstreamCtx.isSubstreamActive =
      !!this.activeSubstream || (!!this.autotriggerState?.enabled);

    this.effector.handleActivation(activation).then((result) => {
      // Signal cycle completion so axon can clear typing indicator
      this.emitTypingStop(streamId);

      // Track whether this cycle used substantive tools (for collapse detection)
      // Exclude continue_substream itself — it's a control signal, not work
      // Note: pi-agent uses 'toolCall' type (not Anthropic's 'tool_use')
      const usedSubstantiveTools = result?.messages?.some((m: any) =>
        Array.isArray(m.content) && m.content.some((b: any) =>
          (b.type === 'tool_use' || b.type === 'toolCall') && b.name !== 'continue_substream'),
      ) ?? false;
      this.trackAutotriggerCycle(usedSubstantiveTools);

      // Autotrigger: gate reactivation on continue_substream
      const continuationRequested = this.continueSubstreamCtx.continuationRequested;

      if (continuationRequested) {
        const reason = this.continueSubstreamCtx.nextReason;
        if (reason) {
          console.log(`${prefix} Continuation requested: ${reason}`);
        }
        this.scheduleAutotrigger(streamId);
      } else {
        // Bot didn't request continuation — end the loop naturally
        this.endAutotriggerNaturally(streamId);
      }
    }).catch((err) => {
      console.error(`${prefix} Activation error on ${streamId}: ${err.message}`);
      this.emitTypingStop(streamId);
    });
  }

  // ---------------------------------------------------------------------------
  // Autotrigger
  // ---------------------------------------------------------------------------

  /** Default max consecutive speech-only cycles before collapse ejection */
  private static readonly AUTOTRIGGER_DEFAULT_MAX_SPEECH_ONLY = 5;

  /** Default autotrigger delay between cycles (ms) */
  private static readonly AUTOTRIGGER_DEFAULT_DELAY = 2000;
  /** Max autotrigger delay after backoff (ms) */
  private static readonly AUTOTRIGGER_MAX_DELAY = 30000;
  /** Backoff multiplier on error */
  private static readonly AUTOTRIGGER_BACKOFF = 1.5;

  /**
   * Track whether an autotrigger cycle used tools. If too many consecutive
   * cycles produce speech-only responses (no tool use), this indicates mode
   * collapse — the agent is looping without making progress. Eject by
   * disabling autotrigger and notifying.
   */
  private trackAutotriggerCycle(usedTools: boolean): void {
    const at = this.autotriggerState;
    if (!at || !at.enabled) return;

    if (usedTools) {
      at.speechOnlyCycles = 0;
    } else {
      at.speechOnlyCycles++;
      const prefix = `[BotRuntime:${this.config.name}]`;
      if (at.speechOnlyCycles >= at.maxSpeechOnly) {
        at.enabled = false;
        console.warn(`${prefix} Autotrigger EJECTED: ${at.speechOnlyCycles} consecutive speech-only cycles (mode collapse detected)`);
        // Notify via speech on the substream or current stream
        const notifyStream = this.activeSubstream?.substreamId || this.lastActivationStreamId || 'unknown';
        this.grpcClient.emitEvent('agent:speech', {
          agentName: this.config.name,
          agentId: this.config.name,
          content: `[autotrigger halted after ${at.speechOnlyCycles} idle cycles] Use \`!autotrigger\` to re-enable.`,
          streamId: notifyStream,
        }).catch(() => {});
      } else {
        console.log(`${prefix} Autotrigger: speech-only cycle ${at.speechOnlyCycles}/${at.maxSpeechOnly}`);
      }
    }
  }

  /**
   * End an autotrigger loop naturally because the bot didn't call continue_substream.
   * This is the normal exit path — the bot chose not to continue.
   */
  private endAutotriggerNaturally(streamId: string): void {
    const at = this.autotriggerState;
    if (!at || !at.enabled) return;

    at.enabled = false;
    const prefix = `[BotRuntime:${this.config.name}]`;
    console.log(`${prefix} Autotrigger ended naturally after ${at.cycleCount} cycles (bot did not request continuation)`);

    // Notify on the substream or current stream
    const notifyStream = this.activeSubstream?.substreamId || streamId;
    this.grpcClient.emitEvent('agent:speech', {
      agentName: this.config.name,
      agentId: this.config.name,
      content: `[autotrigger ended after ${at.cycleCount} cycles]`,
      streamId: notifyStream,
    }).catch(() => {});
  }

  /**
   * Schedule a reactivation after cycle completion if autotrigger is enabled.
   * Reactivates on the substream if active, otherwise on the completed stream.
   */
  private async scheduleAutotrigger(completedStreamId: string): Promise<void> {
    const at = this.autotriggerState;
    if (!at || !at.enabled) return;

    at.cycleCount++;
    const prefix = `[BotRuntime:${this.config.name}]`;

    // Target: substream if active, otherwise the stream the cycle just ran on
    const reactivateStreamId = this.activeSubstream?.substreamId || completedStreamId;

    console.log(`${prefix} Autotrigger: scheduling reactivation on ${reactivateStreamId} in ${at.delayMs}ms (cycle #${at.cycleCount})`);

    setTimeout(async () => {
      // Re-check: autotrigger may have been disabled during the delay
      if (!this.autotriggerState?.enabled) {
        console.log(`${prefix} Autotrigger: cancelled (disabled during delay)`);
        return;
      }

      try {
        await this.grpcClient.activateAgent(
          `agent-bot-${this.agentId}`,
          reactivateStreamId,
          {
            reason: `autotrigger cycle #${this.autotriggerState.cycleCount}`,
            priority: 'normal',
            metadata: {
              targetBot: this.config.name,
              autotrigger: 'true',
              cycleCount: String(this.autotriggerState.cycleCount),
              streamType: this.activeSubstream ? 'substream' : 'channel',
              substreamName: this.activeSubstream?.substreamName || '',
            },
          },
        );
        // Success — reset delay to default
        this.autotriggerState.delayMs = BotRuntime.AUTOTRIGGER_DEFAULT_DELAY;
        console.log(`${prefix} Autotrigger: reactivated on ${reactivateStreamId}`);
      } catch (err: any) {
        // Backoff on error
        this.autotriggerState.delayMs = Math.min(
          this.autotriggerState.delayMs * BotRuntime.AUTOTRIGGER_BACKOFF,
          BotRuntime.AUTOTRIGGER_MAX_DELAY,
        );
        console.error(`${prefix} Autotrigger: reactivation failed (next delay: ${this.autotriggerState.delayMs}ms): ${err.message}`);
        // Try again with backed-off delay
        this.scheduleAutotrigger(completedStreamId);
      }
    }, at.delayMs);
  }

  /**
   * Ensure the substream workspace directory exists.
   * Creates /workspace/shared/substreams/{name}/ if it doesn't exist.
   */
  private async ensureSubstreamDirectory(substreamName: string): Promise<void> {
    const { mkdir } = await import('fs/promises');
    const dir = `/workspace/shared/substreams/${substreamName}`;
    try {
      await mkdir(dir, { recursive: true });
      console.log(`[BotRuntime:${this.config.name}] Substream directory ready: ${dir}`);
    } catch (err: any) {
      console.warn(`[BotRuntime:${this.config.name}] Could not create substream directory ${dir}: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Substream entry / exit
  // ---------------------------------------------------------------------------

  /**
   * Enter a named substream. Creates the stream (idempotent), workspace
   * directory, and emits an orientation message.
   */
  private async enterSubstreamInternal(name: string, parentStreamId: string): Promise<void> {
    const prefix = `[BotRuntime:${this.config.name}]`;

    // Exit current substream if any
    if (this.activeSubstream) {
      this.exitSubstreamInternal();
    }

    const substreamId = `substream:${name}`;

    // Create substream (idempotent)
    try {
      await this.grpcClient.createStream(
        substreamId,
        'substream',
        {
          createdBy: this.config.name,
          substreamName: name,
          participants: this.config.name,
        },
        parentStreamId,
      );
      console.log(`${prefix} Substream ready: ${substreamId} (parent: ${parentStreamId})`);
    } catch (err: any) {
      // Assume the stream exists and continue
      console.warn(`${prefix} CreateStream for ${substreamId}: ${err.message} (continuing anyway)`);
    }

    // Create workspace directory
    await this.ensureSubstreamDirectory(name);

    // Set state
    this.activeSubstream = {
      substreamName: name,
      substreamId,
      parentStreamId,
    };

    // Emit orientation message on the substream
    this.grpcClient.emitEvent('agent:speech', {
      agentName: this.config.name,
      agentId: this.config.name,
      content: `Substream "${name}" entered. Workspace: /workspace/shared/substreams/${name}/\nActivations from ${parentStreamId} will be redirected here.`,
      streamId: substreamId,
    }).catch(() => {});
  }

  /**
   * Exit the current substream. Disables autotrigger (context changes).
   */
  private exitSubstreamInternal(): void {
    if (!this.activeSubstream) return;

    const prefix = `[BotRuntime:${this.config.name}]`;
    const ss = this.activeSubstream;

    // Emit exit message on the substream
    this.grpcClient.emitEvent('agent:speech', {
      agentName: this.config.name,
      agentId: this.config.name,
      content: `[substream "${ss.substreamName}" exited]`,
      streamId: ss.substreamId,
    }).catch(() => {});

    // Clear typing indicators on both substream and parent streams
    this.emitTypingStop(ss.substreamId);

    // If autotrigger is active, disable it (context would change)
    if (this.autotriggerState?.enabled) {
      this.autotriggerState.enabled = false;
      console.log(`${prefix} Autotrigger disabled (substream exited)`);
    }

    this.activeSubstream = undefined;
    console.log(`${prefix} Exited substream "${ss.substreamName}"`);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Emit typing-stop for a stream AND the parent stream if in a substream.
   * The discord-axon keys typing intervals by the parent Discord stream,
   * so we must stop typing there too when the cycle ran on a substream.
   */
  private emitTypingStop(streamId?: string): void {
    if (streamId) {
      this.grpcClient.emitEvent('agent:typing-stop', {
        targetAgent: this.config.name,
        streamId,
      }).catch(() => {});
    }
    // Also emit for the parent stream if we're in a substream
    if (this.activeSubstream) {
      this.grpcClient.emitEvent('agent:typing-stop', {
        targetAgent: this.config.name,
        streamId: this.activeSubstream.parentStreamId,
      }).catch(() => {});
    }
  }

  /** Advertise axon bindings to axons with retry */
  private advertiseAxonBindings(): void {
    const bindings = this.config.axon_bindings;
    if (!bindings || bindings.length === 0) return;

    for (const binding of bindings) {
      const [bHost, bPortStr] = binding.axon_host.split(':');
      const bPort = parseInt(bPortStr) || 50052;

      // Async — don't block startup, retry on failure
      this.advertiseWithRetry(binding.platform, binding.axon_host, bHost, bPort, binding.credentials);
    }
  }

  private async advertiseWithRetry(
    platform: string, axonHost: string, host: string, port: number,
    credentials: Record<string, string>, maxAttempts = 10
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const client = new AxonBindingClient({ host, port });
      try {
        await client.connect();
        const result = await client.advertise({
          agentName: this.config.name,
          platform,
          credentials,
        });
        this.bindingClients.push(client);
        if (result.success) {
          console.log(`[BotRuntime:${this.config.name}] Advertised ${platform} binding to ${axonHost}`);
        } else {
          console.error(`[BotRuntime:${this.config.name}] Binding rejected by ${axonHost}: ${result.error}`);
        }
        return;
      } catch (error: any) {
        client.disconnect();
        if (attempt < maxAttempts) {
          const delay = Math.min(2000 * attempt, 15000);
          console.warn(`[BotRuntime:${this.config.name}] ${platform} binding to ${axonHost} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          console.error(`[BotRuntime:${this.config.name}] ${platform} binding to ${axonHost} failed after ${maxAttempts} attempts: ${error.message}`);
        }
      }
    }
  }

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

    // Add default tools unless skip_system_prompt is set (bare mode — no tools, no prompt)
    if (!this.config.skip_system_prompt) {
      toolHandlers.push(createAttachTool(this.terminalVeilCtx));
      toolHandlers.push(createSaveAttachmentTool(this.terminalVeilCtx));
      console.log(`[BotRuntime:${this.config.name}] attach_file + save_attachment tools enabled`);

      toolHandlers.push(createListStreamsTool(this.streamToolCtx));
      toolHandlers.push(createGetStreamContextTool(this.streamToolCtx));
      toolHandlers.push(createEnlistTool(this.streamToolCtx as EnlistToolContext));
      toolHandlers.push(createContinueSubstreamTool(this.continueSubstreamCtx));

      // Substream + autotrigger tools
      const substreamCtx: SubstreamToolContext = {
        enterSubstream: async (name: string) => {
          const parentStreamId = this.lastActivationStreamId || 'unknown';
          await this.enterSubstreamInternal(name, parentStreamId);
          return `Entered substream "substream:${name}" (parent: ${parentStreamId})`;
        },
        exitSubstream: async () => {
          if (!this.activeSubstream) {
            return 'No active substream to exit.';
          }
          const name = this.activeSubstream.substreamName;
          this.exitSubstreamInternal();
          return `Exited substream "${name}". Activations return to parent channel.`;
        },
        setAutotrigger: (enabled: boolean, maxSpeechOnly?: number) => {
          if (enabled) {
            this.autotriggerState = {
              enabled: true,
              delayMs: 2000,
              cycleCount: 0,
              speechOnlyCycles: 0,
              maxSpeechOnly: maxSpeechOnly ?? BotRuntime.AUTOTRIGGER_DEFAULT_MAX_SPEECH_ONLY,
            };
            const target = this.activeSubstream
              ? `substream substream:${this.activeSubstream.substreamName}`
              : 'current channel';
            return `Autotrigger enabled on ${target}. Call continue_substream each cycle to keep going.`;
          } else {
            if (this.autotriggerState?.enabled) {
              this.autotriggerState.enabled = false;
            }
            return 'Autotrigger disabled.';
          }
        },
        getActiveSubstream: () => {
          if (!this.activeSubstream) return null;
          return { name: this.activeSubstream.substreamName, streamId: this.activeSubstream.substreamId };
        },
        isAutotriggerActive: () => !!this.autotriggerState?.enabled,
      };
      toolHandlers.push(createEnterSubstreamTool(substreamCtx));
      toolHandlers.push(createExitSubstreamTool(substreamCtx));
      toolHandlers.push(createSetAutotriggerTool(substreamCtx));

      // Experiment tools (autoresearch loop)
      toolHandlers.push(createInitExperimentTool(this.experimentToolCtx));
      toolHandlers.push(createRunExperimentTool(this.experimentToolCtx, this.processRegistry));
      toolHandlers.push(createLogExperimentTool(this.experimentToolCtx, this.processRegistry));
      toolHandlers.push(createExperimentDashboardTool(this.experimentToolCtx));

      console.log(`[BotRuntime:${this.config.name}] stream awareness + enlist + substream + continue_substream + experiment tools enabled`);
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
        return createTerminalTool(config, this.processRegistry, this.terminalVeilCtx, this.config.compute_hosts || []);
      case 'delegate':
        return createDelegateTool(config, this.grpcClient, this.config.name, this.agentId, this.delegateActivationCtx);
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
