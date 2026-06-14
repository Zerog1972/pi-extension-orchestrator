/**
 * Découverte et configuration des agents
 *
 * Cherche les définitions d'agents dans :
 *   - ~/.pi/agent/agents/*.md   (utilisateur)
 *   - .pi/agents/*.md           (projet local)
 *
 * Chaque fichier .md contient un frontmatter YAML avec :
 *   name, description, tools, model
 * suivi du system prompt en markdown.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGENTS } from "./agents-defaults.ts";
import type { AgentConfig, AgentScope } from "./types.ts";

// ────────────────────────────────────────
// Chargement depuis un répertoire
// ────────────────────────────────────────

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(dir)) return agents;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const parsed = parseFrontmatter<Record<string, string>>(content);
    const { frontmatter, body } = parsed;

    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ?.split(",")
      .map((t: string) => t.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

// ────────────────────────────────────────
// Recherche du répertoire projet
// ────────────────────────────────────────

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

// ────────────────────────────────────────
// API publique
// ────────────────────────────────────────

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

/** Charge les agents par défaut embarqués dans l'extension (fallback) */
function loadDefaultAgents(): AgentConfig[] {
  return DEFAULT_AGENTS.map((a) => ({
    ...a,
    source: "user" as const,
    filePath: "(embarqué)",
  }));
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const projectAgents = scope === "user" || !projectAgentsDir
    ? []
    : loadAgentsFromDir(projectAgentsDir, "project");

  const agentMap = new Map<string, AgentConfig>();

  // Les agents par défaut embarqués servent de base (priorité la plus basse)
  // Ils sont utilisés uniquement si aucun agent n'est trouvé sur le disque
  const hasDiskAgents = userAgents.length > 0 || projectAgents.length > 0;

  if (!hasDiskAgents) {
    for (const agent of loadDefaultAgents()) {
      agentMap.set(agent.name, agent);
    }
  }

  // En mode "both", les agents projet écrasent les agents user de même nom
  if (scope === "both") {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  } else if (scope === "user") {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
  } else {
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  }

  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): {
  text: string;
  remaining: number;
} {
  if (agents.length === 0) return { text: "aucun", remaining: 0 };
  const listed = agents.slice(0, maxItems);
  const remaining = agents.length - listed.length;
  return {
    text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join(" ; "),
    remaining,
  };
}
