/**
 * Rendu TUI pour l'orchestrateur de sous-agents
 *
 * Affiche les appels et résultats des sous-agents avec :
 *  - Icônes d'état (✓, ✗, ⏳)
 *  - Formatage des appels d'outils (bash, read, write, etc.)
 *  - Vue compacte (par défaut) et vue étendue (Ctrl+O)
 *  - Statistiques d'utilisation (tokens, coût, tours)
 *  - Rendu Markdown pour la sortie finale
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type {
  DisplayItem,
  ExecutionDetails,
  RunnerMode,
  SingleResult,
  UsageStats,
} from "./types.ts";
import {
  formatToolCall,
  formatUsageStats,
  getDisplayItems,
  getFinalOutput,
  getResultOutput,
  isFailedResult,
} from "./orchestrator.ts";

// ────────────────────────────────────────
// Constantes d'affichage
// ────────────────────────────────────────

const COLLAPSED_ITEM_COUNT = 10;
const COLLAPSED_CHAIN_ITEMS = 5;

// ────────────────────────────────────────
// Rendu des items (texte + appels d'outils)
// ────────────────────────────────────────

function renderDisplayItems(
  items: DisplayItem[],
  theme: any,
  limit?: number,
  expanded?: boolean,
): string {
  const toShow = limit ? items.slice(-limit) : items;
  const skipped = limit && items.length > limit ? items.length - limit : 0;
  let text = "";
  if (skipped > 0) text += theme.fg("muted", `... ${skipped} éléments précédents\n`);
  for (const item of toShow) {
    if (item.type === "text") {
      const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
      text += `${theme.fg("toolOutput", preview)}\n`;
    } else {
      text += `${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
    }
  }
  return text.trimEnd();
}

// ────────────────────────────────────────
// Agrégation des statistiques
// ────────────────────────────────────────

function aggregateUsage(results: SingleResult[]): UsageStats {
  const total: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 };
  for (const r of results) {
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.cost += r.usage.cost;
    total.turns += r.usage.turns;
  }
  return total;
}

// ────────────────────────────────────────
// Rendu principal
// ────────────────────────────────────────

export function renderResult(
  resultContent: any,
  expanded: boolean,
  theme: any,
): Container | Text {
  const details = resultContent.details as ExecutionDetails | undefined;

  if (!details || details.results.length === 0) {
    const text = resultContent.content?.[0];
    return new Text(text?.type === "text" ? text.text : "(pas de sortie)", 0, 0);
  }

  return renderModeResult(details, expanded, theme);
}

function renderModeResult(
  details: ExecutionDetails,
  expanded: boolean,
  theme: any,
): Container | Text {
  switch (details.mode) {
    case "single":
      return renderSingleResult(details, expanded, theme);
    case "parallel":
      return renderParallelResult(details, expanded, theme);
    case "chain":
      return renderChainResult(details, expanded, theme);
    default:
      return new Text("Mode inconnu", 0, 0);
  }
}

// ────────────────────────────────────────
// Mode Single
// ────────────────────────────────────────

function renderSingleResult(
  details: ExecutionDetails,
  expanded: boolean,
  theme: any,
): Container | Text {
  const r = details.results[0];
  const isError = isFailedResult(r);
  const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const displayItems = getDisplayItems(r.messages);
  const finalOutput = getFinalOutput(r.messages);

  if (expanded) {
    const container = new Container();
    let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
    if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
    container.addChild(new Text(header, 0, 0));

    if (isError && r.errorMessage) {
      container.addChild(new Text(theme.fg("error", `Erreur : ${r.errorMessage}`), 0, 0));
    }

    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Tâche ───"), 0, 0));
    container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Sortie ───"), 0, 0));

    if (displayItems.length === 0 && !finalOutput) {
      container.addChild(new Text(theme.fg("muted", "(pas de sortie)"), 0, 0));
    } else {
      for (const item of displayItems) {
        if (item.type === "toolCall") {
          container.addChild(
            new Text(
              theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
              0,
              0,
            ),
          );
        }
      }
      if (finalOutput) {
        container.addChild(new Spacer(1));
        const mdTheme = getMarkdownTheme();
        container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
      }
    }

    const usageStr = formatUsageStats(r.usage, r.model);
    if (usageStr) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
    }
    if (r.durationMs) {
      container.addChild(new Text(theme.fg("dim", `${(r.durationMs / 1000).toFixed(1)}s`), 0, 0));
    }
    return container;
  }

  // Vue compacte
  let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
  if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
  if (isError && r.errorMessage) text += `\n${theme.fg("error", `Erreur : ${r.errorMessage}`)}`;
  else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(pas de sortie)")}`;
  else {
    text += `\n${renderDisplayItems(displayItems, theme, COLLAPSED_ITEM_COUNT, false)}`;
    if (displayItems.length > COLLAPSED_ITEM_COUNT) {
      text += `\n${theme.fg("muted", "(Ctrl+O pour déplier)")}`;
    }
  }
  const usageStr = formatUsageStats(r.usage, r.model);
  if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
  if (r.durationMs) text += ` ${theme.fg("dim", `${(r.durationMs / 1000).toFixed(1)}s`)}`;
  return new Text(text, 0, 0);
}

// ────────────────────────────────────────
// Mode Parallèle
// ────────────────────────────────────────

function renderParallelResult(
  details: ExecutionDetails,
  expanded: boolean,
  theme: any,
): Container | Text {
  const running = details.results.filter((r) => r.exitCode === -1).length;
  const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
  const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
  const isRunning = running > 0;
  const icon = isRunning
    ? theme.fg("warning", "⏳")
    : failCount > 0
      ? theme.fg("warning", "◐")
      : theme.fg("success", "✓");
  const status = isRunning
    ? `${successCount + failCount}/${details.results.length} terminé(s), ${running} en cours`
    : `${successCount}/${details.results.length} tâches`;

  if (expanded && !isRunning) {
    const container = new Container();
    container.addChild(
      new Text(
        `${icon} ${theme.fg("toolTitle", theme.bold("parallèle "))}${theme.fg("accent", status)}`,
        0,
        0,
      ),
    );

    for (const r of details.results) {
      const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const displayItems = getDisplayItems(r.messages);
      const finalOutput = getFinalOutput(r.messages);

      container.addChild(new Spacer(1));
      container.addChild(
        new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
      );
      container.addChild(new Text(theme.fg("muted", "Tâche : ") + theme.fg("dim", r.task), 0, 0));

      for (const item of displayItems) {
        if (item.type === "toolCall") {
          container.addChild(
            new Text(
              theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
              0,
              0,
            ),
          );
        }
      }

      if (finalOutput) {
        container.addChild(new Spacer(1));
        const mdTheme = getMarkdownTheme();
        container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
      }

      const taskUsage = formatUsageStats(r.usage, r.model);
      if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
    }

    const usageStr = formatUsageStats(aggregateUsage(details.results));
    if (usageStr) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", `Total : ${usageStr}`), 0, 0));
    }
    return container;
  }

  // Vue compacte
  let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallèle "))}${theme.fg("accent", status)}`;
  for (const r of details.results) {
    const rIcon =
      r.exitCode === -1
        ? theme.fg("warning", "⏳")
        : isFailedResult(r)
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
    const displayItems = getDisplayItems(r.messages);
    text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
    if (displayItems.length === 0)
      text += `\n${theme.fg("muted", r.exitCode === -1 ? "(en cours...)" : "(pas de sortie)")}`;
    else text += `\n${renderDisplayItems(displayItems, theme, COLLAPSED_CHAIN_ITEMS, false)}`;
  }
  if (!isRunning) {
    const usageStr = formatUsageStats(aggregateUsage(details.results));
    if (usageStr) text += `\n\n${theme.fg("dim", `Total : ${usageStr}`)}`;
  }
  if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O pour déplier)")}`;
  return new Text(text, 0, 0);
}

// ────────────────────────────────────────
// Mode Chaîne
// ────────────────────────────────────────

function renderChainResult(
  details: ExecutionDetails,
  expanded: boolean,
  theme: any,
): Container | Text {
  const successCount = details.results.filter((r) => r.exitCode === 0).length;
  const icon =
    successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

  if (expanded) {
    const container = new Container();
    container.addChild(
      new Text(
        icon +
          " " +
          theme.fg("toolTitle", theme.bold("chaîne ")) +
          theme.fg("accent", `${successCount}/${details.results.length} étapes`),
        0,
        0,
      ),
    );

    for (const r of details.results) {
      const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const displayItems = getDisplayItems(r.messages);
      const finalOutput = getFinalOutput(r.messages);

      container.addChild(new Spacer(1));
      container.addChild(
        new Text(
          `${theme.fg("muted", `─── Étape ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`,
          0,
          0,
        ),
      );
      container.addChild(new Text(theme.fg("muted", "Tâche : ") + theme.fg("dim", r.task), 0, 0));

      for (const item of displayItems) {
        if (item.type === "toolCall") {
          container.addChild(
            new Text(
              theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
              0,
              0,
            ),
          );
        }
      }

      if (finalOutput) {
        container.addChild(new Spacer(1));
        const mdTheme = getMarkdownTheme();
        container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
      }

      const stepUsage = formatUsageStats(r.usage, r.model);
      if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
    }

    const usageStr = formatUsageStats(aggregateUsage(details.results));
    if (usageStr) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", `Total : ${usageStr}`), 0, 0));
    }
    return container;
  }

  // Vue compacte
  let text =
    icon +
    " " +
    theme.fg("toolTitle", theme.bold("chaîne ")) +
    theme.fg("accent", `${successCount}/${details.results.length} étapes`);
  for (const r of details.results) {
    const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const displayItems = getDisplayItems(r.messages);
    text += `\n\n${theme.fg("muted", `─── Étape ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
    if (displayItems.length === 0) text += `\n${theme.fg("muted", "(pas de sortie)")}`;
    else text += `\n${renderDisplayItems(displayItems, theme, COLLAPSED_CHAIN_ITEMS, false)}`;
  }
  const usageStr = formatUsageStats(aggregateUsage(details.results));
  if (usageStr) text += `\n\n${theme.fg("dim", `Total : ${usageStr}`)}`;
  text += `\n${theme.fg("muted", "(Ctrl+O pour déplier)")}`;
  return new Text(text, 0, 0);
}

// ────────────────────────────────────────
// Rendu de l'appel (renderCall)
// ────────────────────────────────────────

export function renderCall(args: any, theme: any): Text {
  const scope = args.agentScope ?? "user";

  if (args.chain && args.chain.length > 0) {
    let text =
      theme.fg("toolTitle", theme.bold("orchestrator ")) +
      theme.fg("accent", `chaîne (${args.chain.length} étapes)`) +
      theme.fg("muted", ` [${scope}]`);
    for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
      const step = args.chain[i];
      const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
      const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
      text +=
        "\n  " +
        theme.fg("muted", `${i + 1}.`) +
        " " +
        theme.fg("accent", step.agent) +
        theme.fg("dim", ` ${preview}`);
    }
    if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} de plus`)}`;
    return new Text(text, 0, 0);
  }

  if (args.tasks && args.tasks.length > 0) {
    let text =
      theme.fg("toolTitle", theme.bold("orchestrator ")) +
      theme.fg("accent", `parallèle (${args.tasks.length} tâches)`) +
      theme.fg("muted", ` [${scope}]`);
    for (const t of args.tasks.slice(0, 3)) {
      const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
      text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
    }
    if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} de plus`)}`;
    return new Text(text, 0, 0);
  }

  const agentName = args.agent || "...";
  const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
  let text =
    theme.fg("toolTitle", theme.bold("orchestrator ")) +
    theme.fg("accent", agentName) +
    theme.fg("muted", ` [${scope}]`);
  text += `\n  ${theme.fg("dim", preview)}`;
  return new Text(text, 0, 0);
}
