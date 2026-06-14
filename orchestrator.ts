/**
 * Orchestrateur de sous-agents
 *
 * Responsabilités :
 *  - File d'attente de tâches avec priorités et dépendances
 *  - Contrôle de concurrence (max N sous-agents simultanés)
 *  - Lancement de processus pi isolés par sous-agent
 *  - Suivi de progression en streaming
 *  - Support de l'annulation (AbortSignal)
 *  - Agrégation des résultats (single, parallel, chain)
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.ts";
import type {
  AgentConfig,
  AgentScope,
  AgentTask,
  ChainTask,
  DisplayItem,
  ExecutionDetails,
  OrchestratedTask,
  RunnerMode,
  SingleResult,
  UsageStats,
} from "./types.ts";

// ────────────────────────────────────────
// Constantes
// ────────────────────────────────────────

const MAX_PARALLEL_TASKS = 8;
const DEFAULT_MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024; // 50 KB

// ────────────────────────────────────────
// Utilitaires de formatage
// ────────────────────────────────────────

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} tour${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: any, text: string) => string,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const filePathRaw = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(filePathRaw);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const filePathRaw = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(filePathRaw);
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lignes)`);
      return text;
    }
    case "edit": {
      const filePathRaw = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(filePathRaw));
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` dans ${shortenPath(rawPath)}`);
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "grep ") +
        themeFg("accent", `/${pattern}/`) +
        themeFg("dim", ` dans ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

// ────────────────────────────────────────
// Utilitaires sur les résultats
// ────────────────────────────────────────

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export function isFailedResult(result: SingleResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted"
  );
}

export function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(pas de sortie)";
  }
  return getFinalOutput(result.messages) || "(pas de sortie)";
}

function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[Sortie tronquée : ${byteLength - Buffer.byteLength(truncated, "utf8")} octets omis. Sortie complète préservée dans les détails.]`;
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall") {
          items.push({ type: "toolCall", name: part.name, args: part.arguments });
        }
      }
    }
  }
  return items;
}

// ────────────────────────────────────────
// Contrôle de concurrence
// ────────────────────────────────────────

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return workers.length > 0 ? results : [];
}

// ────────────────────────────────────────
// Lancement du processus pi
// ────────────────────────────────────────

async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

// ────────────────────────────────────────
// Exécution d'un agent unique
// ────────────────────────────────────────

type OnUpdateCallback = (partial: AgentToolResult<ExecutionDetails>) => void;

export async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => ExecutionDetails,
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "aucun";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Agent inconnu : "${agentName}". Agents disponibles : ${available}.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step,
    };
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: agent.model,
    step,
    durationMs: 0,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(exécution...)" }],
        details: makeDetails([currentResult]),
      });
    }
  };

  const startTime = Date.now();

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    args.push(`Tâche : ${task}`);
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc: ChildProcess = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          currentResult.messages.push(msg);

          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          }
          emitUpdate();
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message as Message);
          emitUpdate();
        }
      };

      proc.stdout?.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr?.on("data", (data: Buffer) => {
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        resolve(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    currentResult.durationMs = Date.now() - startTime;
    if (wasAborted) throw new Error("Sous-agent annulé");
    return currentResult;
  } finally {
    if (tmpPromptPath) {
      try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
    }
    if (tmpPromptDir) {
      try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
    }
  }
}

// ────────────────────────────────────────
// Classe Orchestrateur
// ────────────────────────────────────────

export class Orchestrator {
  private tasks: OrchestratedTask[] = [];
  private maxConcurrency: number = DEFAULT_MAX_CONCURRENCY;
  private running: Set<string> = new Set();
  private taskCounter = 0;

  constructor(maxConcurrency?: number) {
    if (maxConcurrency !== undefined) this.maxConcurrency = maxConcurrency;
  }

  /** Ajoute une tâche à la file d'attente */
  enqueue(task: Omit<OrchestratedTask, "id" | "status" | "createdAt">): string {
    const id = `task-${++this.taskCounter}`;
    this.tasks.push({
      ...task,
      id,
      status: "pending",
      createdAt: Date.now(),
    });
    return id;
  }

  /** Ajoute plusieurs tâches d'un coup */
  enqueueAll(tasks: Omit<OrchestratedTask, "id" | "status" | "createdAt">[]): string[] {
    return tasks.map((t) => this.enqueue(t));
  }

  /** Récupère les tâches prêtes à être exécutées (dépendances satisfaites) */
  private getReadyTasks(): OrchestratedTask[] {
    const completed = new Set(
      this.tasks
        .filter((t) => t.status === "completed")
        .map((t) => t.id),
    );

    return this.tasks
      .filter(
        (t) =>
          t.status === "pending" &&
          t.dependencies.every((depId) => completed.has(depId)) &&
          !this.running.has(t.id),
      )
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  }

  /** Nombre de slots disponibles */
  get availableSlots(): number {
    return Math.max(0, this.maxConcurrency - this.running.size);
  }

  /** Exécute toutes les tâches de la file (respecte priorités, dépendances, concurrence) */
  async executeAll(
    cwd: string,
    agents: AgentConfig[],
    signal?: AbortSignal,
    onTaskStart?: (task: OrchestratedTask) => void,
    onTaskComplete?: (task: OrchestratedTask, result: SingleResult) => void,
  ): Promise<SingleResult[]> {
    const results: SingleResult[] = [];
    const taskResults = new Map<string, SingleResult>();

    // Construire un contexte partagé pour les tâches (résultats des tâches précédentes)
    const getTaskContext = (task: OrchestratedTask): string => {
      let context = task.task;
      for (const depId of task.dependencies) {
        const depResult = taskResults.get(depId);
        if (depResult) {
          const output = getFinalOutput(depResult.messages);
          context = context.replace(`{${depId}}`, output);
        }
      }
      return context;
    };

    return new Promise<SingleResult[]>((resolveAll, rejectAll) => {
      let cancelled = false;

      const abortHandler = () => {
        cancelled = true;
        rejectAll(new Error("Orchestration annulée"));
      };

      if (signal) {
        if (signal.aborted) {
          abortHandler();
          return;
        }
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      const tryScheduleNext = () => {
        if (cancelled) return;

        const ready = this.getReadyTasks();
        const toStart = ready.slice(0, this.availableSlots);

        for (const task of toStart) {
          this.running.add(task.id);
          task.status = "running";
          task.startedAt = Date.now();
          onTaskStart?.(task);

          const taskWithContext = getTaskContext(task);

          runSingleAgent(
            cwd,
            agents,
            task.agentName,
            taskWithContext,
            task.cwd,
            undefined,
            signal,
            undefined, // pas de streaming pour l'instant
            (r) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results: r }),
          )
            .then((result) => {
              if (cancelled) return;

              task.status = isFailedResult(result) ? "failed" : "completed";
              task.result = result;
              task.completedAt = Date.now();
              taskResults.set(task.id, result);
              results.push(result);
              this.running.delete(task.id);

              onTaskComplete?.(task, result);
              tryScheduleNext();
              checkDone();
            })
            .catch((err) => {
              if (cancelled) return;
              task.status = "failed";
              task.completedAt = Date.now();
              this.running.delete(task.id);
              results.push({
                agent: task.agentName,
                agentSource: "unknown",
                task: task.task,
                exitCode: 1,
                messages: [],
                stderr: String(err),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
              });
              tryScheduleNext();
              checkDone();
            });
        }
      };

      const checkDone = () => {
        const allDone =
          this.tasks.every((t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled") &&
          this.running.size === 0;
        if (allDone) {
          if (signal) signal.removeEventListener("abort", abortHandler);
          resolveAll(results);
        }
      };

      // Démarrer les premières tâches
      tryScheduleNext();

      // Si aucune tâche n'est prête (ex: dépendances circulaires)
      if (this.running.size === 0 && this.tasks.some((t) => t.status === "pending")) {
        if (signal) signal.removeEventListener("abort", abortHandler);
        resolveAll(results);
      }
    });
  }

  /** Annule toutes les tâches */
  cancelAll(): void {
    for (const task of this.tasks) {
      if (task.status === "pending" || task.status === "running") {
        task.status = "cancelled";
      }
    }
    this.running.clear();
  }

  /** État actuel de l'orchestrateur */
  getState(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  } {
    return {
      total: this.tasks.length,
      pending: this.tasks.filter((t) => t.status === "pending").length,
      running: this.running.size,
      completed: this.tasks.filter((t) => t.status === "completed").length,
      failed: this.tasks.filter((t) => t.status === "failed").length,
    };
  }
}

// ────────────────────────────────────────
// Exécuteurs de haut niveau (single / parallel / chain)
// ────────────────────────────────────────

export type OrchestratorConfig = {
  cwd: string;
  agents: AgentConfig[];
  agentScope: AgentScope;
  signal?: AbortSignal;
  onUpdate?: OnUpdateCallback;
  maxConcurrency?: number;
};

function makeDetailsFactory(mode: RunnerMode, agentScope: AgentScope, projectAgentsDir: string | null) {
  return (results: SingleResult[]): ExecutionDetails => ({
    mode,
    agentScope,
    projectAgentsDir,
    results,
  });
}

/** Mode single : un agent, une tâche */
export async function executeSingle(
  config: OrchestratorConfig,
  agentName: string,
  task: string,
  cwd?: string,
): Promise<SingleResult> {
  return runSingleAgent(
    config.cwd,
    config.agents,
    agentName,
    task,
    cwd,
    undefined,
    config.signal,
    config.onUpdate,
    makeDetailsFactory("single", config.agentScope, null),
  );
}

/** Mode parallel : plusieurs agents exécutés simultanément */
export async function executeParallel(
  config: OrchestratorConfig,
  tasks: AgentTask[],
): Promise<SingleResult[]> {
  if (tasks.length > MAX_PARALLEL_TASKS) {
    throw new Error(`Trop de tâches parallèles (${tasks.length}). Max : ${MAX_PARALLEL_TASKS}.`);
  }

  const projectAgentsDir: string | null = null;
  const allResults: SingleResult[] = new Array(tasks.length);
  const makeDetails = makeDetailsFactory("parallel", config.agentScope, projectAgentsDir);

  for (let i = 0; i < tasks.length; i++) {
    allResults[i] = {
      agent: tasks[i].agent,
      agentSource: "unknown",
      task: tasks[i].task,
      exitCode: -1, // -1 = en cours
      messages: [],
      stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    };
  }

  const emitParallelUpdate = () => {
    if (config.onUpdate) {
      const running = allResults.filter((r) => r.exitCode === -1).length;
      const done = allResults.filter((r) => r.exitCode !== -1).length;
      config.onUpdate({
        content: [
          { type: "text", text: `Parallèle : ${done}/${allResults.length} terminé(s), ${running} en cours...` },
        ],
        details: makeDetails([...allResults]),
      });
    }
  };

  const concurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const results = await mapWithConcurrencyLimit(tasks, concurrency, async (t, index) => {
    const result = await runSingleAgent(
      config.cwd,
      config.agents,
      t.agent,
      t.task,
      t.cwd,
      undefined,
      config.signal,
      (partial) => {
        if (partial.details?.results[0]) {
          allResults[index] = partial.details.results[0];
          emitParallelUpdate();
        }
      },
      makeDetails,
    );
    allResults[index] = result;
    emitParallelUpdate();
    return result;
  });

  return results;
}

/** Mode chain : exécution séquentielle avec placeholder {previous} */
export async function executeChain(
  config: OrchestratorConfig,
  chain: ChainTask[],
): Promise<SingleResult[]> {
  const results: SingleResult[] = [];
  const projectAgentsDir: string | null = null;
  const makeDetails = makeDetailsFactory("chain", config.agentScope, projectAgentsDir);
  let previousOutput = "";

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

    const chainUpdate: OnUpdateCallback | undefined = config.onUpdate
      ? (partial) => {
          const currentResult = partial.details?.results[0];
          if (currentResult) {
            const all = [...results, currentResult];
            config.onUpdate({
              content: partial.content,
              details: makeDetails(all),
            });
          }
        }
      : undefined;

    const result = await runSingleAgent(
      config.cwd,
      config.agents,
      step.agent,
      taskWithContext,
      step.cwd,
      i + 1,
      config.signal,
      chainUpdate,
      makeDetails,
    );
    results.push(result);

    if (isFailedResult(result)) {
      break; // Arrêt immédiat en cas d'échec
    }
    previousOutput = getFinalOutput(result.messages);
  }

  return results;
}
