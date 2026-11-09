-- Extension « Skipper pour Chrome » : navigateurs reliés par une personne. Chaque navigateur a un jeton propre
-- (`skc_…`, seul le hachage est conservé) avec lequel l'extension ouvre son WebSocket. Tant qu'il est connecté,
-- `instance_id` désigne l'instance du backend qui tient la connexion (routage des commandes en bleu/vert).
CREATE TABLE IF NOT EXISTS chrome_browsers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  instance_id uuid,
  connected_at timestamptz,
  user_agent text,
  extension_version text
);
CREATE INDEX IF NOT EXISTS chrome_browsers_user_idx ON chrome_browsers (user_id, created_at);
