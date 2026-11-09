-- Partage d'une page avec un message d'introduction, et liens de connexion directe des invités.
-- - shared_page_members.message : mot de la personne qui a partagé (repris dans l'e-mail et affiché sur la page) ;
-- - login_links : liens de connexion sans mot de passe des invités des pages partagées (e-mail de partage, ou
--   « recevoir un lien de connexion » sur la page de connexion). Seul le hachage du jeton est stocké. Un lien sert
--   plusieurs fois jusqu'à son expiration (les antivirus des messageries ouvrent les liens avant la personne), et
--   seulement tant que le compte reste un invité.
-- Compatible bleu/vert : colonne nullable et nouvelle table, ignorées par l'ancienne version.
ALTER TABLE shared_page_members ADD COLUMN IF NOT EXISTS message text;

CREATE TABLE IF NOT EXISTS login_links (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  next_path    text NOT NULL DEFAULT '/',                             -- chemin de l'application ouvert après connexion
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,          -- personne qui a partagé (null : demandé par l'invité)
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_links_user_idx ON login_links (user_id);
