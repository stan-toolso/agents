-- ---- Artefacts de données : sources « graphql » (vivantes) -----------------------------------------------------------
-- Une source graphql interroge l'API de Skipper au moment de la lecture, avec les droits de la personne qui regarde ;
-- elle n'est jamais rafraîchie par le planificateur ni gardée en base (status reste 'pending', présenté « live »).
-- Additif (bleu/vert) : l'ancienne instance ignore ces sources (Skipper.data.<nom> y vaut null).
ALTER TABLE shared_page_sources DROP CONSTRAINT IF EXISTS shared_page_sources_kind_check;
ALTER TABLE shared_page_sources ADD CONSTRAINT shared_page_sources_kind_check CHECK (kind IN ('sql', 'script', 'graphql'));
