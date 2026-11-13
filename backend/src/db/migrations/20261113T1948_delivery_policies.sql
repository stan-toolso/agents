-- Politique de livraison d'un projet, par étiquette de tâche : « manual » (défaut : une personne fusionne) ou
-- « auto_merge » (Skipper fusionne la PR quand la CI est verte et qu'une relecture par un agent est favorable).
-- rules : [{ "tag": "auto", "mode": "auto_merge" }, …]. La fusion se fait avec le compte de merge_user_id, l'administrateur
-- du projet qui a enregistré la politique. Le déploiement n'est jamais automatique.
CREATE TABLE IF NOT EXISTS delivery_policies (
  project_id     uuid PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  rules          jsonb NOT NULL DEFAULT '[]'::jsonb,
  merge_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
