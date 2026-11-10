-- Tous les artefacts sont versionnés en entier, comme les pages : chaque version garde, à côté de son HTML, le type
-- de l'artefact, le rafraîchissement et la définition des sources de données (nom, type, requête ou script) au moment
-- de la publication. Les données elles-mêmes restent vivantes (shared_page_sources) : une ancienne version reçoit les
-- dernières données des sources dont la définition n'a pas changé. Migration additive (bleu/vert) : null = inconnu
-- (version publiée par l'ancienne instance), on retombe alors sur l'état courant de l'artefact.
ALTER TABLE shared_page_versions
  ADD COLUMN kind text CHECK (kind IS NULL OR kind IN ('page', 'data', 'slides')),
  ADD COLUMN refresh_minutes integer,
  -- Artefact de données : [{ name, kind, config }] dans l'ordre ; null pour les autres types.
  ADD COLUMN sources jsonb;

-- Le type de chaque version existante est celui de l'artefact ; la dernière version d'un artefact de données reçoit
-- ses sources actuelles (les plus anciennes restent inconnues : elles n'ont pas été gardées).
UPDATE shared_page_versions v SET kind = p.kind FROM shared_pages p WHERE p.id = v.page_id;
UPDATE shared_page_versions v
   SET refresh_minutes = p.refresh_minutes,
       sources = (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', s.name, 'kind', s.kind, 'config', s.config) ORDER BY s.position, s.name), '[]'::jsonb)
                    FROM shared_page_sources s WHERE s.page_id = p.id)
  FROM shared_pages p
 WHERE p.id = v.page_id AND p.kind = 'data' AND v.version = p.version;
