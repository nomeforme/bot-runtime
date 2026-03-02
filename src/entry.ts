#!/usr/bin/env node
/**
 * CLI entry point for bot-runtime.
 *
 * Usage:
 *   npx tsx src/entry.ts --registry config.json --bot claude-opus-4-6
 *
 * Environment variables:
 *   BOT_NAME             — Bot name (alternative to --bot)
 *   BOT_REGISTRY         — Path to config.json (alternative to --registry)
 *   CONNECTOME_GRPC_HOST — Connectome server host:port (default: localhost:50051)
 *   ANTHROPIC_API_KEY    — Anthropic API key
 *   AWS_ACCESS_KEY_ID    — AWS access key (for Bedrock models)
 *   AWS_SECRET_ACCESS_KEY — AWS secret key
 *   AWS_REGION           — AWS region (default: us-east-1)
 */

import { initErrorTracking, Sentry } from '@connectome/grpc-common';
initErrorTracking({ serviceName: `bot-${process.env.BOT_NAME || 'unknown'}` });

import { parseCliArgs, loadBotConfig } from './bot-config.js';
import { BotRuntime } from './bot-runtime.js';

async function main(): Promise<void> {
  try {
    // Parse CLI args
    const { registryPath, botName } = parseCliArgs();

    // Load config
    const config = loadBotConfig(registryPath, botName);

    // Create and start runtime
    const runtime = new BotRuntime(config);

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');
      await runtime.stop();
      await Sentry.flush(2000);
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await runtime.start();
  } catch (error: any) {
    console.error(`Fatal: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
