-- Artefacts : troisième type, « slides » (diapositives : un deck HTML, une <section class="slide"> par diapositive,
-- lu par le lecteur injecté par Skipper). Additif (bleu/vert) : l'ancienne instance sert une page « slides » comme une page.
ALTER TABLE shared_pages DROP CONSTRAINT shared_pages_kind_check;
ALTER TABLE shared_pages ADD CONSTRAINT shared_pages_kind_check CHECK (kind IN ('page', 'data', 'slides'));
