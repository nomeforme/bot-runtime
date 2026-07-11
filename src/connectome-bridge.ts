/**
 * ConnectomeBridge — implements ContextProvider and SpeechRecorder using gRPC.
 *
 * This bridges the bot-runtime to the Connectome server, providing:
 * - Context fetching (VEIL state → AgentContext)
 * - Speech recording (agent output → VEIL facet)
 *
 * Extracted and simplified from discord-axon's FocusedContextTransform +
 * DiscordAgentEffector speech recording logic.
 */

import { ConnectomeClient } from '@connectome/grpc-common';
import { renderedContextToAgentContext, resolveAttachmentRefs, applyThinkingDisableToPrompt } from '@connectome/agent-core';
import type { ContextProvider, SpeechRecorder, AgentContext, BlobFetcher } from '@connectome/agent-core';
import type { TerminalVeilContext } from './tools/terminal-tool.js';

export interface ConnectomeBridgeConfig {
  /** gRPC client instance */
  client: ConnectomeClient;
  /** Agent name (used for agent registration and speech recording) */
  agentName: string;
  /** Agent ID (registered with server) */
  agentId: string;
  /** Base system prompt for the bot */
  systemPrompt: string;
  /** Skip identity text in system prompt */
  skipIdentityPrompt?: boolean;
  /** Shared VEIL context — incoming attachments populated here during getContext */
  veilCtx?: TerminalVeilContext;
  /**
   * If true, dispatch thinking-disable via the agent-core adapter registry.
   * The adapter chosen depends on `modelId` — Qwen prepends `/no_think`,
   * future adapters handle other model families.
   */
  disableThinking?: boolean;
  /** Model identifier (for thinking-control dispatch). */
  modelId?: string;
  /** OpenAI-compatible endpoint URL if applicable (for thinking-control dispatch). */
  modelEndpoint?: string;
}

export class ConnectomeBridge implements ContextProvider, SpeechRecorder {
  private client: ConnectomeClient;
  private agentName: string;
  private agentId: string;
  private systemPrompt: string;
  private skipIdentityPrompt: boolean;
  private veilCtx?: TerminalVeilContext;
  private disableThinking: boolean;
  private modelId?: string;
  private modelEndpoint?: string;

  /**
   * Per-stream cache of pre-rendered contexts delivered alongside an activation.
   *
   * When the server's `ActivateAgent` handler fires, it inlines a rendered
   * context (at maxFrames=100) into a `rendered-context` facet. The bot
   * receives this via its activation-event subscription. Stashing the context
   * here lets the next `getContext(streamId)` call use it directly — avoiding
   * a redundant gRPC `GetContext` roundtrip that would otherwise re-fetch
   * (typically at maxFrames=500) and risk blowing the gRPC frame limit on
   * heavy streams.
   *
   * Keyed by streamId. One-shot: consumed and deleted on first read. TTL is
   * a safety net for activations that never run their effector.
   */
  private preRendered = new Map<string, { context: any; tokenCount: number; expiresAt: number }>();
  private static readonly PRE_RENDERED_TTL_MS = 30_000;

  /**
   * Persistent, per-stream history-trim defaults, set via `!h-default N`.
   * Keyed by connectome streamId (platform-agnostic), so a default set in one
   * stream never leaks into another — no cross-channel context discontinuity.
   * Applied to an activation only when its streamId has an entry AND the
   * trigger carries no explicit `!hN` prefix. Seeded from the on-disk overlay
   * at boot and kept live via `bot:config` events. `undefined`/absent = off
   * (full history goes to the API for that stream).
   */
  private historyDefaults = new Map<string, number>();

  constructor(config: ConnectomeBridgeConfig) {
    this.client = config.client;
    this.agentName = config.agentName;
    this.agentId = config.agentId;
    this.systemPrompt = config.systemPrompt;
    this.skipIdentityPrompt = config.skipIdentityPrompt ?? false;
    this.veilCtx = config.veilCtx;
    this.disableThinking = config.disableThinking ?? false;
    this.modelId = config.modelId;
    this.modelEndpoint = config.modelEndpoint;
  }

  /** Set/clear the per-stream history default (from !h-default N). undefined = clear. */
  setHistoryDefault(streamId: string, n: number | undefined): void {
    if (n === undefined) {
      this.historyDefaults.delete(streamId);
    } else {
      this.historyDefaults.set(streamId, n);
    }
    console.log(
      `[ConnectomeBridge:${this.agentName}] history default for ${streamId} ` +
        `${n === undefined ? 'CLEARED (full history)' : `set to ${n}`}`,
    );
  }

  /** Seed per-stream history defaults from the on-disk overlay at boot. */
  seedHistoryDefaults(defaults: Record<string, number> | undefined): void {
    if (!defaults) return;
    for (const [streamId, n] of Object.entries(defaults)) {
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
        this.historyDefaults.set(streamId, n);
      }
    }
    if (this.historyDefaults.size) {
      console.log(
        `[ConnectomeBridge:${this.agentName}] seeded ${this.historyDefaults.size} ` +
          `per-stream history default(s) from overlay`,
      );
    }
  }

  /**
   * Live-replace the base system prompt (from `!sysprompt` axon command).
   *
   * Identity prefix + thinking-control adapter are re-applied on every
   * `buildSystemPrompt()` call, so this takes effect on the very next
   * activation without any restart. Persistence is handled upstream by
   * the axon writing an overlay file — this method only touches memory.
   *
   * Pass `''` (empty string) to fall back to identity-only.
   */
  setSystemPrompt(text: string): void {
    this.systemPrompt = text;
    // Re-log adapter resolution on next buildSystemPrompt (prompt changed).
    this.thinkingDispatchLogged = false;
    const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    console.log(
      `[ConnectomeBridge:${this.agentName}] system prompt updated (${text.length} chars): ${JSON.stringify(preview)}`,
    );
  }

  /** Read the current in-memory system prompt (identity/thinking not applied). */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /** Read the current history default for a stream (undefined = off). */
  getHistoryDefault(streamId: string): number | undefined {
    return this.historyDefaults.get(streamId);
  }

  /**
   * Prime the per-stream pre-rendered context cache. Call this right before
   * dispatching an activation to the effector when a `rendered-context` facet
   * was paired with the `agent-activation`. The next `getContext(streamId)`
   * call will consume it instead of going over gRPC.
   */
  setPreRenderedContext(streamId: string, context: any, tokenCount = 0): void {
    if (!context) return;
    this.preRendered.set(streamId, {
      context,
      tokenCount,
      expiresAt: Date.now() + ConnectomeBridge.PRE_RENDERED_TTL_MS,
    });
  }

  // ---------------------------------------------------------------------------
  // ContextProvider
  // ---------------------------------------------------------------------------

  /**
   * BlobFetcher bound to this bridge's gRPC client. Used to lazily resolve
   * Attachment.blobId refs into inline bytes before the LLM call.
   */
  private fetchBlob: BlobFetcher = async (blobId: string) => {
    const result = await this.client.getBlob(blobId);
    return {
      bytes: result.bytes,
      contentType: result.contentType,
      filename: result.filename,
    };
  };

  async getContext(
    streamId: string,
    options?: { maxFrames?: number },
  ): Promise<AgentContext> {
    // Fast path: consume pre-rendered context if the server attached one
    // alongside this activation. Avoids a redundant GetContext gRPC call,
    // which on heavy streams (1k+ facets) can blow the gRPC frame limit and
    // deadline-expire even when bounded by maxFrames.
    const cached = this.preRendered.get(streamId);
    if (cached && cached.expiresAt > Date.now()) {
      this.preRendered.delete(streamId);
      console.log(`[ConnectomeBridge:${this.agentName}] Using pre-rendered context for ${streamId} (${cached.tokenCount} tokens, no gRPC fetch)`);
      let messages = this.transformToMessages(cached.context);
      // Resolve any blob-ref attachments into inline bytes so the LLM (and
      // save_attachment extraction) see them identically to legacy inline data.
      messages = await resolveAttachmentRefs(messages, this.fetchBlob);
      // Apply per-activation !hN history override (strips prefix + trims context)
      messages = this.applyHistoryOverride(messages, streamId);
      if (this.veilCtx) {
        this.veilCtx.incomingAttachments = this.extractIncomingAttachments(messages);
      }
      this.logConversationData(messages, streamId);
      const context = renderedContextToAgentContext({ messages });
      context.rawMessages = messages.filter(m => m.role !== 'system');
      return context;
    }
    // Drop stale entry if expired
    if (cached) this.preRendered.delete(streamId);

    console.log(`[ConnectomeBridge:${this.agentName}] Fetching context for stream ${streamId} (maxFrames=${options?.maxFrames ?? 500})`);

    try {
      const result = await this.client.getContext(
        this.agentId,
        streamId,
        { maxFrames: options?.maxFrames ?? 500 },
      );

      const serverContext = result.context as any;

      // Transform server conversation to RenderedContextLike format
      let messages = this.transformToMessages(serverContext);

      // Resolve blob refs → inline bytes before downstream consumers see them.
      messages = await resolveAttachmentRefs(messages, this.fetchBlob);

      // Apply per-activation !hN history override (strips prefix + trims context)
      messages = this.applyHistoryOverride(messages, streamId);

      // Extract incoming file attachments for save_attachment tool
      if (this.veilCtx) {
        this.veilCtx.incomingAttachments = this.extractIncomingAttachments(messages);
      }

      // Log conversation history (last 10 messages)
      this.logConversationData(messages, streamId);

      // Convert to pi-agent AgentContext, preserving raw unmerged messages for prefill
      const context = renderedContextToAgentContext({ messages });
      context.rawMessages = messages.filter(m => m.role !== 'system');
      return context;
    } catch (error: any) {
      console.warn(`[ConnectomeBridge:${this.agentName}] Context fetch failed: ${error.message}`);
      // Return fallback context with just the system prompt
      return this.buildFallbackContext();
    }
  }

  /**
   * Per-activation !hN prefix on the trigger message: `!h<N> <content>` limits
   * the messages actually sent to the API to the last N+1 (N history + this
   * trigger), and strips the prefix from the trigger's content. Prefix stays
   * in VEIL storage — bot-local instrumentation only, no server changes.
   *
   * Debug + general-purpose (e.g. `!h0 hi how are you` in a group whose recent
   * context is tripping a classifier — should respond cleanly because no
   * offending history reaches the API).
   */
  private applyHistoryOverride<T extends { role: string; content: string }>(messages: T[], streamId: string): T[] {
    if (messages.length === 0) return messages;
    // Find the last user message and check its content — that's the trigger.
    let triggerIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { triggerIdx = i; break; }
    }
    if (triggerIdx < 0) return messages;
    const trigger = messages[triggerIdx];
    // Grammar: `[<author>] [@mention] !h<N> <rest>`. Author-prefix and mentions
    // stay in-content for multi-party legibility, so allow both as optional
    // preamble and preserve them in the stripped content.
    const match = trigger.content.match(/^((?:<[^>]+>\s+)?(?:@\S+\s+)*)!h(\d+)\s+([\s\S]*)$/);
    let n: number;
    let strippedTrigger: T;
    let source: 'prefix' | 'default';
    if (match) {
      const preamble = match[1] ?? '';
      n = parseInt(match[2], 10);
      strippedTrigger = { ...trigger, content: preamble + match[3] };
      source = 'prefix';
    } else if (this.historyDefaults.has(streamId)) {
      n = this.historyDefaults.get(streamId)!;
      strippedTrigger = trigger; // no prefix to strip
      source = 'default';
    } else {
      return messages;
    }

    // Rebuild: keep the system prompt (always index 0 if present) + last N
    // messages of prior history + the stripped trigger.
    const systemMsgs = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    // Replace trigger in nonSystem with stripped version, keeping its position
    const nonSystemStripped = nonSystem.map(m => m === trigger ? strippedTrigger : m);
    // Prior history excludes the trigger itself; keep last N of it, then append trigger.
    // NB: arr.slice(-0) returns the WHOLE array (since -0 === 0), so guard N===0 explicitly.
    const priorHistory = nonSystemStripped.slice(0, -1);
    const historyKept = n === 0 ? [] : priorHistory.slice(-n);
    const kept = historyKept.concat([strippedTrigger]);
    const result = [...systemMsgs, ...kept] as T[];

    console.log(
      `[ConnectomeBridge:${this.agentName}] !h${n} override (${source}) — trimmed context: ${messages.length} → ${result.length} messages ` +
      `(kept last ${kept.length} non-system: ${n} history + trigger)${source === 'prefix' ? ', stripped prefix from trigger' : ''}.`,
    );
    return result;
  }

  // ---------------------------------------------------------------------------
  // SpeechRecorder
  // ---------------------------------------------------------------------------

  async recordSpeech(
    content: string,
    metadata: { agentId: string; agentName: string; streamId: string; attachments?: Array<{ id: string; contentType: string; data: string; filename?: string; sizeBytes?: number }>; cyclePending?: boolean },
  ): Promise<void> {
    try {
      const payload: Record<string, any> = {
        content,
        agentId: metadata.agentId,
        agentName: metadata.agentName,
        streamId: metadata.streamId,
        timestamp: Date.now(),
      };
      if (metadata.attachments?.length) {
        payload.attachments = metadata.attachments;
      }
      if (metadata.cyclePending) {
        payload.cyclePending = true;
      }
      await this.client.emitEvent(
        'agent:speech',
        payload,
        { priority: 'normal', waitForFrame: true },
      );
      console.log(`[ConnectomeBridge:${this.agentName}] Recorded speech in server state`);
    } catch (error: any) {
      console.warn(`[ConnectomeBridge:${this.agentName}] Failed to record speech: ${error.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /** Build the system prompt with optional identity injection */
  private buildSystemPrompt(): string {
    const identityPrompt = this.skipIdentityPrompt
      ? ''
      : `You are <${this.agentName}>.

To mention users or other bots, use @username syntax (e.g. @claude-opus-4-5). The system will convert usernames to mentions automatically.`;

    let composed: string;
    if (this.systemPrompt && this.systemPrompt !== 'Standard') {
      if (identityPrompt) {
        // Identity first, custom persona after — identity/mention/formatting rules
        // sit at the head where models (esp. smaller/local ones like Qwen) weight
        // instructions most heavily, before the persona takes over.
        composed = `${identityPrompt}\n\n${this.systemPrompt}`;
      } else {
        composed = this.systemPrompt;
      }
    } else {
      composed = identityPrompt;
    }

    // Thinking-control dispatch — if this bot has `disable_thinking: true`,
    // route through the adapter registry (Qwen → `/no_think` prefix, other
    // model families as adapters land). Idempotent per adapter: safe to
    // invoke on every buildSystemPrompt call.
    if (this.disableThinking && this.modelId) {
      const { systemPrompt: patched, adapterName } = applyThinkingDisableToPrompt(
        { model: this.modelId, endpoint: this.modelEndpoint },
        composed,
      );
      composed = patched;
      // Log the resolution only once per bridge instance (avoid spam per activation).
      if (!this.thinkingDispatchLogged) {
        console.log(
          `[ConnectomeBridge:${this.agentName}] disable_thinking → adapter=${adapterName ?? 'none'} (model=${this.modelId})`,
        );
        this.thinkingDispatchLogged = true;
      }
    }

    return composed;
  }

  /** One-time log flag for thinking-control adapter resolution. */
  private thinkingDispatchLogged = false;

  /** Transform server context to ContextMessage format for renderedContextToAgentContext */
  private transformToMessages(serverContext: any): Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
    metadata?: { attachments?: any[] };
  }> {
    const messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
      metadata?: { attachments?: any[] };
    }> = [];

    // Add system prompt, enriched with ambient facets from server state
    let systemContent = this.buildSystemPrompt();

    // Append ambient facets (server already filters by agent and stream)
    if (serverContext?.state && typeof serverContext.state === 'object') {
      const ambientParts: string[] = [];
      for (const [, facet] of Object.entries(serverContext.state) as [string, any][]) {
        if (facet.type !== 'ambient' || !facet.content) continue;
        ambientParts.push(facet.content);
      }
      if (ambientParts.length > 0) {
        systemContent += '\n\n## Current Context\n' + ambientParts.join('\n');
      }
    }

    if (systemContent) {
      messages.push({ role: 'system', content: systemContent });
    }

    // Transform conversation from server
    if (serverContext?.conversation && Array.isArray(serverContext.conversation)) {
      for (const msg of serverContext.conversation) {
        if (msg.internal) continue;

        const role = msg.role as 'system' | 'user' | 'assistant';
        if (role === 'system') continue; // We add our own

        if (role === 'user' || role === 'assistant') {
          const message: {
            role: 'system' | 'user' | 'assistant';
            content: string;
            metadata?: { attachments?: any[] };
          } = {
            role,
            content: msg.content || '',
          };

          // Preserve attachment metadata for image processing
          if (msg.metadata?.attachments?.length > 0) {
            message.metadata = { attachments: msg.metadata.attachments };
          }

          messages.push(message);
        }
      }
    }

    return messages;
  }

  /** Log conversation data for debugging (mirrors FocusedContextTransform.logConversationData) */
  private logConversationData(
    messages: Array<{ role: string; content: string }>,
    streamId: string,
  ): void {
    const prefix = `[ConnectomeBridge:${this.agentName}]`;
    console.log(`${prefix} ╔══════════════════════════════════════`);
    console.log(`${prefix} ║ Stream: ${streamId}`);
    const showCount = Math.min(messages.length, 10);
    console.log(`${prefix} ║ Total messages: ${messages.length} (showing last ${showCount})`);

    const startIndex = Math.max(0, messages.length - 10);
    if (startIndex > 0) {
      console.log(`${prefix} ║ ... (${startIndex} earlier messages omitted)`);
    }
    for (let i = startIndex; i < messages.length; i++) {
      const msg = messages[i];
      const roleLabel = msg.role.toUpperCase().padEnd(9);
      const contentPreview =
        msg.content.length > 200
          ? msg.content.substring(0, 200) + '...'
          : msg.content;
      const displayContent = contentPreview.replace(/\n/g, ' ↵ ');
      console.log(`${prefix} ║ [${i + 1}] ${roleLabel}: ${displayContent}`);
    }
    console.log(`${prefix} ╚══════════════════════════════════════`);
  }

  /** Extract non-image attachments with data from context messages for save_attachment tool */
  private extractIncomingAttachments(messages: Array<{
    role: string; content: string; metadata?: { attachments?: any[] };
  }>): TerminalVeilContext['incomingAttachments'] {
    const attachments: NonNullable<TerminalVeilContext['incomingAttachments']> = [];
    for (const msg of messages) {
      if (!msg.metadata?.attachments) continue;
      for (const att of msg.metadata.attachments) {
        // Only collect non-image attachments that have base64 data
        if (att.data && !att.contentType?.startsWith('image/')) {
          attachments.push({
            id: att.id || att.name || `att-${attachments.length}`,
            contentType: att.contentType || 'application/octet-stream',
            data: att.data,
            filename: att.name || att.filename || `attachment-${attachments.length}`,
            sizeBytes: att.size || 0,
          });
        }
      }
    }
    if (attachments.length > 0) {
      console.log(`[ConnectomeBridge:${this.agentName}] Found ${attachments.length} incoming file attachment(s) for save_attachment`);
    }
    return attachments;
  }

  /** Build fallback context when server is unavailable */
  private buildFallbackContext(): AgentContext {
    const systemContent = this.buildSystemPrompt();
    return renderedContextToAgentContext({
      messages: systemContent ? [{ role: 'system' as const, content: systemContent }] : [],
    });
  }
}
