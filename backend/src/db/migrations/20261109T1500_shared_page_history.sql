-- Historique des versions d'une page partagée, désactivable par le propriétaire ou un administrateur de Skipper :
-- désactivé, seules la dernière version et sa date restent visibles (liste des versions et contenu ?v= refusés).
ALTER TABLE shared_pages ADD COLUMN IF NOT EXISTS history_enabled boolean NOT NULL DEFAULT true;
