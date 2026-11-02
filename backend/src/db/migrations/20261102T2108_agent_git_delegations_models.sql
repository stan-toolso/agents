-- ---- Agents de projet : comptes GitHub et GitLab prêtés séparément, modèles autorisés --------------------------
-- Le prêt des comptes git (git_delegate_id, un seul bloc GitHub + GitLab + forge) se scinde : une personne peut prêter
-- son compte GitHub, son compte GitLab, ou les deux, chacun en lecture seule ou non. Les prêts existants sont repris
-- pour les deux. Les anciennes colonnes restent le temps de la bascule bleu/vert (l'instance précédente les lit encore).
ALTER TABLE agent_profiles ADD COLUMN github_delegate_id uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE agent_profiles ADD COLUMN github_delegate_read_only boolean NOT NULL DEFAULT true;
ALTER TABLE agent_profiles ADD COLUMN gitlab_delegate_id uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE agent_profiles ADD COLUMN gitlab_delegate_read_only boolean NOT NULL DEFAULT true;
UPDATE agent_profiles
   SET github_delegate_id = git_delegate_id, github_delegate_read_only = git_delegate_read_only,
       gitlab_delegate_id = git_delegate_id, gitlab_delegate_read_only = git_delegate_read_only
 WHERE git_delegate_id IS NOT NULL;

-- Modèles que les sessions de l'agent peuvent utiliser (vide : tous). Le type de session (provider) et le modèle par
-- défaut restent dans `defaults` (clés provider et model).
ALTER TABLE agent_profiles ADD COLUMN allowed_models text[] NOT NULL DEFAULT '{}';
