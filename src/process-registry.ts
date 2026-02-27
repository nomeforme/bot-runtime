/**
 * ProcessRegistry — in-memory registry for managed background processes.
 *
 * Supports PTY (via node-pty) and plain child_process.spawn().
 * Rolling output buffer (200KB), LRU pruning of finished sessions (30 min TTL).
 */

import { spawn as cpSpawn, type ChildProcess } from 'child_process';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { randomBytes } from 'crypto';

const MAX_CONCURRENT = 32;
const OUTPUT_BUFFER_MAX = 200 * 1024; // 200KB rolling window
const FINISHED_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface ProcessSession {
  id: string;
  command: string;
  pid: number;
  cwd: string;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
  outputBuffer: string;
  ptyHandle: IPty | null;
  childHandle: ChildProcess | null;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  pty?: boolean;
}

export class ProcessRegistry {
  private sessions = new Map<string, ProcessSession>();
  private pruneTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Prune finished sessions every 5 minutes
    this.pruneTimer = setInterval(() => this.pruneFinished(), 5 * 60 * 1000);
    this.pruneTimer.unref();
  }

  spawn(command: string, opts: SpawnOptions = {}): ProcessSession {
    // Enforce concurrent limit
    const active = [...this.sessions.values()].filter((s) => !s.exited);
    if (active.length >= MAX_CONCURRENT) {
      throw new Error(`Max concurrent processes (${MAX_CONCURRENT}) reached`);
    }

    const id = 'proc_' + randomBytes(6).toString('hex');
    const cwd = opts.cwd || process.cwd();
    const env = opts.env ? { ...process.env, ...opts.env } : { ...process.env };

    const session: ProcessSession = {
      id,
      command,
      pid: 0,
      cwd,
      startedAt: Date.now(),
      exited: false,
      exitCode: null,
      outputBuffer: '',
      ptyHandle: null,
      childHandle: null,
    };

    if (opts.pty !== false) {
      // PTY mode (default)
      const ptyProc = pty.spawn('bash', ['-c', command], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd,
        env: env as Record<string, string>,
      });

      session.pid = ptyProc.pid;
      session.ptyHandle = ptyProc;

      ptyProc.onData((data: string) => {
        this.appendOutput(session, data);
      });

      ptyProc.onExit(({ exitCode }: { exitCode: number }) => {
        session.exited = true;
        session.exitCode = exitCode;
      });
    } else {
      // Plain child_process mode
      const child = cpSpawn('bash', ['-c', command], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      session.pid = child.pid ?? 0;
      session.childHandle = child;

      child.stdout?.on('data', (data: Buffer) => {
        this.appendOutput(session, data.toString());
      });

      child.stderr?.on('data', (data: Buffer) => {
        this.appendOutput(session, data.toString());
      });

      child.on('exit', (code) => {
        session.exited = true;
        session.exitCode = code ?? null;
      });

      child.on('error', (err) => {
        this.appendOutput(session, `\nProcess error: ${err.message}\n`);
        session.exited = true;
        session.exitCode = -1;
      });
    }

    this.sessions.set(id, session);
    return session;
  }

  poll(sessionId: string): { status: string; exitCode: number | null; outputTail: string } {
    const session = this.getSession(sessionId);
    const tail = session.outputBuffer.slice(-4000);
    return {
      status: session.exited ? 'exited' : 'running',
      exitCode: session.exitCode,
      outputTail: tail,
    };
  }

  log(sessionId: string, lines?: number): string {
    const session = this.getSession(sessionId);
    if (!lines) return session.outputBuffer;
    const allLines = session.outputBuffer.split('\n');
    return allLines.slice(-lines).join('\n');
  }

  submit(sessionId: string, input: string): void {
    const session = this.getSession(sessionId);
    this.writeRaw(session, input + '\n');
  }

  write(sessionId: string, data: string): void {
    const session = this.getSession(sessionId);
    this.writeRaw(session, data);
  }

  kill(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session.exited) return;

    if (session.ptyHandle) {
      session.ptyHandle.kill();
    } else if (session.childHandle) {
      session.childHandle.kill('SIGTERM');
      setTimeout(() => {
        if (!session.exited && session.childHandle) {
          session.childHandle.kill('SIGKILL');
        }
      }, 5000);
    }
  }

  list(): ProcessSession[] {
    return [...this.sessions.values()];
  }

  /** Clean up all processes on shutdown */
  destroy(): void {
    clearInterval(this.pruneTimer);
    for (const session of this.sessions.values()) {
      if (!session.exited) {
        if (session.ptyHandle) {
          try { session.ptyHandle.kill(); } catch {}
        } else if (session.childHandle) {
          try { session.childHandle.kill('SIGKILL'); } catch {}
        }
      }
    }
    this.sessions.clear();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private getSession(id: string): ProcessSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Process session not found: ${id}`);
    return session;
  }

  private appendOutput(session: ProcessSession, data: string): void {
    session.outputBuffer += data;
    // Rolling window — trim from the front when exceeding max
    if (session.outputBuffer.length > OUTPUT_BUFFER_MAX) {
      session.outputBuffer = session.outputBuffer.slice(-OUTPUT_BUFFER_MAX);
    }
  }

  private writeRaw(session: ProcessSession, data: string): void {
    if (session.exited) {
      throw new Error(`Cannot write to exited process ${session.id}`);
    }
    if (session.ptyHandle) {
      session.ptyHandle.write(data);
    } else if (session.childHandle?.stdin) {
      session.childHandle.stdin.write(data);
    }
  }

  private pruneFinished(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.exited && now - session.startedAt > FINISHED_TTL_MS) {
        this.sessions.delete(id);
      }
    }
  }
}
