-- Autres modes de connexion que Google : e-mail + mot de passe, Microsoft, GitHub.
-- - users.password_hash : mot de passe (scrypt, format « scrypt$N$r$p$sel$empreinte »), null = pas de mot de passe ;
-- - user_identities : comptes externes reliés à une personne (Microsoft, GitHub), un compte n'est relié qu'une fois ;
--   Google garde users.google_sub ;
-- - password_tokens : liens à usage unique pour choisir ou réinitialiser son mot de passe (hachage du jeton seulement).
-- Compatible bleu/vert : colonne nullable et nouvelles tables, ignorées par l'ancienne version.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set_at timestamptz;

CREATE TABLE IF NOT EXISTS user_identities (
  provider     text NOT NULL,                                        -- 'microsoft' | 'github'
  subject      text NOT NULL,                                        -- identifiant stable chez le fournisseur
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email        text,                                                 -- adresse vue à la liaison (affichage)
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS user_identities_user_idx ON user_identities (user_id);

CREATE TABLE IF NOT EXISTS password_tokens (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,          -- administrateur qui a créé le lien (null : « mot de passe oublié »)
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_tokens_user_idx ON password_tokens (user_id);
