-- ---- Agents de projet (Product Manager, Developer…) ----------------------------------------------------------
-- Un agent est un utilisateur d'un genre particulier (users.kind = 'agent') : il est membre de son projet comme une
-- personne, a ses propres comptes (réglages Claude, GitHub, GitLab, coffre personnel, consommation) indexés par son
-- identifiant, et tout ce qu'il fait est une session dont il est le propriétaire (sessions.owner_id). Il ne se
-- connecte jamais (pas de compte Google, e-mail technique), ne reçoit pas de notification, et n'apparaît pas dans
-- les listes où l'on choisit une personne. Son profil (rôle, instructions, déclencheurs, actions) est dans
-- agent_profiles ; ses gestionnaires (propriétaire et gestionnaires) dans agent_managers.
-- Rien à voir avec les tables `agents` / `agent_runs` retirées par la migration 039 (appels directs de modèle).

ALTER TABLE users ADD COLUMN kind text NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'agent'));
CREATE INDEX users_kind_agent_idx ON users (kind) WHERE kind = 'agent';

CREATE TABLE agent_profiles (
  user_id        uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  project_id     uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- Modèle de départ : product_manager, developer ou custom (préremplit instructions, déclencheurs et actions).
  kind           text NOT NULL DEFAULT 'custom' CHECK (kind IN ('product_manager', 'developer', 'custom')),
  -- { emoji, color } : avatar affiché partout où l'agent apparaît.
  avatar         jsonb NOT NULL DEFAULT '{}'::jsonb,
  description    text NOT NULL DEFAULT '',
  -- Markdown ajouté au prompt système de ses sessions (après le prompt du projet).
  instructions   text NOT NULL DEFAULT '',
  -- true : ses sessions sur une tâche travaillent dans le dossier de la tâche (branche task/…) ; false : un dossier à part par session.
  task_folder    boolean NOT NULL DEFAULT true,
  -- Réglages par défaut de ses sessions (même forme que sessions.config : permissionMode, allowedTools…).
  defaults       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Dossier de la bibliothèque de contexte réservé à l'agent (sa mémoire durable).
  context_folder text,
  -- Interrupteurs : { taskCreated, taskCreatedTag, threadFollowed, prMerged, taskReady, taskReadyTag }.
  triggers       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Actions nommées : [{ key, label, instruction, cron, timezone, scheduleSessionId }].
  actions        jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled        boolean NOT NULL DEFAULT true,
  archived_at    timestamptz,
  created_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_profiles_project_idx ON agent_profiles (project_id) WHERE archived_at IS NULL;

CREATE TABLE agent_managers (
  agent_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'manager')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_user_id, user_id)
);
CREATE INDEX agent_managers_user_idx ON agent_managers (user_id);

-- Personne qui a demandé la session (le client qui parle à l'agent, la personne qui lui confie la tâche) ; le
-- propriétaire (owner_id) reste celui dont les comptes et le budget servent. Null : le propriétaire lui-même.
ALTER TABLE sessions ADD COLUMN requested_by_id uuid REFERENCES users (id) ON DELETE SET NULL;
