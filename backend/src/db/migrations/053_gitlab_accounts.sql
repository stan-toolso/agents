-- ---- Comptes GitLab d'un utilisateur (plusieurs possibles, gitlab.com ou instance auto-hébergée) ; le jeton vit dans l'élément du coffre.
CREATE TABLE user_gitlab_accounts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Instance GitLab (nom d'hôte en minuscules, éventuellement avec port) : gitlab.com, gitlab.exemple.fr…
  host                      text NOT NULL,
  login                     text NOT NULL,
  name                      text,
  -- Adresse des commits (commit_email, sinon e-mail public, sinon adresse noreply de l'instance).
  email                     text,
  avatar_url                text,
  method                    text NOT NULL CHECK (method IN ('oauth', 'pat')),
  vault_item_id             uuid NOT NULL REFERENCES vault_items (id) ON DELETE CASCADE,
  token_expires_at          timestamptz,
  refresh_token_expires_at  timestamptz,
  scopes                    text[] NOT NULL DEFAULT '{}',
  -- Groupes de premier niveau du compte (lus à la connexion), pour choisir le compte d'après l'espace du dépôt.
  groups                    text[] NOT NULL DEFAULT '{}',
  is_default                boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_gitlab_accounts_login_idx ON user_gitlab_accounts (user_id, host, lower(login));
CREATE UNIQUE INDEX user_gitlab_accounts_default_idx ON user_gitlab_accounts (user_id) WHERE is_default;
