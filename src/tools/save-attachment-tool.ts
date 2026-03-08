/**
 * save_attachment tool — saves an incoming file attachment from the current
 * conversation context to the bot's workspace.
 *
 * Attachments are populated by ConnectomeBridge during context fetch.
 * The agent sees non-image attachments annotated in the conversation and
 * can call this tool to save them to disk.
 */

import fs from 'fs';
import path from 'path';
import type { ToolHandler } from '@connectome/agent-core';
import type { TerminalVeilContext } from './terminal-tool.js';

const DEFAULT_WORKSPACE = '/workspace/shared';

export function createSaveAttachmentTool(veilCtx: TerminalVeilContext): ToolHandler {
  return {
    name: 'save_attachment',
    description:
      'Save a file attachment from the conversation to the workspace. ' +
      'Use this when a user sends a non-image file (PDF, document, code, etc.) and you need to work with it. ' +
      'Call with the filename shown in the [Attached files] annotation. ' +
      'Defaults to /workspace/shared/ — pass a destination path to save elsewhere within /workspace/shared/.',
    parameters: {
      filename: {
        type: 'string',
        description: 'Filename of the attachment to save (as shown in the [Attached files] annotation)',
      },
      destination: {
        type: 'string',
        description: 'Destination path or directory (default: /workspace/shared/). Must be under /workspace/shared/ or /tmp/.',
      },
    },
    required: ['filename'],
    handler: async (input) => {
      console.log(`[save_attachment] Called with:`, JSON.stringify(input));

      const incoming = veilCtx.incomingAttachments;
      if (!incoming || incoming.length === 0) {
        return 'Error: No file attachments available in the current conversation context.';
      }

      const targetFilename = input.filename as string;

      // Find attachment by filename (exact or partial match)
      let match = incoming.find((a) => a.filename === targetFilename);
      if (!match) {
        match = incoming.find((a) =>
          a.filename.toLowerCase().includes(targetFilename.toLowerCase())
        );
      }
      if (!match) {
        const available = incoming.map((a) => `  - ${a.filename} (${a.contentType}, ${(a.sizeBytes / 1024).toFixed(1)}KB)`);
        return `Error: Attachment "${targetFilename}" not found. Available:\n${available.join('\n')}`;
      }

      // Resolve destination path
      let destPath: string;
      const dest = (input.destination as string | undefined) || DEFAULT_WORKSPACE;
      const resolvedDest = path.resolve(dest);

      if (!resolvedDest.startsWith('/workspace/shared') && !resolvedDest.startsWith('/tmp')) {
        return 'Error: Destination must be under /workspace/shared/ or /tmp/';
      }

      // If destination is a directory (or ends with /), save with original filename inside it
      if (dest.endsWith('/') || (fs.existsSync(resolvedDest) && fs.statSync(resolvedDest).isDirectory())) {
        destPath = path.join(resolvedDest, match.filename);
      } else {
        destPath = resolvedDest;
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(destPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      // Decode base64 and write
      try {
        const buffer = Buffer.from(match.data, 'base64');
        fs.writeFileSync(destPath, buffer);
        console.log(`[save_attachment] Saved ${match.filename} to ${destPath} (${buffer.length} bytes)`);
        return `Saved ${match.filename} to ${destPath} (${(buffer.length / 1024).toFixed(1)}KB)`;
      } catch (err: any) {
        return `Error saving file: ${err.message}`;
      }
    },
  };
}
