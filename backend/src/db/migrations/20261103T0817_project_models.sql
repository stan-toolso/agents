-- ---- Modèle des nouvelles sessions d'un projet -----------------------------------------------------------------
-- default_model : modèle Claude (alias « sonnet » ou identifiant complet) des nouvelles sessions du projet qui n'en
-- choisissent pas. task_models : modèle des sessions qui réalisent une tâche, par priorité ({"low": "sonnet"}),
-- prioritaire sur default_model et prérempli dans « Confier à un agent ». Null : rien ne change, le modèle par défaut
-- du propriétaire de la session s'applique. Toujours borné par les modèles autorisés du propriétaire.
ALTER TABLE projects ADD COLUMN default_model text;
ALTER TABLE projects ADD COLUMN task_models jsonb;
