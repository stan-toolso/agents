-- Fichiers joints aux messages des canaux (images collées, documents), comme ceux du fil des tâches : les
-- métadonnées ici, le contenu sur le disque du serveur (WORKSPACES_ROOT/.message-attachments/<canal>/<id>/<nom>).
-- Table à part de task_attachments (les canaux ont leurs propres tables, voir 20261102T2127_conversations).
CREATE TABLE message_attachments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  message_id       uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  name             text NOT NULL,
  media_type       text NOT NULL,
  size             integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_attachments_message_idx ON message_attachments (message_id, created_at);
