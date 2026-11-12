-- Rôle « invité » d'un projet : participe aux conversations (canaux) et lit les artefacts qu'on lui a partagés ;
-- ne voit ni sessions, ni tâches, ni coffre, ni contexte. Sous le rôle lecteur dans l'ordre des rôles.
ALTER TYPE project_role ADD VALUE IF NOT EXISTS 'guest';
