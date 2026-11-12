# Cockpit configurable : tableaux de bord et pages composables

*Proposition de conception, 12 novembre 2026. Demande de Stan : « j'ai maintenant des artefacts de type tableau de bord qui se rafraîchissent ; j'aimerais que les sessions puissent configurer le tableau de bord même du projet de la même façon, et que pas mal d'endroits du cockpit soient configurables par l'utilisateur : tableau de bord global, par projet, par agent, pilotage des tâches, pages projet personnalisées. Configuration via l'interface et via une session. »*

Session de conception : https://skipper.toolso.io/sessions/ed3b7bb4-e5fd-4f83-a3ba-59cdca213630

---

## 1. Le besoin, en profondeur

### 1.1 Ce qui existe

Skipper a aujourd'hui **deux mondes qui ne se touchent pas** :

- **Le cockpit natif** : la page d'accueil (`DashboardPage`), le tableau de bord d'un projet (`ProjectDetailPage`), la vue pilotage des tâches (`TaskDashboard`), la fiche d'un agent (`AgentPage`). Ces pages sont **figées dans le code** : leurs tuiles, leurs sections, leurs seuils (« 24 h », « 8 semaines », « 5 tâches ») sont les mêmes pour tout le monde. Elles sont riches en interactions natives (répondre à une demande, reprendre une session, ouvrir une tâche, lancer une release, parler dans `#général`) et respectent les droits de chaque personne.
- **Les artefacts** : des pages HTML écrites par les agents, publiées à un lien, et depuis le 10/11 des **artefacts de données** dont les chiffres viennent de sources SQL ou de scripts que Skipper rafraîchit tout seul. Ils sont libres, versionnés, commentables, mais **vivent à côté** du cockpit : pour les voir il faut aller dans la galerie ou les épingler en favori dans la sidebar.

Le besoin est de **réunir les deux** : que le cockpit garde ses blocs natifs et leurs interactions, mais devienne **composable** (choisir, ordonner, paramétrer les blocs) et **extensible** (y mettre des blocs faits par les agents, alimentés par les données de Skipper ou par celles des systèmes du projet).

### 1.2 Pourquoi c'est important

- **Chaque projet a son pilotage.** Un projet client orienté livraison veut voir les PR, la CI et les déploiements ; un projet de contenu veut ses artefacts et ses planifications ; l'espace personnel veut ses chats. Aujourd'hui, tout le monde voit les mêmes douze sections, dont la moitié ne le concerne pas.
- **Les agents sont les meilleurs placés pour construire la vue.** Le Product Manager connaît les étiquettes d'état du projet, les métriques qui comptent, les sources (base du client, API). Il devrait pouvoir dire « voilà votre tableau de bord », et le refaire quand le projet change de phase. C'est déjà vrai pour les artefacts ; ça doit l'être pour le cockpit.
- **Le cockpit est la vitrine de Skipper chez un client** (offre hébergée multi-clients à venir). Un tableau de bord qui raconte *le* projet, et non Skipper en général, change la perception du produit.
- **Les données de Skipper lui-même sont une mine inexploitée** : tâches, sessions, PR, livraisons, consommation, conversations. Seul le projet « Skipper » peut les requêter en SQL par le coffre ; un projet client n'y a pas accès. Un bloc « cycle time par étiquette » ou « ce que Ben a livré cette semaine » doit pouvoir se construire sans accès à la base.

### 1.3 Les endroits du cockpit concernés

| Endroit | Aujourd'hui | Qui devrait le composer | Partagé ? |
|---|---|---|---|
| **Accueil** (`/`) | Tuiles, À traiter, agents, tâches, PR, consommation, activité, projets | Chaque personne pour elle-même ; un défaut pour la cellule | Personnel |
| **Tableau de bord d'un projet** | Tuiles, `#général`, À traiter, équipe, tâches, flux, débit, prochainement, activité, coûts | Administrateurs et membres du projet, le PM agent | Partagé par l'équipe |
| **Pilotage des tâches** (vue de la page Tâches) | Tuiles, burn-up, débit, flux cumulé, vieillissement, répartitions, listes | Idem | Partagé |
| **Fiche d'un agent** (onglet Activité) | Sessions et tâches récentes, coût | Ses gestionnaires, l'agent lui-même | Partagé |
| **Pages personnalisées d'un projet** | N'existent pas | Administrateurs, le PM agent | Partagé, nouvel onglet |
| **Onglets d'un projet** | Figés (18 onglets) | Administrateurs | Partagé |
| *Plus tard* : fiche d'une tâche, panneau de droite d'une session, espace personnel | — | — | — |

### 1.4 Cas d'usage concrets

1. *Stan, sur l'accueil* : « Je ne veux pas la consommation en haut, je veux les PR à fusionner en premier, et un bloc avec les déploiements de la journée sur tous mes projets. »
2. *Chris (PM) pour le projet Skipper* : « Ajoute au tableau de bord du projet un bloc "flux par étiquette" limité aux tâches `infra`, un graphique du cycle time par semaine, et retire le débit hebdomadaire qui fait doublon avec le pilotage. »
3. *Un client, projet e-commerce* : « Je veux voir sur la page du projet le chiffre d'affaires de la veille (base PostgreSQL du coffre), à côté de ce que font les agents. » → un artefact de données épinglé comme bloc.
4. *Ben (Developer) pour sa fiche* : « Montre sur ma fiche mes PR fusionnées par semaine, mon coût par tâche livrée, et les retours de revue reçus. »
5. *Un administrateur* : « Ce projet n'a pas de dépôt : masque Dépôt, Pull requests et Livraisons. Ajoute une page "Reporting client" qui montre trois artefacts côte à côte. »
6. *Depuis l'interface, sans agent* : glisser un bloc, masquer une section, changer « 8 semaines » en « 13 semaines », épingler un artefact depuis la galerie.
7. *La boucle* : dans le mode « Personnaliser », un champ « Demandez à un agent » : « ajoute un bloc qui compare le débit des deux derniers sprints » → une session fait le bloc, l'épingle, et la page se met à jour.

### 1.5 Ce qu'on ne veut pas

- **Remplacer le cockpit par une page HTML générée** : on perdrait les interactions natives (répondre à une demande, reprendre une session, le canal embarqué), les droits par personne, le thème, le mobile, et toute personne non technique serait dépendante d'un agent pour le moindre changement. Le cockpit reste natif ; il devient composable.
- **Un éditeur de widgets « no-code » complet** (constructeur de requêtes, de graphiques) : c'est le travail de l'agent. L'interface règle, ordonne, épingle, paramètre ; l'agent construit.
- **Des configurations qui divergent en silence** : ce que l'agent écrit et ce que la personne règle passent par **le même objet**, versionné et audité, avec un « Réinitialiser » qui ramène à la vue de référence.

---

## 2. Principes

1. **Un tableau de bord est une liste de blocs dans des régions.** Les régions sont fixes et simples (tuiles, colonne principale, colonne latérale, pleine largeur) ; le responsive est celui du cockpit d'aujourd'hui. Pas de grille libre à la Grafana : trop d'effort, mauvais sur mobile, inutile pour le besoin.
2. **Deux familles de blocs, un seul modèle.** Les **blocs natifs** (ceux d'aujourd'hui, extraits en catalogue, avec des paramètres) et les **blocs artefacts** (une page HTML de l'agent, dans un cadre en bac à sable, exactement comme un artefact, avec ses sources et son rafraîchissement). Un bloc natif est un composant React ; un bloc artefact est un `<iframe>` vers `/api/shared/<id>?embed=1`.
3. **La vue de référence est celle d'aujourd'hui.** Chaque endroit a un **agencement par défaut** écrit en code, identique à l'actuel : rien ne change pour personne tant qu'on ne touche à rien. « Réinitialiser » y revient.
4. **Même objet, même service, qu'on passe par l'interface ou par une session.** `cockpitService.save(scope, layout, actor)` : validation, nouvelle version, audit, notification. L'outil MCP et la mutation GraphQL l'appellent tous les deux.
5. **Les droits sont ceux des données, jamais ceux de l'agencement.** Un bloc natif ne montre que ce que la personne a le droit de voir (la tuile coût n'apparaît qu'en crédits ou pour un super administrateur, comme aujourd'hui). Un bloc artefact est servi par `viewRoute`, qui revérifie l'accès de la personne à chaque chargement. Épingler un artefact ne donne aucun droit dessus.
6. **Les données de Skipper deviennent une source comme les autres**, à travers l'API GraphQL existante, exécutée **avec les droits de la personne qui regarde**. C'est ce qui permet aux agents de construire des blocs sur les tâches, sessions, PR, livraisons et coûts de n'importe quel projet, sans SQL et sans fuite.
7. **Réversible.** Chaque enregistrement crée une version ; l'historique est consultable et restaurable ; un agent qui casse un tableau de bord se défait en un clic.

---

## 3. Modèle

### 3.1 Portées (`scope`)

Une portée identifie un endroit composable :

| Portée | Clé | Propriétaire de l'agencement | Qui peut écrire |
|---|---|---|---|
| Accueil d'une personne | `home` + `user_id` | la personne | elle seule (et ses sessions) |
| Défaut de l'accueil pour la cellule | `home:default` | la cellule | administrateurs de Skipper |
| Tableau de bord d'un projet | `project:<id>` | le projet | administrateurs et membres ; agents du projet (sous autorisation) |
| Pilotage des tâches | `project:<id>:tasks` | le projet | idem |
| Page personnalisée | `project:<id>:page:<slug>` | le projet | idem |
| Fiche d'un agent (activité) | `agent:<id>` | le projet de l'agent | ses gestionnaires, l'agent lui-même |
| *Plus tard* : fiche d'une tâche (`project:<id>:task`), panneau de session | | | |

L'espace personnel est un projet : son aperçu est `project:<id>` avec un défaut propre (sans canal ni équipe), comme aujourd'hui.

**Résolution** : agencement enregistré pour la portée, sinon le défaut en code. Pas de surcharge personnelle d'un tableau de bord partagé en v1 (voir § 9) ; en revanche chaque personne garde, comme aujourd'hui, ses réglages d'affichage légers côté client (sections repliées, période choisie).

### 3.2 L'agencement (`layout`)

Un document JSON, validé par un schéma zod (`cockpit/layout.ts`, pur et testé) :

```json
{
  "v": 1,
  "blocks": [
    { "id": "k1", "kind": "builtin", "widget": "tile.requests", "region": "tiles" },
    { "id": "k2", "kind": "builtin", "widget": "tile.tasks", "region": "tiles" },
    { "id": "k3", "kind": "builtin", "widget": "channel", "region": "main" },
    { "id": "k4", "kind": "builtin", "widget": "list.todo", "region": "main" },
    { "id": "k5", "kind": "builtin", "widget": "tasks.stages", "region": "side",
      "title": "Infra en cours", "params": { "tags": ["infra"] } },
    { "id": "k6", "kind": "artifact", "artifact": "7c1e…", "region": "side",
      "title": "CA de la veille", "params": { "days": 7 }, "height": "auto", "poll_seconds": 300 }
  ]
}
```

- `region` : `tiles` (rangée de tuiles, 2 à 6), `main` (colonne 7/12), `side` (colonne 5/12), `full` (pleine largeur, sous les colonnes). L'ordre dans le tableau est l'ordre d'affichage dans la région. Sur mobile : tuiles, puis `main`, `side`, `full`, comme aujourd'hui.
- `title` : titre affiché, facultatif (sinon celui du catalogue ou de l'artefact).
- `params` : paramètres du bloc, validés par le schéma du bloc natif ; libres pour un artefact (transmis à la page).
- Bloc artefact : `artifact` (identifiant), `version` facultative (sinon la dernière), `height` (`auto` par le protocole de redimensionnement, ou une hauteur en pixels), `poll_seconds` (rechargement du cadre, 15 s au moins ; absent : à chaque rafraîchissement des données).
- Limites : 40 blocs par agencement, 12 blocs artefacts, un même bloc natif « singleton » (le canal, la table des projets) une seule fois.

Les blocs natifs retirés n'apparaissent pas (absence = masqué). Quand Skipper ajoute un nouveau bloc natif au défaut d'une portée, les agencements personnalisés ne le reçoivent pas d'eux-mêmes : le mode « Personnaliser » le signale (« 1 nouveau bloc disponible ») et le catalogue le marque « nouveau ». C'est volontaire : un agencement composé ne doit pas bouger sans qu'on le demande.

### 3.3 Tables

```sql
-- Un agencement par portée (user_id renseigné seulement pour `home`).
CREATE TABLE cockpit_layouts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       text NOT NULL,                      -- 'home', 'project:<id>', 'project:<id>:tasks', 'agent:<id>', 'project:<id>:page:<slug>'
  user_id     uuid REFERENCES users (id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects (id) ON DELETE CASCADE,   -- dénormalisé pour les droits et l'export
  layout      jsonb NOT NULL,
  version     int  NOT NULL DEFAULT 1,
  updated_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, user_id)
);
-- Historique complet : chaque enregistrement fige l'agencement précédent (petits documents).
CREATE TABLE cockpit_layout_versions (
  layout_id   uuid NOT NULL REFERENCES cockpit_layouts (id) ON DELETE CASCADE,
  version     int  NOT NULL,
  layout      jsonb NOT NULL,
  author_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  session_id  uuid REFERENCES sessions (id) ON DELETE SET NULL,  -- quand c'est un agent
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (layout_id, version)
);
-- Pages personnalisées et onglets d'un projet.
CREATE TABLE project_pages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  slug        text NOT NULL,
  title       text NOT NULL,
  icon        text,                                -- icône Bootstrap, ex. 'bi-graph-up'
  position    int  NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, slug)
);
ALTER TABLE projects ADD COLUMN tabs jsonb NOT NULL DEFAULT '{}';   -- { "hidden": ["repo","pullRequests"], "order": [...] }
```

Audit (`dev/journal-audit`) : mutations `cockpit.update`, `cockpit.reset`, `project_page.create|update|delete`, `project.tabs`. Export d'un projet (`dev/export-import`) : agencements du projet, pages personnalisées et onglets ; les artefacts épinglés sont référencés par identifiant et suivent l'export des artefacts du projet (à ajouter si ce n'est pas déjà fait, voir § 9).

---

## 4. Les blocs natifs : le catalogue

Les sections d'aujourd'hui deviennent des composants enregistrés dans un **catalogue** (`frontend/src/cockpit/widgets/`, un module par bloc, index `catalog.ts`), décrits aussi côté serveur (`backend/src/cockpit/catalog.ts` : clé, libellé, description, portées admises, région par défaut, schéma des paramètres, singleton ou non) pour que les agents les découvrent et que la validation soit la même partout.

| Clé | Bloc | Portées | Paramètres |
|---|---|---|---|
| `tile.requests` | Demandes en attente | toutes | — |
| `tile.agents` | Agents au travail | toutes | — |
| `tile.tasks` | Tâches ouvertes | toutes | `tags`, `assignee` |
| `tile.usage` | Consommation du mois | toutes (si crédits ou super admin) | — |
| `tile.pull_requests` | Pull requests à fusionner | projet | — |
| `tile.metric` | **Un chiffre** calculé par une source (voir § 6) | toutes | `source`, `label`, `format`, seuils |
| `channel` | Canal `#général` embarqué | projet (singleton) | `conversation` (un autre canal) |
| `list.todo` | À traiter | toutes | `kinds` (demandes, sessions, tâches, PR), `limit` |
| `list.team` | L'équipe en ce moment | projet | `only_agents` |
| `list.attention_tasks` | Tâches à surveiller | toutes | `tags`, `priorities`, `limit` |
| `list.running_sessions` | Agents au travail | toutes | `agent` |
| `list.pull_requests` | Pull requests à traiter | toutes | `stages`, `limit` |
| `list.upcoming` | Prochainement (planifications, échéances) | projet | `limit` |
| `list.activity` | Activité récente | toutes | `kinds`, `limit` |
| `list.deliveries` | Dernières livraisons et déploiements | projet, accueil | `limit` |
| `list.artifacts` | Artefacts récents ou favoris | toutes | `favorites_only`, `kind` |
| `tasks.stages` | Flux des tâches par étiquette d'état | projet | `tags`, `stages` |
| `tasks.weekly` | Débit hebdomadaire | projet | `weeks` |
| `tasks.burnup` | Avancement cumulé et projection | projet, pilotage | `weeks`, `tags` |
| `tasks.flow` | Flux cumulé | pilotage | `weeks`, `tags` |
| `tasks.aging` | Vieillissement des tâches en cours | pilotage | `tags` |
| `tasks.breakdown` | Répartitions (priorité, étiquette, responsable) | pilotage | `by` |
| `usage.card` | Consommation détaillée (par jour, limites Claude, sessions coûteuses) | accueil, projet | `days` |
| `projects.table` | Une ligne par projet | accueil (singleton) | `columns` |
| `agent.summary` | L'agent : sessions récentes, tâches, coût | agent | `days` |
| `agent.actions` | Boutons des actions d'un agent (« Lancer une release », …) | projet, agent | `agent`, `actions` |
| `text` | Un texte Markdown (consigne, lien, légende) | toutes | `markdown` |

Règles d'implémentation :

- Un bloc natif reçoit `{ data, params, scope, viewer }` : `data` est le résultat de la requête de la page (`dashboard` / `projectDashboard` / `tasks`, inchangées en v1) ; les paramètres filtrent côté client. Quand un paramètre doit remonter au serveur (une autre fenêtre de semaines, un autre canal), la requête de la page prend des arguments supplémentaires calculés à partir de l'agencement. On n'éclate pas la requête unique en v1 : elle est déjà agrégée et sondée toutes les 10 s (`dev/fluidite`).
- Le composant décide s'il a quelque chose à montrer ; un bloc sans donnée garde sa ligne « vide » comme aujourd'hui, et un bloc **indisponible** pour la personne (droits, projet sans git) n'est pas rendu, sans trou.
- Tout nouveau bloc natif se déclare dans le catalogue serveur **et** le registre client, avec un test qui vérifie que les deux listes coïncident (même esprit que le test commun des serveurs MCP).

---

## 5. Les blocs artefacts : un artefact dans un cadre

Un bloc artefact, c'est **un artefact existant** affiché dans le cockpit. Rien de nouveau dans son contrat de base : HTML autonome, sources, versions, commentaires, `window.Skipper.data`. Ce qui s'ajoute :

### 5.1 Mode `embed`

`GET /api/shared/:id?embed=1` sert la version demandée avec, injectés par `inject.ts` :

- `Skipper.context` : `{ scope, viewer: { id, name }, project: { id, name } | null, params, theme: 'light' | 'dark', locale }`. Les `params` sont ceux du bloc : le même artefact peut être épinglé deux fois avec des paramètres différents.
- Les **variables du thème** (`:root { --cc-bg: …; --cc-fg: … }`, les valeurs du thème de la personne, lues côté serveur depuis `theme.css` au démarrage), un `<style>` de base (fond transparent, marges nulles, police de Skipper) et `color-scheme`. Un bloc qui utilise `var(--cc-accent)` est à la bonne couleur dans les deux thèmes, sans copier la palette.
- Un script **`widget-client.js`** (même famille que `comment-client.js` et `slides-client.js`, protocole `skipperWidget: 1`) : mesure la hauteur du document et l'envoie au parent (`size { height }`, à chaque `ResizeObserver`), reçoit `context` (changement de thème ou de paramètres sans rechargement), `refresh` (relit `Skipper.data` après un rafraîchissement : le parent recharge le cadre, comme aujourd'hui avec la clé `id:version:dataRefreshedAt`), et offre à la page une petite API **d'actions vers l'hôte** : `Skipper.navigate('/tasks/<id>')` (route interne seulement), `Skipper.openSession({ projectId, prompt })`, `Skipper.summon({ agent, text })`. Ces actions **ne font rien d'elles-mêmes** : l'hôte les reçoit par `postMessage`, vérifie l'origine du cadre, et les exécute avec l'interface normale (navigation, modale de lancement pré-remplie, modale de convocation). Le bac à sable reste sans cookie, sans stockage et sans accès à l'API.
- Pas de script des commentaires en `embed` ; un bouton discret de l'en-tête du bloc ouvre l'artefact en page entière (`/shared/<id>`), où l'on commente.

### 5.2 Un type d'artefact `widget`

On ajoute `widget` aux types d'artefacts (procédure de `dev/artefacts-donnees`, « Ajouter un type »). Un widget **est** un artefact de données (sources, rafraîchissement, versions) mais conçu pour un cadre : pas d'en-tête, largeur fluide, hauteur au contenu, sobre, un seul sujet. Pourquoi un type plutôt qu'un simple drapeau :

- La galerie et le catalogue le montrent à part (« Blocs ») avec un aperçu réduit à la taille d'une tuile ;
- La tuile « Créer » et le prompt pré-rempli diffèrent (« Crée un bloc pour le tableau de bord du projet qui montre : … ») ;
- `pages.publish` peut vérifier le contrat (pas de `<h1>` géant, pas de largeur fixe) et avertir.

Un artefact `data` ou `page` ordinaire reste épinglable (en `full` par défaut, hauteur fixe par défaut) : un rapport existant s'affiche tel quel sur une page personnalisée.

### 5.3 Visibilité

Épingler un artefact dans une portée **partagée** suppose que l'équipe puisse le voir. On ajoute un niveau de visibilité **« membres du projet »** aux artefacts (`shared_pages.project_access boolean`, à côté de `link_access`) : visible par tout membre du projet d'origine, revérifié à chaque lecture (invités exclus). Au moment d'épingler :

- depuis l'interface : si l'artefact n'est ni ouvert par lien ni ouvert au projet, la fenêtre d'épinglage propose « Ouvrir aux membres du projet » (propriétaire ou admin) ou avertit qu'il ne sera pas visible par tous ;
- depuis un agent (`cockpit.update`) : même règle, l'outil ouvre au projet si c'est le sien (il le dit), et refuse sinon avec le message adapté.

À l'affichage, une personne sans accès voit à la place du bloc « Artefact non partagé avec vous » et le nom du propriétaire. Les listes et filtres existants qui calculent la visibilité en SQL (`listForProject`, `listFavorites`, `viewRoute`) prennent le nouveau niveau en compte.

### 5.4 Rafraîchissement dans le cockpit

- Sources SQL et scripts : planifiées comme aujourd'hui (au nom du propriétaire, veille après 14 jours sans lecture : l'affichage dans un cockpit compte comme une lecture, `viewed_at` est écrit par la route `embed`).
- Le cadre est rechargé quand `dataRefreshedAt` change (le cockpit sonde déjà toutes les 10 s : la requête de la page renvoie, pour chaque bloc artefact, `{ id, version, dataRefreshedAt, viewable }`), ou toutes les `poll_seconds` si le bloc le demande.
- Les sources **vivantes** (§ 6) sont exécutées à la lecture.

---

## 6. Les données de Skipper comme source : `graphql`

C'est la pièce qui rend les agents vraiment capables sur le cockpit. Un nouveau type de source d'artefact :

```json
{ "name": "cycle", "type": "graphql",
  "query": "query($p: ID!, $since: DateTime) { tasks(projectId: $p, status: [DONE], since: $since, limit: 500) { id title tags startedAt completedAt } }",
  "variables": { "p": "{{project.id}}", "since": "{{now-13w}}" } }
```

Règles :

- **Lecture seule** : le document doit être une opération `query` (ni mutation ni subscription), une seule opération, profondeur et nombre de champs bornés (`cockpit/graphqlSource.ts` : analyse de l'AST, pas d'introspection, liste noire de champs coûteux), délai 10 s.
- **Exécutée avec les droits de la personne qui regarde**, au moment de la lecture (`embed` et `/shared/<id>`), jamais par le planificateur : c'est une source **vivante**. Le résultat est mis en cache 15 s par (artefact, version, personne, variables) pour absorber le sondage. Un artefact qui n'a que des sources vivantes n'a pas de `refresh_minutes`.
- Conséquence : la même page montre à chacun ce qu'il a le droit de voir (ses projets sur l'accueil, pas ceux des autres), et un agent ne peut pas exposer plus que ce que l'API donne déjà.
- **Variables modèles** : `{{project.id}}`, `{{viewer.id}}`, `{{params.<clé>}}`, `{{now}}`, `{{now-7d}}` / `{{now-13w}}` ; résolues côté serveur à la lecture. C'est ce qui permet « un bloc, N épinglages » et « mes tâches » sans republier.
- Dans la page : `Skipper.data.cycle` = le `data` de la réponse GraphQL ; erreurs dans `Skipper.meta.sources`.
- Outil de mise au point : `pages.data` exécute la source pour la personne qui pilote la session ; un outil **`cockpit.query`** (libre, lecture seule, mêmes bornes) laisse l'agent essayer une requête avant de la déclarer, comme `vault.sql_query` pour SQL. La page « Données » de l'artefact montre la requête aux personnes autorisées, comme pour SQL.
- Le schéma GraphQL est déjà documenté pour les agents dans le README (section API) ; le prompt des artefacts pointe vers `cockpit.schema` (introspection filtrée, renvoyée en SDL compact) pour qu'un agent trouve les champs sans deviner.

Le bloc natif `tile.metric` (§ 4) s'appuie sur la même mécanique : une tuile « un chiffre », définie par une source `graphql` ou `sql` et une expression simple (`rows[0].count`), sans écrire de HTML. C'est le bloc le moins cher à créer pour un agent, et il reste natif (thème, lien, seuil d'alerte).

Plus tard, des **jeux de données prêts** (`type: "skipper"`, `dataset: "task_cycle_times" | "usage_by_day" | …`) pourront éviter d'écrire la requête pour les besoins courants ; ils se construisent au-dessus de la même exécution.

---

## 7. Configurer depuis l'interface

### 7.1 Mode « Personnaliser »

Sur chaque endroit composable, un bouton **Personnaliser** (icône `bi-sliders`, dans les actions de l'en-tête : accueil à côté de « Rafraîchir », tableau de bord du projet à côté de « Nouvelle tâche », barre de la vue pilotage, onglet Activité d'un agent, page personnalisée). Visible selon les droits de la portée. Il passe la page en **mode édition**, sur place, sans changer de route :

- chaque bloc reçoit une barre de poignée : titre (éditable), **monter / descendre**, **déplacer vers** (tuiles, principale, latérale, pleine largeur), **paramètres** (⚙, formulaire généré depuis le schéma du bloc : cases, listes d'étiquettes avec les étiquettes du projet, nombre de semaines…), **retirer** ;
- glisser-déposer natif (HTML5, pas de bibliothèque) entre régions, avec les flèches comme solution de repli (clavier, mobile) ;
- chaque région a une zone **« + Ajouter un bloc »** qui ouvre le **catalogue** : trois volets — *Blocs Skipper* (le catalogue natif, filtré par portée, « nouveau » signalé), *Artefacts* (ceux du projet et vos favoris, cartes avec aperçu, choix de la version), *Demander à un agent* (un champ texte et un bouton : ouvre une session, ou convoque le PM du projet, avec une consigne pré-remplie qui nomme la portée et ce qui est demandé ; voir § 8.3) ;
- barre du bas : **Réinitialiser** (retour au défaut, avec confirmation), **Historique** (versions : auteur, date, note ; « Restaurer »), **Annuler**, **Enregistrer** (note facultative).

Rien n'est enregistré avant « Enregistrer » : l'état d'édition est local. L'enregistrement passe par `updateCockpitLayout(scope, layout, note)`.

Mobile : le mode édition est une liste (région par région) avec monter / descendre / retirer / paramètres ; pas de glisser-déposer.

### 7.2 Épingler depuis la galerie et depuis un artefact

- Menu « ⋯ » d'un artefact et menu d'une carte de la galerie : **Épingler dans…** → choix de la portée parmi celles où la personne peut écrire (Mon accueil, Tableau de bord du projet X, Pilotage des tâches de X, Fiche de l'agent Y, Page « … » de X), région, et titre. Même fenêtre que le volet *Artefacts* du catalogue.
- Un artefact épinglé quelque part le montre dans ses détails (« Épinglé sur : Tableau de bord de Skipper »), et la suppression de l'artefact retire les blocs qui le référencent (le cockpit tolère de toute façon une référence morte : bloc « artefact supprimé », retiré au prochain enregistrement).

### 7.3 Pages personnalisées et onglets d'un projet

Dans **Réglages › Onglets et pages** (administrateurs) :

- la liste des onglets natifs avec une case *visible* chacun (l'onglet « Tableau de bord » et « Réglages » ne se masquent pas) et l'ordre par glisser ou flèches ; un projet sans dépôt propose d'office de masquer Dépôt, Pull requests et Livraisons ;
- **Pages personnalisées** : titre, icône (choix parmi quelques icônes Bootstrap), slug dérivé ; chaque page est une portée `project:<id>:page:<slug>` dont l'agencement se compose avec « Personnaliser » sur la page elle-même (`/projects/<id>/p/<slug>`, onglet dans `ProjectHeader` à la position choisie, `describeRoute` avec le titre).

Une page personnalisée peut être **un seul artefact en pleine page** (cas « Reporting client » : bloc unique en `full`, hauteur auto) ou une composition.

---

## 8. Configurer depuis une session

### 8.1 Serveur MCP `cockpit`

Un serveur in-process (`backend/src/cockpit/mcp.ts`, convention `dev/outils-mcp-agents`), exposé à toute session Claude du projet (et aux chats de l'espace personnel pour l'accueil de la personne) :

| Outil | Rôle | Autorisation |
|---|---|---|
| `get` `{ scope }` | L'agencement actuel (blocs, titres, paramètres), la portée résolue, et le **catalogue** des blocs natifs admis (clé, description, paramètres) ; liste des artefacts épinglables | libre |
| `update` `{ scope, ops | layout, note }` | Modifie l'agencement : soit une liste d'**opérations** (`add` bloc natif ou artefact avec région et position, `remove`, `move`, `set` titre/paramètres), soit le document complet. Valide, enregistre une version, audite. Renvoie le nouvel agencement et les avertissements (artefact non visible par l'équipe, bloc indisponible pour certains) | `home` de la personne qui pilote, fiche de l'agent lui-même : libre ; portée partagée d'un projet : **soumis à l'humain**, mémorisable (« toujours autoriser » pour le PM) |
| `reset` `{ scope }` | Retour au défaut | idem |
| `history` `{ scope }` / `restore` `{ scope, version }` | Versions et restauration | idem |
| `query` `{ query, variables }` | Exécute une requête GraphQL de lecture avec les droits de la personne qui pilote (mise au point d'une source) | libre |
| `schema` `{ type? }` | Le schéma GraphQL en SDL compact (types, champs, arguments), filtré pour l'agent | libre |
| `page_create` / `page_update` / `page_delete` `{ project, slug, title, icon, position }` | Pages personnalisées | soumis à l'humain |
| `tabs` `{ project, hidden, order }` | Onglets du projet | soumis à l'humain |

Les portées se désignent en clair : `home`, `project` (celui de la session), `tasks`, `agent:<nom>`, `page:<slug>`, ou la clé complète. Dans l'espace personnel, `project` doit être nommé (paramètre `project` des outils, comme pour `tasks`).

### 8.2 Construire un bloc

Le chemin complet d'un agent qui ajoute un bloc fait maison :

1. `cockpit.get` pour voir ce qui est déjà là et le catalogue (peut-être qu'un bloc natif paramétré suffit : `tasks.stages` avec `tags: ["infra"]` ne demande aucun HTML).
2. Sinon, mettre au point la donnée : `cockpit.query` (données de Skipper) ou `vault.sql_query` (base du projet).
3. Écrire `bloc.html` (contrat § 5 : fluide, sans en-tête, `var(--cc-*)`, lit `Skipper.data` et `Skipper.context.params`, prévoit vide et erreur), le publier : `pages.publish { kind: "widget", sources: [...], refresh_minutes }`.
4. Vérifier le rendu : `GET` de l'URL `embed` dans le navigateur headless aux deux thèmes (`?embed=1&theme=dark`), largeur d'une tuile et d'une colonne.
5. `cockpit.update { scope: "project", ops: [{ op: "add", artifact: "<id>", region: "side", title: "…", params: {...} }] }`.
6. Dire à la personne ce qui a changé ; si c'est dans une portée partagée, un message dans `#général` est bienvenu (« j'ai ajouté le bloc Cycle time au tableau de bord »).

Le prompt système des sessions reçoit un paragraphe « Cockpit » (à côté du paragraphe « Artefacts ») qui dit cela en moins de mots, et le modèle Product Manager (`agents/templates.ts`) une consigne : « Tu es responsable du tableau de bord du projet : propose-le, tiens-le à jour quand le projet change de phase, ne le modifie que sur demande ou avec accord ».

### 8.3 La boucle interface → agent → interface

Le volet *Demander à un agent* du catalogue (§ 7.1) construit une consigne du type :

> Configure le tableau de bord du projet « Skipper » (portée `project:2f33…`). Demande : *« ajoute un bloc qui compare le débit des deux derniers sprints »*. Regarde d'abord `cockpit.get` ; préfère un bloc natif paramétré quand il existe ; sinon construis un bloc (`pages.publish`, kind widget) et épingle-le avec `cockpit.update`. Vérifie le rendu avant d'épingler.

et l'envoie soit au Product Manager du projet s'il y en a un (`agents.summon`, la session s'ouvre dans l'onglet), soit à une nouvelle session de la personne. La page sort du mode édition ; quand l'agent enregistre, le sondage de la page récupère le nouvel agencement (la requête de la page renvoie `layout.version`) et un bandeau « Tableau de bord mis à jour par Chris » le signale, avec « Voir les changements » (diff des blocs : ajoutés, retirés, modifiés) et « Restaurer la version précédente ».

Dans l'autre sens, une personne qui règle un bloc artefact (titre, paramètres) ne touche pas à l'artefact ; si elle veut le changer, « Demander une mise à jour à l'agent » existe déjà sur l'artefact (`requestSharedPageUpdate`).

---

## 9. Sécurité, droits, performance

- **Bac à sable inchangé** pour les blocs artefacts : CSP `sandbox` sans `allow-same-origin`, pas de cookie, pas d'API ; les seules actions vers l'hôte passent par `postMessage`, origine et forme vérifiées, liste blanche de trois actions exécutées par l'interface (navigation interne, ouverture de la modale de session pré-remplie, convocation). Aucune action silencieuse : la modale s'affiche, la personne confirme.
- **Sources `graphql`** : requête seule, bornée, exécutée dans le contexte GraphQL de la personne qui regarde (`requireUser`, mêmes résolveurs, mêmes chargeurs groupés) ; un invité n'a pas accès au mode `embed` hors des pages où il a été ajouté (liste blanche `GUEST_ROOT_FIELDS` inchangée : `cockpit*` n'y figure pas).
- **Agencement partagé** : écriture réservée aux administrateurs et membres (pas lecteur) ; pour un agent, demande d'autorisation à la personne qui pilote (mémorisable), comme pour les écritures sensibles. Audit de chaque version avec l'auteur et la session.
- **Épinglage** : ne confère aucun droit ; l'accès à chaque bloc artefact est recalculé à la lecture (`viewRoute`), et `Skipper.context` ne contient que l'identité de la personne qui regarde et le projet, jamais de secret.
- **Charge** : un agencement = une ligne jsonb lue avec la requête de la page (chargeur groupé) ; blocs natifs sans requête supplémentaire en v1 ; blocs artefacts bornés à 12 et rechargés seulement quand leurs données changent ; sources vivantes mises en cache 15 s ; journal des opérations lentes existant pour mesurer (`dev/fluidite`).
- **Bleu/vert** : rien de particulier (lecture/écriture en base, pas d'état en mémoire, à part le cache des sources vivantes, local à l'instance et court).
- **Mock démo et audit mobile** : le serveur factice sert les agencements par défaut et quelques blocs artefacts ; l'audit Playwright parcourt le mode édition sur mobile.

---

## 10. Découpage proposé

Six lots indépendamment livrables, chacun utile seul. Les deux premiers suffisent à la demande initiale (« les sessions configurent le tableau de bord du projet comme un artefact »).

| Lot | Contenu | Dépend de |
|---|---|---|
| **1. Socle : agencements et blocs natifs** | Tables, `cockpitService` (résolution, validation, versions, audit), catalogue serveur + registre client, défauts égaux à l'existant, `DashboardPage` et `ProjectDetailPage` rendus depuis l'agencement, mode « Personnaliser » (ordre, région, retirer, ajouter un bloc natif, réinitialiser, historique), MCP `cockpit` (`get`, `update`, `reset`, `history`, `restore`), prompt. Mock démo. Instruction `dev/cockpit`. | — |
| **2. Blocs artefacts** | Mode `embed`, `widget-client.js` (hauteur, contexte, thème, actions vers l'hôte), type `widget`, visibilité « membres du projet », volet *Artefacts* du catalogue, « Épingler dans… », rechargement sur rafraîchissement, blocs `tile.metric` et `text`. | 1 |
| **3. Sources vivantes `graphql`** | Type de source, analyse et bornes, exécution au nom de la personne qui regarde, variables modèles, cache, `cockpit.query` et `cockpit.schema`, panneau Données, tests. | 2 |
| **4. Paramètres des blocs natifs et nouvelles portées** | Schémas de paramètres et formulaires générés, filtres (étiquettes, semaines, canal), vue pilotage composable (`project:<id>:tasks`), fiche d'agent composable (`agent:<id>`, blocs `agent.*`), défaut de l'accueil par la cellule. | 1 |
| **5. Pages personnalisées et onglets** | `project_pages`, `projects.tabs`, Réglages › Onglets et pages, onglet dynamique dans `ProjectHeader`, route `/p/<slug>`, outils `page_*` et `tabs`, export/import. | 1 (2 pour la page « un artefact en pleine page ») |
| **6. La boucle** | Volet *Demander à un agent*, consigne pré-remplie, bandeau « mis à jour par … » avec diff et restauration, consigne du Product Manager, « Voir les changements » dans l'historique. | 1 |

Estimation grossière : lots 1 et 2 sont les plus gros (chacun de l'ordre d'une grosse PR avec tests et instruction de contexte) ; 3 à 6 sont des PR moyennes.

---

## 11. Questions ouvertes (à trancher avec Stan)

1. **Surcharge personnelle d'un tableau de bord partagé** : faut-il qu'une personne puisse masquer ou réordonner pour elle seule le tableau de bord du projet, sans toucher à celui de l'équipe ? Proposition : pas en v1 (deux niveaux d'agencement compliquent l'édition et le « Réinitialiser ») ; on y vient si le besoin se confirme, par un `cockpit_layouts` avec `user_id` sur la même portée, fusionné en lecture (masqués et ordre seulement).
2. **Qui, parmi les membres, peut modifier le tableau de bord partagé** : membres et administrateurs (proposé), ou administrateurs seulement ? Le fil des versions et la restauration rendent le choix large peu risqué.
3. **Autorisation des agents sur les portées partagées** : demande à l'humain mémorisable (proposé), ou libre pour un agent dont la fiche porte un rôle « responsable du tableau de bord » ? Peut être une action de la fiche d'agent (comme `release`).
4. **Visibilité « membres du projet » des artefacts** : nouveau niveau proposé ici ; on pourrait aussi exiger un partage explicite. Le niveau projet semble de toute façon manquer aux artefacts (demandé implicitement par l'onglet Artefacts du projet, qui ne montre aujourd'hui que ce qui est ouvert par lien ou partagé nominativement).
5. **Export des artefacts dans l'archive d'un projet** : nécessaire pour que les pages personnalisées survivent à un import ; à vérifier dans `dev/export-import` (aujourd'hui l'archive ne semble pas emporter les pages partagées).
6. **Grafana-like (grille libre, redimensionnement)** : écarté ici au profit de régions fixes. À reconsidérer seulement si les pages personnalisées en montrent le besoin.
7. **Le panneau de droite d'une session et la fiche d'une tâche** comme portées : plausibles (bloc « erreurs Sentry de cette branche », « le ticket client lié »), avec `Skipper.context.session` / `.task` ; hors périmètre de la v1.

---

## 12. Ce que ça change pour les agents, en une phrase

Aujourd'hui un agent *produit* des tableaux de bord à côté de Skipper ; demain il *compose le cockpit* : il choisit les blocs natifs, les paramètre, construit ceux qui manquent sur les données de Skipper ou du projet, et les met là où l'équipe regarde, sous le contrôle (autorisation, versions, restauration) de la personne qui pilote.
