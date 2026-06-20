/**
 * attach_file tool — uploads a file to the Connectome content-addressed blob
 * store and queues a sha256 ref on the activation context.
 *
 * The ref is drained by the effector after the agent cycle completes and
 * embedded in the agent:speech event as `Attachment.blobId`. The matching
 * platform axon's speech-effector pulls the bytes via GetBlob right before
 * delivering to Signal/Discord — so the bytes only travel:
 *   bot → server (PutBlob, this tool)
 *   server → axon (GetBlob, in the effector)
 * The pub/sub broadcast carries only the sha256 ref (~64 bytes), never bytes.
 *
 * This avoids the gRPC fan-out amplification that previously caused
 * subscription drops + DEADLINE_EXCEEDED cascades on attachment-heavy cycles.
 */

import fs from 'fs';
import path from 'path';
import { generateAttachmentId, getContentTypeFromFilename, type ConnectomeClient } from '@connectome/grpc-common';
import type { ToolHandler } from '@connectome/agent-core';
import type { TerminalVeilContext } from './terminal-tool.js';

const MAX_ATTACHMENT_SIZE = 8 * 1024 * 1024; // 8MB

export function createAttachTool(veilCtx: TerminalVeilContext, client: ConnectomeClient): ToolHandler {
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

      const bytes = fs.readFileSync(resolved);
      const filename = input.filename || path.basename(resolved);
      const contentType = getContentTypeFromFilename(filename);

      // Upload to the blob store. Returns the sha256 content-addressed id.
      // Idempotent: re-attaching the same bytes is a no-op (alreadyExisted=true).
      let blobId: string;
      try {
        const result = await client.putBlob(new Uint8Array(bytes), {
          contentType,
          filename,
        });
        blobId = result.blobId;
        if (result.alreadyExisted) {
          console.log(`[attach_file] Blob ${blobId.substring(0, 12)}... already in store (dedup hit)`);
        } else {
          console.log(`[attach_file] Uploaded blob ${blobId.substring(0, 12)}... (${stat.size} bytes)`);
        }
      } catch (err: any) {
        return `Error: Failed to upload to blob store: ${err.message}`;
      }

      if (!veilCtx.pendingAttachments) veilCtx.pendingAttachments = [];
      veilCtx.pendingAttachments.push({
        id: generateAttachmentId(),
        blobId,
        contentType,
        filename,
        sizeBytes: stat.size,
      });

      return `Attached ${filename} (${(stat.size / 1024).toFixed(1)}KB). Will be sent with your next message.`;
    },
  };
}
