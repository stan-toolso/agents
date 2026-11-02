-- Conversations d'équipe d'un projet (canaux à la Slack) : des messages en Markdown auxquels on répond en fil (un
-- niveau, comme le fil d'une tâche), que l'on mentionne (@personne, @agent, @session:<id>) et sur lesquels on réagit.
-- Les agents du projet mentionnés sont convoqués et répondent dans le fil ; leurs sessions restent reliées au fil
-- (conversation_sessions) et reçoivent les messages suivants. Même modèle que task_comments / task_reactions, tenu
-- à part : le fil d'une tâche reste rattaché à sa tâche.

CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  slug            text NOT NULL,                               -- « general », « livraisons »… unique dans le projet
  name            text NOT NULL,
  topic           text NOT NULL DEFAULT '',
  created_by_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  last_message_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE UNIQUE INDEX conversations_project_slug_idx ON conversations (project_id, slug);
CREATE INDEX conversations_project_idx ON conversations (project_id, archived_at, last_message_at DESC);

CREATE TABLE messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  parent_id         uuid REFERENCES messages (id) ON DELETE CASCADE,   -- réponse à un message racine
  author_type       text NOT NULL CHECK (author_type IN ('human', 'agent')),
  author_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  author_session_id uuid REFERENCES sessions (id) ON DELETE SET NULL,
  author_name       text NOT NULL,                                     -- conservé si l'auteur disparaît
  body              text NOT NULL,
  mentions          jsonb NOT NULL DEFAULT '[]'::jsonb,                -- [{ kind, id, label, text }], résolues à l'écriture
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);
CREATE INDEX messages_parent_idx ON messages (parent_id);
CREATE INDEX messages_author_session_idx ON messages (author_session_id);

CREATE TABLE message_reactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  emoji       text NOT NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('human', 'agent')),
  user_id     uuid REFERENCES users (id) ON DELETE CASCADE,
  session_id  uuid REFERENCES sessions (id) ON DELETE CASCADE,
  actor_name  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR session_id IS NOT NULL)
);
CREATE UNIQUE INDEX message_reactions_unique_idx ON message_reactions (message_id, emoji, COALESCE(user_id, session_id));

-- Sessions reliées à un fil (message racine) : convoquées par une mention, mentionnées, ou qui y ont écrit. Elles
-- reçoivent les messages suivants du fil (instruction si le message leur est adressé, note discrète sinon).
CREATE TABLE conversation_sessions (
  root_message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  session_id      uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  linked_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (root_message_id, session_id)
);
CREATE INDEX conversation_sessions_session_idx ON conversation_sessions (session_id);

-- Dernière lecture d'un canal par une personne : ce qui est arrivé après compte comme non lu.
CREATE TABLE conversation_reads (
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  last_read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
