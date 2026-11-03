-- Journal d'audit des actions humaines et des agents : qui a fait quoi dans un projet (lancement et arrêt de session,
-- réponse à une demande, tâches, contexte, membres, connexions, git…). Une ligne par action, écrite par les services et
-- par l'enveloppe des mutations GraphQL (backend/src/audit). project_id NULL : action de l'application (utilisateurs,
-- réglages du serveur). L'acteur est une personne (actor_user_id), une session d'agent (session_id, avec la personne
-- ou l'agent qui la porte dans actor_user_id), ou Skipper lui-même (les deux NULL) ; actor_label garde le nom affiché
-- au moment de l'action (clé d'API, session supprimée depuis).
CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  project_id     uuid REFERENCES projects (id) ON DELETE CASCADE,
  actor_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  session_id     uuid REFERENCES sessions (id) ON DELETE SET NULL,
  actor_label    text,
  action         text NOT NULL,
  target_type    text NOT NULL,
  target_id      text,
  target_label   text,
  details        jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_project_idx ON audit_log (project_id, id DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (project_id, actor_user_id, id DESC);
CREATE INDEX audit_log_session_idx ON audit_log (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX audit_log_created_idx ON audit_log (created_at);
