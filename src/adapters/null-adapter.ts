/**
 * NullPlatformAdapter — headless/autonomous mode adapter.
 *
 * Used when no platform (Discord, Signal, etc.) is configured.
 * All delivery methods are no-ops. The bot can still be activated
 * via gRPC (server-side activations, REPL, or autonomous tasks).
 */

import type { PlatformAdapter, PlatformContext } from '@connectome/agent-core';

export class NullPlatformAdapter implements PlatformAdapter {
  readonly platformType = 'null';

  buildStreamId(platformData: Record<string, any>): string {
    return platformData.streamId || 'headless:default';
  }

  async deliverSpeech(_content: string, _context: PlatformContext): Promise<void> {
    // No platform to deliver to — speech is still recorded via SpeechRecorder
  }

  async formatContent(content: string, _context: PlatformContext): Promise<string> {
    return content;
  }

  cleanIncoming(content: string, _context: PlatformContext): string {
    return content;
  }

  async sendTypingIndicator(_context: PlatformContext): Promise<void> {
    // No-op
  }
}
