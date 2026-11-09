-- Renvoi des commentaires d'une page partagée à la session qui l'a publiée, réglé par le propriétaire :
-- 'off' (désactivé), 'manual' (bouton « Transmettre à l'agent », comportement d'avant) ou 'auto' (chaque nouveau
-- commentaire ou réponse d'une personne est transmis aussitôt à la session).
ALTER TABLE shared_pages ADD COLUMN IF NOT EXISTS agent_handoff text NOT NULL DEFAULT 'manual'
  CHECK (agent_handoff IN ('off', 'manual', 'auto'));
