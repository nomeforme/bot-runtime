/**
 * @connectome/bot-runtime — Standalone bot runtime.
 *
 * Pure agent brain: receives activations via gRPC, runs the agent,
 * records speech back through VEIL. No platform clients.
 */

// Core runtime
export { BotRuntime } from './bot-runtime.js';

// Config
export { loadBotConfig, parseCliArgs } from './bot-config.js';
export type { BotRuntimeConfig, RlmConfig } from './bot-config.js';

// Bridge
export { ConnectomeBridge } from './connectome-bridge.js';
export type { ConnectomeBridgeConfig } from './connectome-bridge.js';

// Adapters
export { NullPlatformAdapter } from './adapters/null-adapter.js';
