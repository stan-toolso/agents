-- Le fil d'une tâche passe sur les tables des canaux (un seul moteur de bout en bout) : chaque tâche qui a un fil a
-- une conversation de genre « task » (conversations.task_id), ses messages sont des `messages`, ses réactions des
-- `message_reactions` et les fichiers de ses messages des `message_attachments`. Les identifiants sont conservés
-- (liens #comment-<id>, reply_to des agents). Les fichiers restent sur le disque sous la tâche
-- (WORKSPACES_ROOT/.task-attachments/<tâche>/<id>/<nom>) : une conversation de tâche range ses fichiers là.
--
-- Bleu/vert (expand/contract) : task_comments, task_reactions et les fichiers de messages de task_attachments
-- restent en place, en lecture seule pour la nouvelle version ; l'ancienne instance, qui se vide pendant que la
-- nouvelle démarre, peut encore y écrire : des triggers recopient ces écritures dans les nouvelles tables. Une
-- migration ultérieure retirera triggers et anciennes tables.

ALTER TABLE conversations ADD COLUMN kind text NOT NULL DEFAULT 'channel' CHECK (kind IN ('channel', 'task'));
ALTER TABLE conversations ADD COLUMN task_id uuid UNIQUE REFERENCES tasks (id) ON DELETE CASCADE;
ALTER TABLE conversations ADD CONSTRAINT conversations_task_kind_chk CHECK ((kind = 'task') = (task_id IS NOT NULL));

-- Une réaction porte sa conversation ; elle vise un message, ou le message d'ouverture de la conversation (la
-- description d'une tâche) quand message_id est null.
ALTER TABLE message_reactions ALTER COLUMN message_id DROP NOT NULL;
ALTER TABLE message_reactions ADD COLUMN conversation_id uuid REFERENCES conversations (id) ON DELETE CASCADE;
UPDATE message_reactions r SET conversation_id = m.conversation_id FROM messages m WHERE m.id = r.message_id;
ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_target_chk CHECK (message_id IS NOT NULL OR conversation_id IS NOT NULL);
CREATE INDEX message_reactions_conversation_idx ON message_reactions (conversation_id);
CREATE UNIQUE INDEX message_reactions_opening_unique_idx ON message_reactions (conversation_id, emoji, COALESCE(user_id, session_id)) WHERE message_id IS NULL;

-- La conversation d'une tâche, créée à la première demande (slug « task-<id> », nom = titre au moment de la création).
CREATE FUNCTION task_conversation_id(p_task uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  cid uuid;
BEGIN
  SELECT id INTO cid FROM conversations WHERE task_id = p_task;
  IF cid IS NULL THEN
    INSERT INTO conversations (project_id, kind, task_id, slug, name)
    SELECT t.project_id, 'task', t.id, 'task-' || t.id, left(t.title, 60) FROM tasks t WHERE t.id = p_task
    ON CONFLICT (task_id) DO UPDATE SET updated_at = conversations.updated_at
    RETURNING id INTO cid;
  END IF;
  RETURN cid;
END $$;

-- Reprise des fils existants.
SELECT task_conversation_id(t.id) FROM tasks t
WHERE EXISTS (SELECT 1 FROM task_comments c WHERE c.task_id = t.id) OR EXISTS (SELECT 1 FROM task_reactions r WHERE r.task_id = t.id);

INSERT INTO messages (id, conversation_id, parent_id, author_type, author_user_id, author_session_id, author_name, body, mentions, created_at, updated_at)
SELECT tc.id, c.id, tc.parent_id, tc.author_type, tc.author_user_id, tc.author_session_id, tc.author_name, tc.body, tc.mentions, tc.created_at, tc.updated_at
FROM task_comments tc JOIN conversations c ON c.task_id = tc.task_id
ON CONFLICT (id) DO NOTHING;

UPDATE conversations c SET last_message_at = (SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id) WHERE c.kind = 'task';

INSERT INTO message_reactions (id, message_id, conversation_id, emoji, actor_type, user_id, session_id, actor_name, created_at)
SELECT r.id, r.comment_id, c.id, r.emoji, r.actor_type, r.user_id, r.session_id, r.actor_name, r.created_at
FROM task_reactions r JOIN conversations c ON c.task_id = r.task_id
ON CONFLICT DO NOTHING;

INSERT INTO message_attachments (id, conversation_id, message_id, name, media_type, size, created_at)
SELECT a.id, c.id, a.comment_id, a.name, a.media_type, a.size, a.created_at
FROM task_attachments a JOIN conversations c ON c.task_id = a.task_id
WHERE a.comment_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Recopie des écritures de l'ancienne version (pendant son drainage).
CREATE FUNCTION task_comments_mirror() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO messages (id, conversation_id, parent_id, author_type, author_user_id, author_session_id, author_name, body, mentions, created_at, updated_at)
    VALUES (NEW.id, task_conversation_id(NEW.task_id), NEW.parent_id, NEW.author_type, NEW.author_user_id, NEW.author_session_id, NEW.author_name, NEW.body, NEW.mentions, NEW.created_at, NEW.updated_at)
    ON CONFLICT (id) DO NOTHING;
    UPDATE conversations SET last_message_at = NEW.created_at WHERE task_id = NEW.task_id;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE messages SET body = NEW.body, mentions = NEW.mentions, updated_at = NEW.updated_at WHERE id = NEW.id;
  ELSE
    DELETE FROM messages WHERE id = OLD.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER task_comments_mirror AFTER INSERT OR UPDATE OR DELETE ON task_comments FOR EACH ROW EXECUTE FUNCTION task_comments_mirror();

CREATE FUNCTION task_reactions_mirror() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cid uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    cid := task_conversation_id(NEW.task_id);
    INSERT INTO message_reactions (id, message_id, conversation_id, emoji, actor_type, user_id, session_id, actor_name, created_at)
    VALUES (NEW.id, NEW.comment_id, cid, NEW.emoji, NEW.actor_type, NEW.user_id, NEW.session_id, NEW.actor_name, NEW.created_at)
    ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM message_reactions WHERE id = OLD.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER task_reactions_mirror AFTER INSERT OR DELETE ON task_reactions FOR EACH ROW EXECUTE FUNCTION task_reactions_mirror();

CREATE FUNCTION task_comment_attachments_mirror() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.comment_id IS NOT NULL THEN
      INSERT INTO message_attachments (id, conversation_id, message_id, name, media_type, size, created_at)
      VALUES (NEW.id, task_conversation_id(NEW.task_id), NEW.comment_id, NEW.name, NEW.media_type, NEW.size, NEW.created_at)
      ON CONFLICT (id) DO NOTHING;
    END IF;
  ELSE
    DELETE FROM message_attachments WHERE id = OLD.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER task_comment_attachments_mirror AFTER INSERT OR DELETE ON task_attachments FOR EACH ROW EXECUTE FUNCTION task_comment_attachments_mirror();

-- Fils de tâches suivis (onglet Conversations) : messages d'une personne, mentions.
CREATE INDEX messages_author_user_idx ON messages (author_user_id);
