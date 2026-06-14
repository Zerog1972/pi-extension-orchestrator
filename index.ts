/**
 * Extension : Orchestrateur de Sous-Agents
 *
 * Fournit un outil `orchestrator` et des commandes pour déléguer
 * des tâches à des sous-agents spécialisés, gérés par un orchestrateur
 * centralisé qui contrôle la concurrence, les priorités et les dépendances.
 *
 * Modes :
 *   - Single   : { agent, task }
 *   - Parallel : { tasks: [{ agent, task }, ...] }
 *   - Chain    : { chain: [{ agent, task }, ...] }
 *
 * Commandes :
 *   /agents       - Lister les agents disponibles
 *   /orchestrate  - Lancer une orchestration interactive
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import {
  discoverAgents,
  formatAgentList,
} from "./agents.ts";
import { DEFAULT_AGENTS_RAW } from "./agents-defaults.ts";
import {
  executeChain,
  executeParallel,
  executeSingle,
  getResultOutput,
  isFailedResult,
  Orchestrator,
} from "./orchestrator.ts";
import { renderCall, renderResult } from "./renderer.ts";
import type { AgentScope, AgentTask, ChainTask, ExecutionDetails, SingleResult } from "./types.ts";

// ────────────────────────────────────────
// Schémas de paramètres
// ────────────────────────────────────────

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description:
    'Répertoires d\'agents à utiliser. Défaut : "user". Utiliser "both" pour inclure les agents du projet local.',
  default: "user",
});

const TaskItem = Type.Object({
  agent: Type.String({ description: "Nom de l'agent à invoquer" }),
  task: Type.String({ description: "Tâche à déléguer" }),
  cwd: Type.Optional(Type.String({ description: "Répertoire de travail pour le sous-agent" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Nom de l'agent à invoquer" }),
  task: Type.String({
    description: "Tâche avec placeholder {previous} optionnel pour la sortie de l'étape précédente",
  }),
  cwd: Type.Optional(Type.String({ description: "Répertoire de travail pour le sous-agent" })),
});

const OrchestratorParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Nom de l'agent à invoquer (mode single)" })),
  task: Type.Optional(Type.String({ description: "Tâche à déléguer (mode single)" })),
  tasks: Type.Optional(
    Type.Array(TaskItem, { description: "Tableau de {agent, task} pour exécution parallèle" }),
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, { description: "Tableau de {agent, task} pour exécution séquentielle" }),
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description: "Demander confirmation avant d'exécuter des agents du projet local. Défaut : true.",
      default: true,
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Répertoire de travail (mode single)" })),
  maxConcurrency: Type.Optional(
    Type.Number({
      description: "Nombre maximum de sous-agents simultanés. Défaut : 4, max : 8.",
      default: 4,
    }),
  ),
});

// ────────────────────────────────────────
// Extension
// ────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Outil principal ──────────────────

  pi.registerTool({
    name: "orchestrator",
    label: "Orchestrator",
    description: [
      "Délègue des tâches à des sous-agents spécialisés avec contexte isolé.",
      "Modes : single (agent + tâche), parallel (tableau de tâches), chain (séquentiel avec placeholder {previous}).",
      'Portée par défaut : "user" (depuis ~/.pi/agent/agents).',
      'Pour activer les agents du projet local (.pi/agents), utiliser agentScope: "both" ou "project".',
    ].join(" "),
    promptSnippet: "Déléguer des tâches à des agents spécialisés (scout, planner, worker, reviewer...)",
    promptGuidelines: [
      "Utilise orchestrator pour diviser un travail complexe en sous-tâches spécialisées.",
      "Préfère le mode chain pour les workflows séquentiels (scout → planner → worker).",
      "Préfère le mode parallel pour les tâches indépendantes (ex: explorer plusieurs modules simultanément).",
      "Utilise {previous} dans les tâches d'une chaîne pour transmettre le résultat de l'étape précédente.",
    ],
    parameters: OrchestratorParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = params.agentScope ?? "user";
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const confirmProjectAgents = params.confirmProjectAgents ?? true;
      const maxConcurrency = Math.min(params.maxConcurrency ?? 4, 8);

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const makeDetails =
        (mode: "single" | "parallel" | "chain") =>
        (results: SingleResult[]): ExecutionDetails => ({
          mode,
          agentScope,
          projectAgentsDir: discovery.projectAgentsDir,
          results,
        });

      // ── Validation ──
      if (modeCount !== 1) {
        const available = formatAgentList(agents, 10);
        let msg = `Paramètres invalides. Fournissez exactement un mode.\nAgents disponibles : ${available.text}`;
        if (available.remaining > 0) msg += `\n... et ${available.remaining} de plus`;
        return {
          content: [{ type: "text", text: msg }],
          details: makeDetails("single")([]),
        };
      }

      if (agents.length === 0) {
        const dirs: string[] = [];
        if (agentScope === "user" || agentScope === "both") dirs.push("~/.pi/agent/agents/");
        if (agentScope === "project" || agentScope === "both") dirs.push(".pi/agents/");
        return {
          content: [
            {
              type: "text",
              text: `Aucun agent trouvé. Lancez /agents init pour créer les agents par défaut, ou créez des fichiers .md dans ${dirs.join(" ou ")}.`,
            },
          ],
          details: makeDetails("single")([]),
        };
      }

      // ── Confirmation agents projet ──
      if (
        (agentScope === "project" || agentScope === "both") &&
        confirmProjectAgents &&
        ctx.hasUI
      ) {
        const requestedAgentNames = new Set<string>();
        if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
        if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
        if (params.agent) requestedAgentNames.add(params.agent);

        const projectAgentsRequested = Array.from(requestedAgentNames)
          .map((name) => agents.find((a) => a.name === name))
          .filter((a): a is typeof agents[number] => a?.source === "project");

        if (projectAgentsRequested.length > 0) {
          const names = projectAgentsRequested.map((a) => a.name).join(", ");
          const dir = discovery.projectAgentsDir ?? "(inconnu)";
          const ok = await ctx.ui.confirm(
            "Exécuter les agents du projet local ?",
            `Agents : ${names}\nSource : ${dir}\n\nLes agents de projet sont contrôlés par le dépôt. Continuez uniquement pour les dépôts de confiance.`,
          );
          if (!ok) {
            return {
              content: [
                {
                  type: "text",
                  text: "Annulé : agents du projet local non approuvés.",
                },
              ],
              details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
            };
          }
        }
      }

      const config = {
        cwd: ctx.cwd,
        agents,
        agentScope,
        signal,
        onUpdate,
        maxConcurrency,
      };

      // ── Mode Chaîne ──
      if (params.chain && params.chain.length > 0) {
        const results = await executeChain(config, params.chain as ChainTask[]);
        const lastResult = results[results.length - 1];
        const failedStep = results.findIndex(isFailedResult);

        if (failedStep >= 0) {
          const errorMsg = getResultOutput(results[failedStep]);
          return {
            content: [
              {
                type: "text",
                text: `Chaîne arrêtée à l'étape ${failedStep + 1} (${results[failedStep].agent}) : ${errorMsg}`,
              },
            ],
            details: makeDetails("chain")(results),
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: getResultOutput(lastResult) || "(pas de sortie)",
            },
          ],
          details: makeDetails("chain")(results),
        };
      }

      // ── Mode Parallèle ──
      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > 8) {
          return {
            content: [
              {
                type: "text",
                text: `Trop de tâches parallèles (${params.tasks.length}). Maximum : 8.`,
              },
            ],
            details: makeDetails("parallel")([]),
          };
        }

        const results = await executeParallel(config, params.tasks as AgentTask[]);
        const successCount = results.filter((r) => !isFailedResult(r)).length;

        const summaries = results.map((r) => {
          const output = getResultOutput(r);
          const status = isFailedResult(r)
            ? `échoué${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
            : "réussi";
          return `### [${r.agent}] ${status}\n\n${output}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `Parallèle : ${successCount}/${results.length} réussis\n\n${summaries.join("\n\n---\n\n")}`,
            },
          ],
          details: makeDetails("parallel")(results),
        };
      }

      // ── Mode Single ──
      if (params.agent && params.task) {
        const result = await executeSingle(
          config,
          params.agent,
          params.task,
          params.cwd,
        );

        if (isFailedResult(result)) {
          const errorMsg = getResultOutput(result);
          return {
            content: [
              {
                type: "text",
                text: `Agent ${result.stopReason || "échoué"} : ${errorMsg}`,
              },
            ],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: getResultOutput(result) || "(pas de sortie)",
            },
          ],
          details: makeDetails("single")([result]),
        };
      }

      // Fallback
      const available = formatAgentList(agents, 10);
      return {
        content: [
          {
            type: "text",
            text: `Paramètres invalides. Agents disponibles : ${available.text}`,
          },
        ],
        details: makeDetails("single")([]),
      };
    },

    // ── Rendu TUI ─────────────────────
    renderCall(args, theme, _context) {
      return renderCall(args, theme);
    },

    renderResult(result, { expanded }, theme, _context) {
      return renderResult(result, expanded, theme);
    },
  });

  // ── Commande /agents ────────────────

  pi.registerCommand("agents", {
    description: "Lister les agents disponibles et les initialiser",
    handler: async (args, ctx) => {
      const subCommand = args?.trim();

      // ── /agents init ──
      if (subCommand === "init") {
        const userDir = path.join(getAgentDir(), "agents");

        if (!fs.existsSync(userDir)) {
          try {
            fs.mkdirSync(userDir, { recursive: true });
          } catch {
            ctx.ui.notify(
              `Impossible de créer le répertoire ${userDir}`,
              "error",
            );
            return;
          }
        }

        // Vérifier quels agents existent déjà
        const existing = new Set<string>();
        if (fs.existsSync(userDir)) {
          for (const entry of fs.readdirSync(userDir, { withFileTypes: true })) {
            if (entry.name.endsWith(".md")) existing.add(entry.name.replace(".md", ""));
          }
        }

        const newAgents: string[] = [];
        const skippedAgents: string[] = [];

        for (const [name, content] of Object.entries(DEFAULT_AGENTS_RAW)) {
          const filePath = path.join(userDir, `${name}.md`);
          if (existing.has(name)) {
            skippedAgents.push(name);
          } else {
            try {
              fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o644 });
              newAgents.push(name);
            } catch (err: any) {
              ctx.ui.notify(
                `Erreur lors de l'écriture de ${filePath} : ${err.message}`,
                "error",
              );
              return;
            }
          }
        }

        let msg = "";
        if (newAgents.length > 0) {
          msg += `✅ Agents créés dans ${userDir} : ${newAgents.join(", ")}`;
        }
        if (skippedAgents.length > 0) {
          if (msg) msg += "\n";
          msg += `⚠️ Déjà présents (non écrasés) : ${skippedAgents.join(", ")}`;
        }
        if (msg) {
          ctx.ui.notify(msg, newAgents.length > 0 ? "info" : "warning");
        } else {
          ctx.ui.notify("Aucun agent à initialiser.", "info");
        }

        // Recharger les extensions pour prendre en compte les nouveaux agents
        await ctx.reload();
        return;
      }

      // ── /agents (liste) ──
      const discovery = discoverAgents(ctx.cwd, "both");
      const agents = discovery.agents;

      if (agents.length === 0) {
        ctx.ui.notify(
          "Aucun agent trouvé dans ~/.pi/agent/agents/ ou .pi/agents/",
          "warning",
        );
        return;
      }

      const items = agents.map(
        (a) =>
          `${a.name} (${a.source}) [${a.tools?.join(", ") || "tous les outils"}${a.model ? `, model: ${a.model}` : ""}] : ${a.description}`,
      );

      const choice = await ctx.ui.select("Agents disponibles :", items);
      if (choice) {
        const agent = agents.find((a) => items.indexOf(choice) === agents.indexOf(a));
        if (agent) {
          const preview = agent.systemPrompt.slice(0, 500);
          ctx.ui.notify(
            `Agent "${agent.name}"\n${agent.description}\n\nPrompt :\n${preview}${agent.systemPrompt.length > 500 ? "..." : ""}`,
            "info",
          );
        }
      }
    },
  });

  // ── Notification au démarrage ──────

  pi.on("session_start", async (_event, ctx) => {
    const discovery = discoverAgents(ctx.cwd, "both");
    const agents = discovery.agents;

    if (agents.length > 0) {
      const { text } = formatAgentList(agents, 5);
      ctx.ui.notify(`${agents.length} agent(s) disponible(s) : ${text}\n/agents init pour personnaliser`, "info");
    } else {
      ctx.ui.notify(
        "Orchestrateur chargé. Agents par défaut utilisés. /agents init pour les personnaliser.",
        "warning",
      );
    }
  });
}
