/**
 * Types partagés pour l'orchestrateur de sous-agents
 */

import type { Message } from "@earendil-works/pi-ai";

// ────────────────────────────────────────
// Configuration des agents
// ────────────────────────────────────────

export type AgentScope = "user" | "project" | "both";

export type RunnerMode = "single" | "parallel" | "chain";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

// ────────────────────────────────────────
// Tâches et résultats
// ────────────────────────────────────────

export interface AgentTask {
  agent: string;
  task: string;
  cwd?: string;
}

export interface ChainTask {
  agent: string;
  task: string; // peut contenir {previous} pour la sortie de l'étape précédente
  cwd?: string;
}

/** Cycle de vie explicite d'un run (ne pas déduire l'état de `exitCode`) */
export type RunStatus = "running" | "ok" | "failed" | "cancelled";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  /** État réel du run. `exitCode` reste exposé pour l'affichage, mais n'est plus la source de vérité. */
  status: RunStatus;
  /** Dernière activité observée (outil en cours), pour le suivi live */
  activity?: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  durationMs?: number;
}

export interface ExecutionDetails {
  mode: RunnerMode;
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

// ────────────────────────────────────────
// État de l'orchestrateur
// ────────────────────────────────────────

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface OrchestratedTask {
  id: string;
  agentName: string;
  task: string;
  cwd?: string;
  priority: number; // 0 = highest
  dependencies: string[]; // IDs des tâches à terminer avant
  status: TaskStatus;
  result?: SingleResult;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface OrchestratorState {
  tasks: OrchestratedTask[];
  maxConcurrency: number;
  completedCount: number;
  failedCount: number;
}

// ────────────────────────────────────────
// Affichage / formatting
// ────────────────────────────────────────

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };
