-- ---- Bibliothèque de contexte propre à chaque agent, héritage du projet, délégation de comptes -----------------
-- Chaque agent de projet a sa propre bibliothèque de contexte (dossiers et instructions portant agent_id), distincte
-- de celle du projet (agent_id null) ; il peut en plus hériter de celle du projet (inherit_context). Toutes les
-- sessions du projet y accèdent par le paramètre `library` des outils MCP `context`.
ALTER TABLE context_folders ADD COLUMN agent_id uuid REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE context_instructions ADD COLUMN agent_id uuid REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE context_changes ADD COLUMN agent_id uuid REFERENCES users (id) ON DELETE CASCADE;

DROP INDEX IF EXISTS context_folders_unique_slug;
CREATE UNIQUE INDEX context_folders_unique_slug
  ON context_folders (project_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
DROP INDEX IF EXISTS context_instructions_unique_slug;
CREATE UNIQUE INDEX context_instructions_unique_slug
  ON context_instructions (project_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
CREATE INDEX context_folders_agent_idx ON context_folders (agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX context_instructions_agent_idx ON context_instructions (agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX context_changes_agent_idx ON context_changes (agent_id, id DESC) WHERE agent_id IS NOT NULL;

-- Le dossier `agents/<slug>` de la bibliothèque du projet est remplacé par la bibliothèque propre de l'agent.
ALTER TABLE agent_profiles DROP COLUMN IF EXISTS context_folder;
ALTER TABLE agent_profiles ADD COLUMN inherit_context boolean NOT NULL DEFAULT true;

-- Délégation de comptes : la personne qui règle l'agent peut lui prêter son propre compte Claude et/ou ses comptes git
-- (GitHub, GitLab, forge) ; les comptes git peuvent être prêtés en lecture seule (ni push ni pull request).
ALTER TABLE agent_profiles ADD COLUMN claude_delegate_id uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE agent_profiles ADD COLUMN git_delegate_id uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE agent_profiles ADD COLUMN git_delegate_read_only boolean NOT NULL DEFAULT true;
