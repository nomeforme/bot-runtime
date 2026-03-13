/**
 * Experiment tools — autonomous experiment loop infrastructure.
 *
 * Provides init_experiment, run_experiment, and log_experiment tools that
 * encapsulate the autoresearch paradigm: edit → run → measure → keep/discard → repeat.
 *
 * State is reconstructed from autoresearch.jsonl on each invocation, making
 * these tools resilient to context compaction and multi-agent access.
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { mkdirSync, rmdirSync } from 'fs';
import { join } from 'path';
import type { ToolHandler } from '@connectome/agent-core';
import type { ProcessRegistry } from '../process-registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExperimentConfig {
  type: 'config';
  name: string;
  metricName: string;
  metricUnit: string;
  bestDirection: 'lower' | 'higher';
}

interface ExperimentResult {
  run: number;
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: 'keep' | 'discard' | 'crash' | 'checks_failed';
  description: string;
  timestamp: number;
  segment: number;
  agent?: string;
}

interface ExperimentState {
  name: string | null;
  metricName: string;
  metricUnit: string;
  bestDirection: 'lower' | 'higher';
  results: ExperimentResult[];
  currentSegment: number;
  secondaryMetrics: MetricDef[];
  bestMetric: number | null;
}

interface MetricDef {
  name: string;
  unit: string;
}

interface RunChecks {
  pass: boolean;
  output: string;
  duration: number;
}

// ---------------------------------------------------------------------------
// Shared context — mutable, updated per-activation by BotRuntime
// ---------------------------------------------------------------------------

export interface ExperimentToolContext {
  agentName?: string;
  agentId?: string;
  streamId?: string;
  grpcClient?: { emitEvent(topic: string, payload: any, options?: any): Promise<any> };
  /** Parent stream for cross-stream notifications (Phase 3) */
  parentStreamId?: string;
}

// Module-level state for checks gating between run_experiment and log_experiment
let lastRunChecks: RunChecks | null = null;

// ---------------------------------------------------------------------------
// State reconstruction from JSONL
// ---------------------------------------------------------------------------

function reconstructState(workdir: string): ExperimentState {
  const state: ExperimentState = {
    name: null,
    metricName: 'metric',
    metricUnit: '',
    bestDirection: 'lower',
    results: [],
    currentSegment: 0,
    secondaryMetrics: [],
    bestMetric: null,
  };

  const jsonlPath = join(workdir, 'autoresearch.jsonl');
  if (!existsSync(jsonlPath)) return state;

  try {
    const lines = readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
    let segment = 0;

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'config') {
          segment = state.results.length > 0 ? segment + 1 : 0;
          state.name = obj.name;
          state.metricName = obj.metricName || 'metric';
          state.metricUnit = obj.metricUnit || '';
          state.bestDirection = obj.bestDirection || 'lower';
          state.currentSegment = segment;
        } else if (obj.run !== undefined) {
          const result: ExperimentResult = {
            run: obj.run,
            commit: obj.commit || '',
            metric: obj.metric ?? 0,
            metrics: obj.metrics || {},
            status: obj.status || 'discard',
            description: obj.description || '',
            timestamp: obj.timestamp || 0,
            segment: obj.segment ?? segment,
            agent: obj.agent,
          };
          state.results.push(result);

          // Track secondary metrics
          for (const name of Object.keys(result.metrics)) {
            if (!state.secondaryMetrics.find((m) => m.name === name)) {
              let unit = '';
              if (name.endsWith('_us') || name.includes('us')) unit = 'us';
              else if (name.endsWith('_ms') || name.includes('ms')) unit = 'ms';
              else if (name.endsWith('_s') || name.includes('sec')) unit = 's';
              state.secondaryMetrics.push({ name, unit });
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Compute best metric for current segment
    const segResults = state.results.filter((r) => r.segment === state.currentSegment && r.status === 'keep');
    if (segResults.length > 0) {
      state.bestMetric = segResults[0].metric; // baseline
    }
  } catch {
    // File read error — return default state
  }

  return state;
}

function resolveWorkdir(input: Record<string, any>): string {
  return input.workdir || '/workspace/shared';
}

function formatNum(value: number, unit: string): string {
  if (unit) return `${value}${unit}`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6);
}

// ---------------------------------------------------------------------------
// Wait helper (duplicated from terminal-tool.ts to avoid coupling)
// ---------------------------------------------------------------------------

function waitForExit(
  registry: ProcessRegistry,
  sessionId: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const check = () => {
      const poll = registry.poll(sessionId);
      if (poll.status === 'exited') {
        resolve(registry.log(sessionId));
        return;
      }
      if (Date.now() > deadline) {
        registry.kill(sessionId);
        resolve(
          registry.log(sessionId) + '\n\n[Process killed: timeout after ' + timeoutMs + 'ms]',
        );
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Tool 1: init_experiment
// ---------------------------------------------------------------------------

export function createInitExperimentTool(
  ctx: ExperimentToolContext,
): ToolHandler {
  return {
    name: 'init_experiment',
    description:
      'Initialize an autoresearch experiment session. Sets the name, primary metric, unit, ' +
      'and direction. Writes a config header to autoresearch.jsonl. Call once before the first ' +
      'run_experiment. Call again to re-initialize with a new baseline when the optimization target changes.',
    parameters: {
      name: {
        type: 'string',
        description: 'Human-readable session name (e.g. "Optimize liquid parser")',
      },
      metric_name: {
        type: 'string',
        description: 'Primary metric name (e.g. "val_bpb", "seconds", "bundle_kb")',
      },
      metric_unit: {
        type: 'string',
        description: 'Metric unit (e.g. "s", "ms", "KB", ""). Default: ""',
      },
      direction: {
        type: 'string',
        description: '"lower" or "higher" is better. Default: "lower"',
      },
      workdir: {
        type: 'string',
        description: 'Working directory for autoresearch.jsonl. Default: /workspace/shared',
      },
    },
    required: ['name', 'metric_name'],
    handler: async (input: Record<string, any>): Promise<string> => {
      const name = input.name;
      const metricName = input.metric_name;
      if (!name || !metricName) {
        return 'Error: name and metric_name are required';
      }

      const workdir = resolveWorkdir(input);
      const metricUnit = input.metric_unit ?? '';
      const direction = input.direction === 'higher' ? 'higher' : 'lower';

      // Check if this is a re-init
      const existing = reconstructState(workdir);
      const isReinit = existing.results.length > 0;

      const config: ExperimentConfig = {
        type: 'config',
        name,
        metricName,
        metricUnit,
        bestDirection: direction,
      };

      try {
        const jsonlPath = join(workdir, 'autoresearch.jsonl');
        const line = JSON.stringify(config) + '\n';
        if (isReinit) {
          appendFileSync(jsonlPath, line);
        } else {
          writeFileSync(jsonlPath, line);
        }
      } catch (e: any) {
        return `Error writing autoresearch.jsonl: ${e.message}`;
      }

      const reinitNote = isReinit ? ' (re-initialized — previous results archived, new baseline needed)' : '';
      return `Experiment initialized: "${name}"${reinitNote}\nMetric: ${metricName} (${metricUnit || 'unitless'}, ${direction} is better)\nConfig written to autoresearch.jsonl. Now run the baseline with run_experiment.`;
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 2: run_experiment
// ---------------------------------------------------------------------------

export function createRunExperimentTool(
  ctx: ExperimentToolContext,
  registry: ProcessRegistry,
): ToolHandler {
  return {
    name: 'run_experiment',
    description:
      'Run a shell command as a timed experiment. Captures exit code, wall-clock duration, ' +
      'and output (last 80 lines). If autoresearch.checks.sh exists in the working directory, ' +
      'it runs automatically after passing benchmarks. Call log_experiment after this.',
    parameters: {
      command: {
        type: 'string',
        description: 'Shell command to run (e.g. "bash autoresearch.sh", "uv run train.py")',
      },
      timeout_seconds: {
        type: 'number',
        description: 'Kill after N seconds. Default: 600 (10 minutes)',
      },
      checks_timeout_seconds: {
        type: 'number',
        description: 'Timeout for autoresearch.checks.sh in seconds. Default: 300 (5 minutes)',
      },
      workdir: {
        type: 'string',
        description: 'Working directory. Default: /workspace/shared',
      },
    },
    required: ['command'],
    handler: async (input: Record<string, any>): Promise<string> => {
      const command = input.command;
      if (!command) return 'Error: command is required';

      const workdir = resolveWorkdir(input);
      const timeoutMs = ((input.timeout_seconds as number) ?? 600) * 1000;
      const checksTimeoutMs = ((input.checks_timeout_seconds as number) ?? 300) * 1000;

      // Run the benchmark
      const t0 = Date.now();
      let session;
      try {
        session = registry.spawn(command, { cwd: workdir, pty: false });
      } catch (e: any) {
        return `Error spawning process: ${e.message}`;
      }

      const output = await waitForExit(registry, session.id, timeoutMs);
      const durationSeconds = (Date.now() - t0) / 1000;

      const poll = registry.poll(session.id);
      const exitCode = poll.exitCode ?? -1;
      const timedOut = output.includes('[Process killed: timeout');
      const benchmarkPassed = exitCode === 0 && !timedOut;

      // Tail output to last 80 lines
      const tailOutput = output.split('\n').slice(-80).join('\n');

      // Run backpressure checks if benchmark passed and checks file exists
      let checksPass: boolean | null = null;
      let checksTimedOut = false;
      let checksOutput = '';
      let checksDuration = 0;

      const checksPath = join(workdir, 'autoresearch.checks.sh');
      if (benchmarkPassed && existsSync(checksPath)) {
        const ct0 = Date.now();
        try {
          const checksSession = registry.spawn(`bash ${checksPath}`, { cwd: workdir, pty: false });
          const checksRaw = await waitForExit(registry, checksSession.id, checksTimeoutMs);
          checksDuration = (Date.now() - ct0) / 1000;
          const checksPoll = registry.poll(checksSession.id);
          checksTimedOut = checksRaw.includes('[Process killed: timeout');
          checksPass = (checksPoll.exitCode === 0) && !checksTimedOut;
          checksOutput = checksRaw.split('\n').slice(-80).join('\n');
        } catch (e: any) {
          checksDuration = (Date.now() - ct0) / 1000;
          checksPass = false;
          checksOutput = e.message;
        }
      }

      // Store checks state for log_experiment gating
      lastRunChecks = checksPass !== null ? { pass: checksPass, output: checksOutput, duration: checksDuration } : null;

      // Build response
      let text = '';
      if (timedOut) {
        text += `TIMEOUT after ${durationSeconds.toFixed(1)}s\n`;
      } else if (!benchmarkPassed) {
        text += `FAILED (exit code ${exitCode}) in ${durationSeconds.toFixed(1)}s\n`;
      } else if (checksTimedOut) {
        text += `Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `CHECKS TIMEOUT (autoresearch.checks.sh) after ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed'.\n`;
      } else if (checksPass === false) {
        text += `Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `CHECKS FAILED (autoresearch.checks.sh) in ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed'.\n`;
      } else {
        text += `PASSED in ${durationSeconds.toFixed(1)}s\n`;
        if (checksPass === true) {
          text += `Checks passed in ${checksDuration.toFixed(1)}s\n`;
        }
      }

      // Show current best from state
      const state = reconstructState(workdir);
      if (state.bestMetric !== null) {
        text += `Current best ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}\n`;
      }

      text += `\nLast 80 lines of output:\n${tailOutput}`;

      if (checksPass === false) {
        text += `\n\n-- Checks output (last 80 lines) --\n${checksOutput}`;
      }

      return text;
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 3: log_experiment
// ---------------------------------------------------------------------------

export function createLogExperimentTool(
  ctx: ExperimentToolContext,
  registry: ProcessRegistry,
): ToolHandler {
  return {
    name: 'log_experiment',
    description:
      'Record an experiment result. Auto-commits on "keep" (git add -A && git commit with Result trailer). ' +
      'Auto-reverts on "discard"/"crash"/"checks_failed" (git checkout -- .). ' +
      'Appends to autoresearch.jsonl. Call after every run_experiment.',
    parameters: {
      metric: {
        type: 'number',
        description: 'Primary metric value (0 for crashes)',
      },
      status: {
        type: 'string',
        description: '"keep", "discard", "crash", or "checks_failed"',
      },
      description: {
        type: 'string',
        description: 'What this experiment tried (used as git commit message)',
      },
      metrics: {
        type: 'object',
        description: 'Secondary metrics as {name: value} (e.g. {"parse_ms": 120, "memory_mb": 44.2})',
      },
      workdir: {
        type: 'string',
        description: 'Working directory. Default: /workspace/shared',
      },
    },
    required: ['metric', 'status', 'description'],
    handler: async (input: Record<string, any>): Promise<string> => {
      const metric = input.metric as number;
      const status = input.status as string;
      const description = input.description as string;
      const secondaryMetrics: Record<string, number> = input.metrics ?? {};
      const workdir = resolveWorkdir(input);

      if (!['keep', 'discard', 'crash', 'checks_failed'].includes(status)) {
        return 'Error: status must be "keep", "discard", "crash", or "checks_failed"';
      }
      if (typeof metric !== 'number') {
        return 'Error: metric must be a number';
      }
      if (!description) {
        return 'Error: description is required';
      }

      // Gate: prevent "keep" when last run's checks failed
      if (status === 'keep' && lastRunChecks && !lastRunChecks.pass) {
        return `Cannot keep — autoresearch.checks.sh failed.\n${lastRunChecks.output.slice(-500)}\nLog as 'checks_failed' instead.`;
      }

      const state = reconstructState(workdir);

      // Validate secondary metrics consistency
      if (state.secondaryMetrics.length > 0) {
        const knownNames = new Set(state.secondaryMetrics.map((m) => m.name));
        const providedNames = new Set(Object.keys(secondaryMetrics));
        const missing = [...knownNames].filter((n) => !providedNames.has(n));
        if (missing.length > 0) {
          return `Missing secondary metrics: ${missing.join(', ')}. Expected: ${[...knownNames].join(', ')}`;
        }
      }

      let commit = '';
      let gitMessage = '';

      if (status === 'keep') {
        // Auto-commit
        try {
          const resultData: Record<string, unknown> = {
            status,
            [state.metricName || 'metric']: metric,
            ...secondaryMetrics,
          };
          if (ctx.agentName) resultData.agent = ctx.agentName;
          const trailerJson = JSON.stringify(resultData);
          const commitMsg = `${description}\n\nResult: ${trailerJson}`;

          // Escape the commit message for shell
          const escapedMsg = commitMsg.replace(/'/g, "'\\''");
          const gitCmd = `git add -A && git diff --cached --quiet && echo "NOTHING_TO_COMMIT" || git commit -m '${escapedMsg}'`;

          const gitSession = registry.spawn(gitCmd, { cwd: workdir, pty: false });
          const gitOutput = await waitForExit(registry, gitSession.id, 15_000);
          const gitPoll = registry.poll(gitSession.id);

          if (gitOutput.includes('NOTHING_TO_COMMIT')) {
            gitMessage = 'Git: nothing to commit (working tree clean)';
          } else if (gitPoll.exitCode === 0) {
            const firstLine = gitOutput.trim().split('\n')[0] || '';
            gitMessage = `Git: committed — ${firstLine}`;

            // Get actual commit hash
            const shaSession = registry.spawn('git rev-parse --short=7 HEAD', { cwd: workdir, pty: false });
            const shaOutput = await waitForExit(registry, shaSession.id, 5_000);
            const sha = shaOutput.trim().split('\n').pop()?.trim();
            if (sha && sha.length >= 7) {
              commit = sha;
            }
          } else {
            gitMessage = `Git commit failed (exit ${gitPoll.exitCode}): ${gitOutput.trim().slice(0, 200)}`;
          }
        } catch (e: any) {
          gitMessage = `Git commit error: ${e.message}`;
        }
      } else {
        // Auto-revert for discard/crash/checks_failed
        try {
          const revertSession = registry.spawn('git checkout -- .', { cwd: workdir, pty: false });
          await waitForExit(registry, revertSession.id, 10_000);
          gitMessage = `Git: reverted (${status})`;
        } catch {
          gitMessage = 'Git: revert skipped';
        }
      }

      // Get current commit hash if we don't have one yet
      if (!commit) {
        try {
          const shaSession = registry.spawn('git rev-parse --short=7 HEAD', { cwd: workdir, pty: false });
          const shaOutput = await waitForExit(registry, shaSession.id, 5_000);
          commit = shaOutput.trim().split('\n').pop()?.trim() || 'unknown';
        } catch {
          commit = 'unknown';
        }
      }

      // Build result entry
      const experiment: ExperimentResult = {
        run: state.results.length + 1,
        commit,
        metric,
        metrics: secondaryMetrics,
        status: status as ExperimentResult['status'],
        description,
        timestamp: Date.now(),
        segment: state.currentSegment,
        agent: ctx.agentName,
      };

      // Append to autoresearch.jsonl
      try {
        const jsonlPath = join(workdir, 'autoresearch.jsonl');
        appendFileSync(jsonlPath, JSON.stringify(experiment) + '\n');
      } catch {
        // Non-fatal
      }

      // Append to shared results.tsv (Phase 3: multi-agent coordination)
      try {
        const tsvPath = join(workdir, 'results.tsv');
        const tsvLine = [
          commit,
          typeof metric === 'number' ? metric.toFixed(6) : '0',
          ctx.agentName || 'unknown',
          status,
          description.replace(/\t/g, ' '),
        ].join('\t') + '\n';

        // mkdir-based advisory lock (atomic on Linux)
        const lockDir = tsvPath + '.lock';
        let acquired = false;
        const deadline = Date.now() + 5000;

        while (Date.now() < deadline) {
          try {
            mkdirSync(lockDir);
            acquired = true;
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 50));
          }
        }

        if (acquired) {
          try {
            if (!existsSync(tsvPath)) {
              writeFileSync(tsvPath, 'commit\tmetric\tagent\tstatus\tdescription\n');
            }
            appendFileSync(tsvPath, tsvLine);
          } finally {
            try { rmdirSync(lockDir); } catch {}
          }
        }
      } catch {
        // Non-fatal — TSV is convenience, JSONL is authoritative
      }

      // Clear checks state
      lastRunChecks = null;

      // Build response text
      let text = `Logged #${experiment.run}: ${status} — ${description}`;

      if (state.bestMetric !== null) {
        text += `\nBaseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`;
        if (state.results.length > 0 && status === 'keep' && metric > 0) {
          const delta = metric - state.bestMetric;
          const pct = state.bestMetric !== 0 ? ((delta / state.bestMetric) * 100).toFixed(1) : '0.0';
          const sign = delta > 0 ? '+' : '';
          text += ` | this: ${formatNum(metric, state.metricUnit)} (${sign}${pct}%)`;
        }
      }

      // Show secondary metrics
      if (Object.keys(secondaryMetrics).length > 0) {
        const parts: string[] = [];
        for (const [name, value] of Object.entries(secondaryMetrics)) {
          const def = state.secondaryMetrics.find((m) => m.name === name);
          parts.push(`${name}: ${formatNum(value, def?.unit ?? '')}`);
        }
        text += `\nSecondary: ${parts.join('  ')}`;
      }

      text += `\n(${experiment.run} experiments total)`;
      text += `\n${gitMessage}`;

      // Phase 3: emit discovery notification on parent stream for significant improvements
      if (status === 'keep' && state.bestMetric !== null && state.bestMetric !== 0 && ctx.parentStreamId && ctx.grpcClient) {
        const delta = metric - state.bestMetric;
        const improvementPct = Math.abs((delta / state.bestMetric) * 100);
        const isBetter = (state.bestDirection === 'lower' && delta < 0) ||
                         (state.bestDirection === 'higher' && delta > 0);
        if (isBetter && improvementPct > 5) {
          ctx.grpcClient.emitEvent('agent:speech', {
            agentName: ctx.agentName,
            agentId: ctx.agentId,
            content: `[autoresearch] ${ctx.agentName} found ${improvementPct.toFixed(1)}% improvement: ${description}`,
            streamId: ctx.parentStreamId,
            timestamp: Date.now(),
          }).catch(() => {});
        }
      }

      return text;
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 4: experiment_dashboard
// ---------------------------------------------------------------------------

export function createExperimentDashboardTool(
  ctx: ExperimentToolContext,
): ToolHandler {
  return {
    name: 'experiment_dashboard',
    description:
      'Render a markdown snapshot of the current autoresearch experiment dashboard. ' +
      'Shows summary stats, baseline, best result, and a results table with the primary metric ' +
      'and all secondary metric columns (dynamic per session). Use to share progress in chat.',
    parameters: {
      workdir: {
        type: 'string',
        description: 'Working directory containing autoresearch.jsonl. Default: /workspace/shared',
      },
      last: {
        type: 'number',
        description: 'Show only the last N experiments. Default: all',
      },
    },
    handler: async (input: Record<string, any>): Promise<string> => {
      const workdir = resolveWorkdir(input);
      const state = reconstructState(workdir);

      if (state.results.length === 0) {
        return 'No experiments recorded yet. Run init_experiment to start.';
      }

      const segResults = state.results.filter((r) => r.segment === state.currentSegment);
      const kept = segResults.filter((r) => r.status === 'keep');
      const discarded = segResults.filter((r) => r.status === 'discard');
      const crashed = segResults.filter((r) => r.status === 'crash');
      const checksFailed = segResults.filter((r) => r.status === 'checks_failed');

      // Determine if multi-agent (show agent column?)
      const agents = new Set(segResults.map((r) => r.agent).filter(Boolean));
      const multiAgent = agents.size > 1;

      // Find baseline and best kept result
      const baseline = kept.length > 0 ? kept[0] : null;
      let best = baseline;
      if (best && kept.length > 1) {
        for (const r of kept.slice(1)) {
          if (state.bestDirection === 'lower' && r.metric < best.metric) best = r;
          if (state.bestDirection === 'higher' && r.metric > best.metric) best = r;
        }
      }

      // Header
      let md = `## Autoresearch: ${state.name || 'Experiment'}\n`;
      md += `**${segResults.length} runs**`;
      if (kept.length) md += ` | ${kept.length} kept`;
      if (discarded.length) md += ` | ${discarded.length} discarded`;
      if (crashed.length) md += ` | ${crashed.length} crashed`;
      if (checksFailed.length) md += ` | ${checksFailed.length} checks failed`;
      md += '\n';

      if (baseline) {
        md += `**Baseline** ${state.metricName}: ${formatNum(baseline.metric, state.metricUnit)} (#${baseline.run})\n`;
      }
      if (best && baseline && best.run !== baseline.run) {
        const delta = best.metric - baseline.metric;
        const pct = baseline.metric !== 0 ? ((delta / baseline.metric) * 100).toFixed(1) : '0.0';
        const sign = delta > 0 ? '+' : '';
        md += `**Best** ${state.metricName}: ${formatNum(best.metric, state.metricUnit)} (#${best.run}, ${sign}${pct}%)\n`;
      }
      if (multiAgent) {
        md += `**Agents**: ${[...agents].join(', ')}\n`;
      }
      md += '\n';

      // Build table columns: fixed cols + dynamic secondary metrics
      const secNames = state.secondaryMetrics.map((m) => m.name);
      const cols: string[] = ['#', 'commit'];
      if (multiAgent) cols.push('agent');
      cols.push(state.metricName);
      cols.push(...secNames);
      cols.push('status', 'description');

      // Table header
      md += '| ' + cols.join(' | ') + ' |\n';
      md += '| ' + cols.map(() => '---').join(' | ') + ' |\n';

      // Determine which results to show
      let displayResults = segResults;
      const lastN = input.last as number | undefined;
      if (lastN && lastN > 0 && displayResults.length > lastN) {
        const skipped = displayResults.length - lastN;
        displayResults = displayResults.slice(-lastN);
        // Ellipsis row
        const emptyCols = cols.map((_, i) => i === cols.length - 2 ? `*${skipped} earlier*` : '');
        md += '| ' + emptyCols.join(' | ') + ' |\n';
      }

      // Data rows
      for (const r of displayResults) {
        // Primary metric cell with delta vs baseline
        let metricCell = formatNum(r.metric, state.metricUnit);
        if (baseline && r.run !== baseline.run && baseline.metric !== 0 && r.metric > 0) {
          const delta = r.metric - baseline.metric;
          const pct = ((delta / baseline.metric) * 100).toFixed(1);
          const sign = delta > 0 ? '+' : '';
          metricCell += ` (${sign}${pct}%)`;
        }
        // Bold kept non-baseline results
        if (r.status === 'keep' && r.run !== baseline?.run) {
          metricCell = `**${metricCell}**`;
        }

        const cells: string[] = [
          String(r.run),
          r.commit || '-',
        ];
        if (multiAgent) cells.push(r.agent || '-');
        cells.push(metricCell);

        // Secondary metric cells
        for (const secName of secNames) {
          const val = r.metrics[secName];
          if (val !== undefined) {
            const def = state.secondaryMetrics.find((m) => m.name === secName);
            cells.push(formatNum(val, def?.unit ?? ''));
          } else {
            cells.push('-');
          }
        }

        cells.push(r.status);
        cells.push(r.description.length > 50 ? r.description.slice(0, 47) + '...' : r.description);

        md += '| ' + cells.join(' | ') + ' |\n';
      }

      return md;
    },
  };
}
