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
import { renderedContextToAgentContext } from '@connectome/agent-core';
import type { ContextProvider, SpeechRecorder, AgentContext } from '@connectome/agent-core';
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
}

export class ConnectomeBridge implements ContextProvider, SpeechRecorder {
  private client: ConnectomeClient;
  private agentName: string;
  private agentId: string;
  private systemPrompt: string;
  private skipIdentityPrompt: boolean;
  private veilCtx?: TerminalVeilContext;

  constructor(config: ConnectomeBridgeConfig) {
    this.client = config.client;
    this.agentName = config.agentName;
    this.agentId = config.agentId;
    this.systemPrompt = config.systemPrompt;
    this.skipIdentityPrompt = config.skipIdentityPrompt ?? false;
    this.veilCtx = config.veilCtx;
  }

  // ---------------------------------------------------------------------------
  // ContextProvider
  // ---------------------------------------------------------------------------

  async getContext(
    streamId: string,
    options?: { maxFrames?: number },
  ): Promise<AgentContext> {
    console.log(`[ConnectomeBridge:${this.agentName}] Fetching context for stream ${streamId} (maxFrames=${options?.maxFrames ?? 500})`);

    try {
      const result = await this.client.getContext(
        this.agentId,
        streamId,
        { maxFrames: options?.maxFrames ?? 500 },
      );

      const serverContext = result.context as any;

      // Transform server conversation to RenderedContextLike format
      const messages = this.transformToMessages(serverContext);

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

    if (this.systemPrompt && this.systemPrompt !== 'Standard') {
      if (identityPrompt) {
        return `${this.systemPrompt}\n\n${identityPrompt}`;
      }
      return this.systemPrompt;
    }

    return identityPrompt;
  }

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

    // Add system prompt
    const systemContent = this.buildSystemPrompt();
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
