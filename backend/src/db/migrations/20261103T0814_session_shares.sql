-- ---- Partage d'une session en lecture seule par lien public ----------------------------------------------------------
-- Un membre du projet crée un lien /share/<token> qui montre le transcript de la session sans connexion, jusqu'à
-- expires_at. Révoquer un lien supprime sa ligne : le lien renvoie alors 404, comme un lien expiré.
CREATE TABLE session_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_shares_session_idx ON session_shares (session_id);
