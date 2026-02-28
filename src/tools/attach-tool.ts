/**
 * attach_file tool — queues a file as a base64 attachment on the activation context.
 *
 * The attachment is drained by the effector after the agent cycle completes
 * and sent alongside the bot's speech to Discord/Signal.
 */

import fs from 'fs';
import path from 'path';
import { generateAttachmentId, getContentTypeFromFilename } from '@connectome/grpc-common';
import type { ToolHandler } from '@connectome/agent-core';
import type { TerminalVeilContext } from './terminal-tool.js';

const MAX_ATTACHMENT_SIZE = 8 * 1024 * 1024; // 8MB

export function createAttachTool(veilCtx: TerminalVeilContext): ToolHandler {
  return {
    name: 'attach_file',
    description: 'Attach a file (image, document, etc.) to your next message so it appears in Discord/Signal. You MUST call this after generating any file the user should see — files on disk are invisible to users without this tool. Only files in /workspace/shared/ or /tmp/ can be attached. Max 8MB.',
    parameters: {
      file_path: { type: 'string', description: 'Path to file (e.g. /workspace/shared/output.png)' },
      filename: { type: 'string', description: 'Optional display filename' },
    },
    required: ['file_path'],
    handler: async (input) => {
      console.log(`[attach_file] Called with:`, JSON.stringify(input));
      const filePath = input.file_path;
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith('/workspace/shared') && !resolved.startsWith('/tmp'))
        return 'Error: Can only attach files from /workspace/shared/ or /tmp/';

      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch {
        return `Error: File not found: ${resolved}`;
      }
      if (!stat.isFile()) return `Error: ${resolved} is not a file`;
      if (stat.size > MAX_ATTACHMENT_SIZE)
        return `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 8MB)`;

      const data = fs.readFileSync(resolved).toString('base64');
      const filename = input.filename || path.basename(resolved);

      if (!veilCtx.pendingAttachments) veilCtx.pendingAttachments = [];
      veilCtx.pendingAttachments.push({
        id: generateAttachmentId(),
        contentType: getContentTypeFromFilename(filename),
        data,
        filename,
        sizeBytes: stat.size,
      });

      return `Attached ${filename} (${(stat.size / 1024).toFixed(1)}KB). Will be sent with your next message.`;
    },
  };
}
