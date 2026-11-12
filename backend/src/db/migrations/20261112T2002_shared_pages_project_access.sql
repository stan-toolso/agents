-- ---- Artefacts : visibilité « membres du projet » ---------------------------------------------------------------------
-- Un artefact pouvait être privé, partagé nominativement ou ouvert à toute personne de Skipper avec le lien. Pour l'épingler
-- dans un tableau de bord partagé (cockpit configurable), il faut qu'il soit visible par l'équipe : `project_access` l'ouvre
-- à tout membre de son projet d'origine (jamais aux invités des pages). Additif (bleu/vert) : l'ancienne instance l'ignore.
ALTER TABLE shared_pages ADD COLUMN project_access boolean NOT NULL DEFAULT false;
