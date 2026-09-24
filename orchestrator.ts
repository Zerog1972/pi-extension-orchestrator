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
const PER_TASK_OUTPUT_CAP = 50 * 1024; // 50 KB par sous-agent
const TOTAL_OUTPUT_CAP = 160 * 1024; // 160 KB agrégées vers le contexte principal
const STDERR_CAP = 64 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024; // garde-fou sur une ligne JSONL défectueuse

/** Profondeur d'orchestration, propagée aux enfants via l'environnement */
export const DEPTH_ENV = "PI_ORCHESTRATOR_DEPTH";
export const MAX_DEPTH_ENV = "PI_ORCHESTRATOR_MAX_DEPTH";
export const DEFAULT_MAX_DEPTH = 1;

/** Outils retirés aux sous-agents : un enfant ne doit jamais relancer l'orchestrateur */
const CHILD_EXCLUDED_TOOLS = ["orchestrator"];

export function readOrchestratorDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env[DEPTH_ENV] ?? "0", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function readMaxOrchestratorDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env[MAX_DEPTH_ENV] ?? String(DEFAULT_MAX_DEPTH), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_DEPTH;
}

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

export function isRunningResult(result: SingleResult): boolean {
  return result.status === "running";
}

export function isFailedResult(result: SingleResult): boolean {
  if (result.status === "running") return false;
  if (result.status === "failed" || result.status === "cancelled") return true;
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

export function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[Sortie tronquée : ${byteLength - Buffer.byteLength(truncated, "utf8")} octets omis. Sortie complète préservée dans les détails.]`;
}

/**
 * Plafond global sur la sortie agrégée d'une exécution parallèle.
 * Sans lui, N sous-agents verbaux injectent leur intégrale dans le contexte principal.
 */
export function capTotalOutput(text: string, cap: number = TOTAL_OUTPUT_CAP): string {
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength <= cap) return text;

  let truncated = text.slice(0, cap);
  while (Buffer.byteLength(truncated, "utf8") > cap) truncated = truncated.slice(0, -1);
  // Ne pas couper au milieu d'un surrogate pair
  const last = truncated.charCodeAt(truncated.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) truncated = truncated.slice(0, -1);

  return `${truncated}\n\n[Sortie agrégée tronquée : ${byteLength - Buffer.byteLength(truncated, "utf8")} octets omis. Sorties complètes préservées dans les détails.]`;
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

/**
 * Applique `fn` avec N exécutions simultanées.
 * Si `signal` est aborté, les tâches non encore démarrées ne sont PAS lancées
 * (trous dans le tableau retourné, à la charge de l'appelant de les combler).
 */
async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
  signal?: AbortSignal,
): Promise<(TOut | undefined)[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: (TOut | undefined)[] = new Array(items.length).fill(undefined);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      if (signal?.aborted) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Résumé lisible de l'activité d'un outil pour le suivi live */
function summarizeToolActivity(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const clip = (value: string, max = 70) => (value.length > max ? `${value.slice(0, max)}…` : value);
  const candidate =
    (typeof a.command === "string" && a.command) ||
    (typeof a.path === "string" && a.path) ||
    (typeof a.file_path === "string" && a.file_path) ||
    (typeof a.pattern === "string" && a.pattern) ||
    "";
  return candidate ? `${toolName} ${clip(String(candidate))}` : toolName;
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
  // Garde anti-récursion : un sous-agent ne doit pas pouvoir relancer l'orchestrateur.
  args.push("--exclude-tools", CHILD_EXCLUDED_TOOLS.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  if (signal?.aborted) {
    return {
      agent: agentName,
      agentSource: agent.source,
      task,
      status: "cancelled",
      exitCode: 130,
      messages: [],
      stderr: "Sous-agent non lancé : signal d'annulation déjà reçu.",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      model: agent.model,
      step,
      durationMs: 0,
    };
  }

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    status: "running",
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

    // La tâche part sur stdin, pas en argv : évite la limite de ligne de commande
    // Windows (~32k caractères) quand {previous} est volumineux, et les pièges d'échappement.
    let wasAborted = false;
    let spawnError: string | null = null;

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc: ChildProcess = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, [DEPTH_ENV]: String(readOrchestratorDepth() + 1) },
      });

      if (proc.stdin) {
        proc.stdin.on("error", () => {
          /* EPIPE si l'enfant meurt très tôt : traité via exitCode/stderr */
        });
        proc.stdin.write(`Tâche : ${task}\n`, "utf-8");
        proc.stdin.end();
      }

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

        // Événements réels du flux JSON de pi : tool_execution_start/update/end.
        // (`tool_result_end` n'existe pas ; les messages toolResult arrivent via message_end.)
        if (event.type === "tool_execution_start") {
          currentResult.activity = summarizeToolActivity(event.toolName ?? "outil", event.args);
          emitUpdate();
        }
      };

      // Découpage strict sur LF, puis décodage uniquement de lignes complètes :
      // un caractère UTF-8 multi-octets coupé entre deux chunks ne peut plus être corrompu.
      const decoder = new TextDecoder("utf-8");
      let pending = Buffer.alloc(0);
      const handleChunk = (chunk: Buffer, isFinal: boolean) => {
        if (chunk.length > 0) pending = Buffer.concat([pending, chunk]);
        let lf = pending.indexOf(0x0a);
        while (lf >= 0) {
          const lineBuffer = pending.subarray(0, lf);
          pending = pending.subarray(lf + 1);
          processLine(decoder.decode(lineBuffer));
          lf = pending.indexOf(0x0a);
        }
        if (pending.length > MAX_LINE_BYTES) {
          currentResult.stderr += `\n[Ligne JSONL trop longue (> ${MAX_LINE_BYTES} octets), ignorée]`;
          pending = Buffer.alloc(0);
        }
        if (isFinal && pending.length > 0) {
          processLine(decoder.decode(pending));
          pending = Buffer.alloc(0);
        }
      };

      let stderrCapped = false;
      proc.stdout?.on("data", (data: Buffer) => handleChunk(data, false));

      proc.stderr?.on("data", (data: Buffer) => {
        if (stderrCapped) return;
        currentResult.stderr += data.toString("utf-8");
        if (currentResult.stderr.length > STDERR_CAP) {
          currentResult.stderr = `${currentResult.stderr.slice(0, STDERR_CAP)}\n[stderr tronqué]`;
          stderrCapped = true;
        }
      });

      proc.on("close", (code) => {
        handleChunk(Buffer.alloc(0), true);
        resolve(spawnError ? 1 : code ?? 0);
      });

      proc.on("error", (err) => {
        spawnError = err.message;
        if (!currentResult.stderr) currentResult.stderr = `Échec du lancement du sous-agent : ${err.message}`;
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
    currentResult.status = wasAborted
      ? "cancelled"
      : exitCode !== 0 || currentResult.stopReason === "error" || currentResult.stopReason === "aborted"
        ? "failed"
        : "ok";
    if (spawnError) currentResult.errorMessage = spawnError;
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

  /**
   * Annule les tâches en attente dont une dépendance est morte (échouée, annulée ou inconnue).
   * Sans cela, un échec laissait les dépendants « pending » pour toujours et l'orchestration
   * se terminait silencieusement avec un résultat partiel.
   */
  propagateBlockedTasks(): number {
    let cancelled = 0;
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of this.tasks) {
        if (task.status !== "pending") continue;
        const blocked = task.dependencies.some((depId) => {
          const dep = this.tasks.find((t) => t.id === depId);
          return !dep || dep.status === "failed" || dep.status === "cancelled";
        });
        if (blocked) {
          task.status = "cancelled";
          cancelled++;
          changed = true;
        }
      }
    }
    return cancelled;
  }

  /** Tâches restées en attente alors qu'aucune ne peut plus démarrer (dépendances circulaires) */
  private getDeadlockedTasks(): OrchestratedTask[] {
    const completed = new Set(
      this.tasks.filter((t) => t.status === "completed").map((t) => t.id),
    );
    return this.tasks.filter(
      (t) => t.status === "pending" && !t.dependencies.every((depId) => completed.has(depId)),
    );
  }

  private describeBlockedTasks(): string {
    const blocked = this.getDeadlockedTasks();
    if (blocked.length === 0) return "Aucune tâche exécutable : dépendances insatisfaisables.";
    const details = blocked
      .map((t) => `${t.id} (${t.agentName}) ← [${t.dependencies.join(", ")}]`)
      .join("; ");
    return `Dépendances circulaires ou insatisfaisables détectées : ${details}`;
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
          // Toutes les occurrences du placeholder, pas seulement la première.
          context = context.split(`{${depId}}`).join(output);
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

        this.propagateBlockedTasks();
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

      // Tâches restantes impossibles à démarrer : dépendances circulaires -> erreur explicite
      if (this.running.size === 0 && this.tasks.some((t) => t.status === "pending")) {
        if (signal) signal.removeEventListener("abort", abortHandler);
        rejectAll(new Error(this.describeBlockedTasks()));
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
      status: "running",
      exitCode: -1, // réservé à l'affichage : l'état réel est porté par `status`
      messages: [],
      stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    };
  }

  const emitParallelUpdate = () => {
    if (config.onUpdate) {
      const running = allResults.filter((r) => r.status === "running").length;
      const done = allResults.length - running;
      config.onUpdate({
        content: [
          { type: "text", text: `Parallèle : ${done}/${allResults.length} terminé(s), ${running} en cours...` },
        ],
        details: makeDetails([...allResults]),
      });
    }
  };

  const concurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const settled = await mapWithConcurrencyLimit(tasks, concurrency, async (t, index) => {
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
  }, config.signal);

  // Tâches jamais démarrées (annulation en cours) : on les matérialise plutôt que de les masquer.
  const results: SingleResult[] = settled.map((r, index) => {
    if (r) return r;
    const cancelled: SingleResult = {
      agent: tasks[index].agent,
      agentSource: "unknown",
      task: tasks[index].task,
      status: "cancelled",
      exitCode: 130,
      messages: [],
      stderr: "Tâche non lancée : orchestration annulée.",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    };
    allResults[index] = cancelled;
    return cancelled;
  });
  emitParallelUpdate();

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
