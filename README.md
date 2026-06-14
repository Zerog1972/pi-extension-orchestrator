# Orchestrateur de Sous-Agents

Extension pi pour déléguer des tâches à des sous-agents spécialisés, gérés par un orchestrateur centralisé.

## Installation

```bash
# Installation globale (disponible dans tous les projets)
pi install npm:pi-extension-orchestrator

# Test rapide sans installation permanente
pi -e npm:pi-extension-orchestrator

# Installation dans un projet (via .pi/settings.json)
pi install -l npm:pi-extension-orchestrator
```

## Déploiement sur d'autres environnements

### Via npm (recommandé)

```bash
# 1. Publier le package
cd .pi/extensions/orchestrator
npm publish

# 2. Installer sur la machine cible
pi install npm:pi-extension-orchestrator
```

### Via Git

```bash
# 1. Pousser sur un dépôt Git
cd .pi/extensions/orchestrator
git init && git add -A && git commit -m "v1.0.0"
git tag v1.0.0
git push origin main --tags

# 2. Installer sur la machine cible
pi install git:github.com/user/pi-extension-orchestrator@v1.0.0
```

### Par copie directe

```bash
# Copier l'extension
scp -r .pi/extensions/orchestrator/* cible:~/.pi/agent/extensions/orchestrator/

# Copier les agents
scp -r .pi/agents/*.md cible:~/.pi/agent/agents/
```

## Architecture

```
orchestrator/
├── README.md              # Ce fichier
├── index.ts               # Point d'entrée (outil + commandes)
├── orchestrator.ts        # Moteur d'orchestration (file d'attente, concurrence, exécution)
├── agents.ts              # Découverte et chargement des définitions d'agents
├── renderer.ts            # Rendu TUI (appels et résultats)
└── types.ts               # Types partagés
```

## Orchestrateur

La classe `Orchestrator` fournit :

| Fonctionnalité | Description |
|----------------|-------------|
| **File d'attente** | Tâches avec priorités (0 = haute) |
| **Dépendances** | Une tâche peut dépendre d'autres tâches (`{taskId}` dans le texte) |
| **Concurrence** | Contrôle du nombre max de sous-agents simultanés (défaut : 4) |
| **Annulation** | Support de `AbortSignal` pour propager Ctrl+C |
| **Streaming** | Mise à jour en temps réel de la progression |

## Modes d'exécution

```
┌──────────────────────────────────────────────────────────┐
│                     ORCHESTRATEUR                         │
│                                                          │
│  ┌─────────┐    ┌──────────────────┐    ┌─────────────┐ │
│  │ SINGLE  │    │    PARALLEL      │    │    CHAIN    │ │
│  │         │    │                  │    │             │ │
│  │ Agent A │    │ Agent A  Agent B │    │ Agent A     │ │
│  │    ↓    │    │    ↓       ↓     │    │    ↓        │ │
│  │ Résultat│    │ Résultat Résultat│    │ {previous}  │ │
│  └─────────┘    └──────────────────┘    │    ↓        │ │
│                                         │ Agent B     │ │
│                                         │    ↓        │ │
│                                         │ Résultat    │ │
│                                         └─────────────┘ │
└──────────────────────────────────────────────────────────┘
```

## Outil `orchestrator`

Le LLM appelle cet outil avec l'un des trois modes :

### Mode Single

```json
{
  "agent": "scout",
  "task": "Trouve tous les fichiers liés à l'authentification"
}
```

### Mode Parallel (jusqu'à 8 tâches, 4 simultanées)

```json
{
  "tasks": [
    { "agent": "scout", "task": "Explore les modèles de données" },
    { "agent": "scout", "task": "Explore les contrôleurs API" }
  ]
}
```

### Mode Chain (séquentiel avec {previous})

```json
{
  "chain": [
    { "agent": "scout",  "task": "Explore le module auth" },
    { "agent": "planner", "task": "Planifie l'ajout d'OAuth basé sur : {previous}" },
    { "agent": "worker",  "task": "Implémente selon le plan : {previous}" }
  ]
}
```

## Agents disponibles

L'extension embarque **5 agents par défaut** prêts à l'emploi :

| Agent | Rôle | Outils | Modèle |
|-------|------|--------|--------|
| `scout` | Exploration rapide | read, grep, find, ls, bash | Deepseek Flash |
| `planner` | Planification | read, grep, find, ls | Deepseek V4 Pro |
| `worker` | Implémentation | tous | Deepseek V4 Pro |
| `reviewer` | Revue de code | read, grep, find, ls, bash | Deepseek V4 Pro |
| `architect` | Conception architecture | read, grep, find, ls | Deepseek V4 Pro |

### Comportement

1. **Si aucun agent sur le disque** → les agents embarqués sont utilisés automatiquement
2. **Si des agents existent dans** `~/.pi/agent/agents/` ou `.pi/agents/` → ils prennent le dessus
3. **Pour personnaliser** → lance `/agents init` qui copie les 5 agents par défaut dans `~/.pi/agent/agents/`, puis édite-les

## Créer un agent

Les agents sont définis dans des fichiers `.md` avec frontmatter YAML.

> **À noter :** les agents ne sont pas inclus dans le package npm — ils sont propres à chaque environnement. Seule l'extension (le moteur d'orchestration) est empaquetée.

Fichier `.md` avec frontmatter YAML :

```markdown
---
name: mon-agent
description: Ce que fait mon agent
tools: read, grep, find, ls
model: deepseek-flash
---

Tu es un agent spécialisé dans...
```

Emplacements :
- `~/.pi/agent/agents/*.md` — agents utilisateur (toujours chargés)
- `.pi/agents/*.md` — agents du projet (avec `agentScope: "both"` ou `"project"`)

## Commandes

| Commande | Description |
|----------|-------------|
| `/agents` | Lister les agents disponibles et inspecter leur configuration |
| `/agents init` | Créer les 5 agents par défaut dans `~/.pi/agent/agents/` pour les personnaliser |

## Sécurité

- Par défaut, seuls les agents utilisateur (`~/.pi/agent/agents/`) sont chargés
- Pour les agents projet (`.pi/agents/`), une confirmation interactive est demandée
- Désactiver avec `confirmProjectAgents: false`

## Limitations

- Maximum 8 tâches parallèles, 4 simultanées
- Sortie par tâche limitée à 50 KB pour le LLM parent (données complètes dans `details`)
- Les agents sont redécouverts à chaque invocation (modifications prises en compte sans rechargement)
