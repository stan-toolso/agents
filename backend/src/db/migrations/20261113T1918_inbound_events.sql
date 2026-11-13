-- Point d'entrée entrant (POST /api/v1/inbound) : portées des clés d'API, secret de signature HMAC facultatif,
-- et journal des événements reçus (idempotence, limitation de débit partagée entre instances, suivi).
-- Les clés existantes gardent l'accès complet à l'API des tâches (lecture et écriture) et rien de plus.
ALTER TABLE project_api_keys
  ADD COLUMN scopes text[] NOT NULL DEFAULT ARRAY['tasks:read', 'tasks:write']::text[],
  ADD COLUMN signing_secret text,          -- chiffré (settings/crypto) ; présent : signature HMAC exigée sur /inbound
  ADD COLUMN triage_agent_id uuid REFERENCES users (id) ON DELETE SET NULL;  -- agent convoqué par défaut pour un triage

CREATE TABLE inbound_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  api_key_id      uuid REFERENCES project_api_keys (id) ON DELETE SET NULL,
  key_name        text NOT NULL,                -- instantané du nom de la clé
  idempotency_key text,                         -- en-tête Idempotency-Key ou champ externalId
  request_hash    text NOT NULL,                -- sha256 du corps, pour refuser une clé réutilisée avec un autre contenu
  source          text,
  task_id         uuid REFERENCES tasks (id) ON DELETE SET NULL,
  session_id      uuid REFERENCES sessions (id) ON DELETE SET NULL,
  agent_id        uuid REFERENCES users (id) ON DELETE SET NULL,
  triage          boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'processing',  -- processing, done, failed
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX inbound_events_idempotency_idx ON inbound_events (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX inbound_events_key_created_idx ON inbound_events (api_key_id, created_at);
CREATE INDEX inbound_events_project_created_idx ON inbound_events (project_id, created_at DESC);
