// Données de démonstration du serveur factice (MOCK_DEMO=1, utilisé par l'aperçu de Skipper) : un monde cohérent —
// une personne connectée, son espace personnel, quatre projets d'équipe, leurs sessions, tâches, demandes, pull
// requests, coffre et contexte — au lieu des textes longs de l'audit mobile. Les champs absents des objets sont
// complétés par le générateur du serveur, avec des valeurs courtes (demoScalar).
//
// Chaque champ d'un objet peut être une valeur ou une fonction (args) => valeur : les relations sont paresseuses et
// les champs à arguments (Project.sessions(status), Session.events(after)…) filtrent leurs résultats.

const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const inDays = (days) => new Date(NOW + days * 86_400_000).toISOString();
const day = (offset) => new Date(NOW + offset * 86_400_000).toISOString().slice(0, 10);

// ---- Personnes et agents ------------------------------------------------------------------------------------------

const user = (id, name, email, extra = {}) => ({ __typename: 'User', id, name, email, avatarUrl: null, isAdmin: false, isSuperAdmin: false, kind: 'PERSON', agent: null, createdAt: ago(60 * 24 * 120), lastLoginAt: ago(30), ...extra });
const U = {
  me: user('u-camille', 'Camille Laurent', 'camille.laurent@toolso.io', { isAdmin: true, lastLoginAt: ago(2) }),
  hugo: user('u-hugo', 'Hugo Bernard', 'hugo.bernard@toolso.io', { lastLoginAt: ago(45) }),
  lea: user('u-lea', 'Léa Fontaine', 'lea.fontaine@toolso.io', { lastLoginAt: ago(60 * 5) }),
  thomas: user('u-thomas', 'Thomas Petit', 'thomas.petit@toolso.io', { lastLoginAt: ago(60 * 24 * 2) }),
  chris: user('u-chris', 'Chris', 'chris@agents.toolso.io', { kind: 'AGENT' }),
  max: user('u-max', 'Max', 'max@agents.toolso.io', { kind: 'AGENT' }),
  nora: user('u-nora', 'Nora', 'nora@agents.toolso.io', { kind: 'AGENT' }),
};
const people = [U.me, U.hugo, U.lea, U.thomas];
const person = (u) => ({ __typename: 'TaskPerson', name: u.name, email: u.email });

// ---- Projets ------------------------------------------------------------------------------------------------------

const P = {};
const project = (id, name, slug, description, gitUrl, extra = {}) => ({
  __typename: 'Project',
  id,
  name,
  slug,
  description,
  gitUrl,
  gitBranch: gitUrl ? 'main' : null,
  systemPrompt: '',
  taskInstructions: '',
  runnerConfig: {},
  defaultPermissionMode: 'default',
  defaultModel: null,
  taskModels: null,
  approvalConnections: [],
  isMember: true,
  isPersonal: false,
  myRole: 'ADMIN',
  gitHosted: false,
  hostedGit: null,
  workspacePath: `/home/skipper/skipper-workspaces/${slug}`,
  workspaceExists: true,
  git: gitUrl ? { __typename: 'WorkspaceGit', branch: 'main', commit: '8b7bff3' } : null,
  runnerStatus: { __typename: 'RunnerStatus', kind: 'docker', ready: true, state: 'running', containerName: `skipper-${slug}`, image: 'skipper-runner:latest', memory: '4g', cpus: null, startedAt: ago(60 * 26), error: null, outdated: false, outdatedReasons: [] },
  containerStats: null,
  createdAt: ago(60 * 24 * 90),
  updatedAt: ago(20),
  sessions: (args = {}) => sessionsOf(id, args),
  tasks: (args = {}) => filterTasks({ projectId: id, ...args, status: args.status ?? null }),
  worksessions: () => sessions.filter((s) => s.project === P[key(id)] && s.worksession && !s.archivedAt).map((s) => s.worksession),
  archivedWorksessions: [],
  terminals: [],
  members: () => (id === 'p-perso' ? [member(U.me, 'ADMIN')] : [member(U.me, 'ADMIN'), member(U.hugo, 'MEMBER'), member(U.lea, 'MEMBER'), ...(id === 'p-data' || id === 'p-api' ? [member(U.thomas, 'VIEWER')] : []), ...agents.filter((a) => a.project.id === id).map((a) => member(a.user, 'MEMBER'))]),
  agents: () => agents.filter((a) => a.project === P[key(id)]),
  contextFolders: () => contextFolders.filter((f) => f.projectId === id),
  contextInstructions: () => contextInstructions.filter((i) => i.projectId === id),
  contextChanges: [],
  vaultItems: () => (id === 'p-perso' ? [] : vaultItems.filter((v) => v.ownerProject === P[key(id)] || v.shared).map((item) => ({ __typename: 'ProjectVaultItem', item, via: item.ownerProject ? 'PROJECT' : 'OWN', link: null, forAgents: true }))),
  apiKeys: [],
  conversations: () => conversations.filter((c) => c.project.id === id),
  unreadMessages: () => conversations.filter((c) => c.project.id === id).reduce((n, c) => n + c.unreadCount, 0),
  // Fils de tâches suivis : les tâches du projet qui ont des messages, la plus récemment commentée d'abord.
  followedTaskThreads: () =>
    tasks
      .filter((t) => t.project.id === id && comments.some((c) => c.taskId === t.id))
      .map((t) => {
        const own = comments.filter((c) => c.taskId === t.id);
        const last = own.map((c) => c.createdAt).sort().at(-1) ?? null;
        return { __typename: 'TaskThreadSummary', id: `cv-${t.id}`, slug: `task-${t.id}`, task: t, messageCount: own.length, lastMessageAt: last };
      })
      .sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt))),
  permissionRules: [],
  ...extra,
});
const key = (id) => id.slice(2);
const member = (u, role) => ({ __typename: 'ProjectMember', user: u, role, invitedBy: null, createdAt: ago(60 * 24 * 60), pending: false });

P.perso = project('p-perso', 'Espace de Camille', 'perso-camille', 'Mon espace personnel : chats et brouillons.', null, { isPersonal: true });
P.site = project('p-site', 'Site vitrine Toolso', 'site-vitrine', 'Le site public toolso.io : pages produit, tarifs, blog et formulaire de contact (Astro).', 'https://github.com/toolso/site-vitrine', { taskModels: { low: 'claude-sonnet-5-5' } });
P.api = project('p-api', 'API Facturation', 'api-facturation', 'Service de facturation : abonnements Stripe, factures PDF, relances et exports comptables.', 'https://github.com/toolso/api-facturation');
P.mobile = project('p-mobile', 'Appli Scouts', 'appli-scouts', 'Application mobile des groupes scouts : inscriptions aux camps, cotisations et messagerie des parents.', 'https://github.com/toolso/appli-scouts');
// Camille n'y est que lectrice : ses sessions s'ouvrent en lecture seule (ni saisie, ni actions).
P.data = project('p-data', 'Data & reporting', 'data-reporting', 'Tableaux de bord et rapports hebdomadaires (dbt, Metabase).', 'https://github.com/toolso/data-reporting', { myRole: 'VIEWER' });
const teamProjects = [P.site, P.api, P.mobile, P.data];
// Budgets mensuels (page Consommation) : l'API Facturation a passé 80 %, l'appli Scouts est loin du sien.
const PROJECT_MONTH = { 'p-perso': 3.1, 'p-site': 38.4, 'p-api': 104.2, 'p-mobile': 27.5, 'p-data': 12.9 };
for (const p of [P.perso, ...teamProjects]) {
  p.monthUsd = PROJECT_MONTH[p.id];
  p.monthlyBudgetUsd = p.id === 'p-api' ? 120 : p.id === 'p-mobile' ? 150 : null;
}

// ---- Agents de projet ---------------------------------------------------------------------------------------------

const agent = (id, u, p, kind, emoji, color, description) => {
  const a = {
    __typename: 'Agent', id, user: u, name: u.name, project: p, kind, avatar: { __typename: 'AgentAvatar', emoji, color }, description,
    instructions: description, taskFolder: true, defaults: {}, contextFolder: null, enabled: true, archivedAt: null, canManage: true,
    triggers: { __typename: 'AgentTriggers', taskCreated: kind === 'PRODUCT_MANAGER', taskCreatedTag: null, threadFollowed: true, prMerged: false, taskReady: kind === 'DEVELOPER', taskReadyTag: null },
    actions: kind === 'PRODUCT_MANAGER' ? [{ __typename: 'AgentAction', key: 'release', label: 'Préparer une release', instruction: 'Prépare une release.', cron: null, timezone: null, scheduleSession: null }] : [], managers: [],
    stats: () => ({ __typename: 'AgentStats', activeSessions: sessions.filter((s) => s.owner === u && !s.archivedAt).length, sessions: 14, tasks: 9, monthCostUsd: 18.4, totalCostUsd: 61.2, lastActivityAt: ago(12) }),
    sessions: () => sessions.filter((s) => s.owner === u),
    tasks: () => tasks.filter((t) => t.assignee?.email === u.email),
    createdAt: ago(60 * 24 * 20), updatedAt: ago(60 * 24),
  };
  u.agent = a;
  return a;
};
const agents = [
  agent('a-chris', U.chris, P.site, 'PRODUCT_MANAGER', '🧭', '#7c5cff', 'Cadre les demandes, anime les tâches et prépare les releases.'),
  agent('a-max', U.max, P.mobile, 'DEVELOPER', '🛠️', '#d97757', 'Développe les tâches prêtes, ouvre les pull requests et répond aux revues.'),
  agent('a-nora', U.nora, P.api, 'CUSTOM', '🔎', '#2f9e8f', 'Relit les pull requests : sécurité, tests manquants, cas limites.'),
];

// ---- Sessions -----------------------------------------------------------------------------------------------------

const sessions = [];
function session(id, p, name, opts = {}) {
  const branch = opts.branch === undefined ? id.replace(/^s-/, '') : opts.branch;
  const s = {
    __typename: 'Session',
    id,
    kind: opts.kind ?? 'SESSION',
    project: p,
    name,
    provider: 'claude',
    status: opts.status ?? 'RUNNING',
    activity: opts.activity ?? (opts.status && opts.status !== 'RUNNING' ? null : 'IDLE'),
    owner: opts.owner ?? U.me,
    requestedBy: opts.requestedBy ?? null,
    takenOverBy: opts.takenOverBy ?? null,
    viewerCanTakeOver: Boolean(opts.owner?.agent && opts.requestedBy === U.me),
    agent: opts.owner?.agent ?? null,
    archivedAt: opts.archivedAt ?? null,
    formerWorksession: null,
    parentSession: null,
    childSessions: [],
    workflowRun: null,
    prompt: opts.prompt ?? name,
    promptAttachments: [],
    config: { model: opts.model ?? 'default', permissionMode: opts.permissionMode ?? 'default' },
    model: opts.model ?? 'claude-opus-5-5',
    externalId: null,
    exitCode: opts.status === 'FAILED' ? 1 : null,
    error: opts.error ?? null,
    costUsd: opts.cost ?? 0.42,
    createdAt: ago(opts.age ?? 90),
    updatedAt: ago(opts.updated ?? 3),
    startedAt: ago(opts.age ?? 90),
    endedAt: opts.status && opts.status !== 'RUNNING' ? ago(opts.updated ?? 30) : null,
    browserActive: false,
    liveDraft: null,
    queuedAt: null,
    queuePosition: null,
    review: null,
    shares: [],
    schedule: null,
    cleanup: { __typename: 'SessionCleanup', retentionDays: null, contextAction: null, contextMaxTokens: null },
    contextTokens: opts.tokens ?? 38_000,
    context: { __typename: 'SessionContext', tokens: opts.tokens ?? 38_000, warnTokens: 150_000, overThreshold: false, model: 'claude-opus-5-5', windowTokens: 200_000, share: (opts.tokens ?? 38_000) / 200_000, coldTurnUsd: 0.21 },
    task: () => tasks.find((t) => t.sessionIds?.includes(id)) ?? null,
    tasks: () => tasks.filter((t) => t.sessionIds?.includes(id)),
    requests: (args = {}) => requests.filter((r) => r.session === s && (!args.status || r.status === args.status)),
    pendingRequestCount: () => requests.filter((r) => r.session === s && r.status === 'PENDING').length,
    events: (args = {}) => {
      const all = (eventsBySession[id] ?? defaultEvents)(s);
      const start = args.after ? all.findIndex((e) => e.id === args.after) + 1 : 0;
      return start <= 0 && args.after ? [] : all.slice(start, args.limit ? start + args.limit : undefined);
    },
  };
  s.worksession =
    branch && opts.kind !== 'CHAT'
      ? {
          __typename: 'Worksession', id: `w-${id.slice(2)}`, project: p, name: branch, branch, label: name, customLabel: null,
          path: `/home/skipper/skipper-workspaces/${p.slug}.worktrees/${branch}`, exists: true,
          git: { __typename: 'WorkspaceGit', branch, commit: 'a41c9e2' }, archivedAt: null, pullRequest: null,
          trackedPullRequest: () => pullRequests.find((pr) => pr.headBranch === branch) ?? null,
          task: () => s.task(), createdAt: s.createdAt, sessions: [s], terminals: [],
        }
      : null;
  sessions.push(s);
  return s;
}
const sessionsOf = (projectId, args = {}) =>
  sessions
    .filter((s) => s.project.id === projectId && s.kind === 'SESSION' && !s.archivedAt && (!args.status || s.status === args.status))
    .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100));

const S = {
  tarifs: session('s-page-tarifs', P.site, 'Refonte de la page tarifs', { activity: 'BUSY', age: 70, updated: 0, cost: 1.86, tokens: 64_000, prompt: 'Refonds la page /tarifs : trois offres en cartes, un comparatif détaillé dessous et une FAQ. Garde le style du site.' }),
  contact: session('s-formulaire-contact', P.site, 'Formulaire de contact sur mobile', { model: 'claude-sonnet-5-5', age: 60 * 5, updated: 25, cost: 0.74 }),
  blog: session('s-chris-tri-blog', P.site, 'Tri des demandes du blog', { owner: U.chris, requestedBy: U.me, age: 60 * 3, updated: 40, cost: 0.31, branch: null }),
  pdf: session('s-export-pdf', P.api, 'Export des factures en PDF', { owner: U.hugo, activity: 'BUSY', age: 50, updated: 1, cost: 1.12 }),
  revuePdf: session('s-nora-revue-118', P.api, 'Revue de la PR #118', { model: 'claude-haiku-5-5', owner: U.nora, requestedBy: U.hugo, age: 25, updated: 4, cost: 0.22, branch: null }),
  stripe: session('s-stripe-2026-10', P.api, 'Migration vers l’API Stripe 2026-10', { status: 'COMPLETED', age: 60 * 28, updated: 60 * 22, cost: 3.4 }),
  relances: session('s-relances-impayes', P.api, 'Relances automatiques des impayés', { status: 'INTERRUPTED', age: 60 * 30, updated: 60 * 20, cost: 0.95 }),
  push: session('s-notifs-camps', P.mobile, 'Notifications push des camps', { owner: U.lea, status: 'FAILED', age: 60 * 6, updated: 60 * 2, cost: 0.58, error: 'npm run test : 2 tests en échec (CampReminder.test.ts)' }),
  revue: session('s-max-cotisations', P.mobile, 'Paiement des cotisations en trois fois', { owner: U.max, requestedBy: U.lea, takenOverBy: U.lea, activity: 'BUSY', age: 35, updated: 0, cost: 0.66 }),
  hebdo: session('s-rapport-hebdo', P.data, 'Rapport hebdo des inscriptions', { owner: U.hugo, model: 'claude-sonnet-5-5', age: 60 * 24 * 6, updated: 60 * 9, cost: 2.1, branch: null }),
  chat1: session('c-idees-blog', P.perso, 'Idées d’articles pour le blog', { kind: 'CHAT', age: 60 * 2, updated: 50, cost: 0.08 }),
  chat2: session('c-compte-rendu', P.perso, 'Résumé du comité de pilotage', { kind: 'CHAT', age: 60 * 26, updated: 60 * 25, cost: 0.05 }),
  chat3: session('c-mail-client', P.perso, 'Réponse à un client mécontent', { kind: 'CHAT', age: 60 * 50, updated: 60 * 49, cost: 0.03 }),
};
S.hebdo.schedule = { __typename: 'SessionSchedule', sessionId: S.hebdo.id, name: 'Rapport du lundi', customName: 'Rapport du lundi', session: S.hebdo, project: P.data, cron: '0 8 * * 1', timezone: 'Europe/Paris', prompt: 'Prépare le rapport hebdomadaire des inscriptions et publie-le.', enabled: true, endAfterRun: false, allowedTools: ['Bash(npm run report *)'], nextRunAt: inDays(5), lastRunAt: ago(60 * 9), cleanup: null };
const chats = sessions.filter((s) => s.kind === 'CHAT');
// Lien public de lecture de la session « page tarifs » (/share/<DEMO_SHARE_TOKEN>, servi par le mock).
export const DEMO_SHARE_TOKEN = 'demo-partage-page-tarifs-0123456789abcdefgh';
S.tarifs.shares = [{ __typename: 'SessionShare', id: 'sh-1', url: `${'http://localhost'}/share/${DEMO_SHARE_TOKEN}`, expiresAt: inDays(6), createdAt: ago(60 * 24), createdBy: U.me }];

// ---- Transcripts --------------------------------------------------------------------------------------------------

let eventSeq = 0;
const ev = (s, minutesAgo, type, payload) => ({ __typename: 'SessionEvent', id: `${s.id}-e${++eventSeq}`, sessionId: s.id, type, payload, createdAt: ago(minutesAgo) });
const said = (s, m, text) => ev(s, m, 'claude.assistant', { message: { content: [{ type: 'text', text }] } });
const tool = (s, m, id, name, input, result) => [
  ev(s, m, 'claude.assistant', { message: { content: [{ type: 'tool_use', id, name, input }] } }),
  ev(s, m, 'claude.user', { message: { content: [{ type: 'tool_result', tool_use_id: id, content: result }] } }),
];
const done = (s, m, turns, usd) => ev(s, m, 'claude.result', { subtype: 'success', is_error: false, num_turns: turns, duration_ms: turns * 9_000, total_cost_usd: usd });
const memo = (fn) => {
  let cache;
  return (s) => (cache ??= fn(s));
};
const eventsBySession = {
  'c-idees-blog': memo((s) => [
    ev(s, 120, 'instruction', { text: 'Propose-moi cinq idées d’articles pour le blog de Toolso, pour des dirigeants de PME.' }),
    said(s, 119, 'Voici cinq pistes :\n\n1. **Confier une tâche à un agent sans perdre la main** : ce qu’on délègue, ce qu’on valide.\n2. **Trois semaines avec un Product Manager agent** : retour d’expérience chiffré.\n3. **Le coût réel d’une fonctionnalité** livrée par des agents, en jours-homme.\n4. **Sécurité : ce que l’agent voit (et ne voit pas)** de vos accès.\n5. **De l’idée à la mise en production en une journée** : un cas client.\n\nJe peux développer le plan de l’une d’elles.'),
    done(s, 119, 1, 0.04),
    ev(s, 52, 'instruction', { text: 'Développe la 3.' }),
    said(s, 50, '## Le coût réel d’une fonctionnalité\n\n- **Accroche** : « combien coûte ce bouton ? » — la question que tout dirigeant pose.\n- **Méthode** : temps humain de cadrage et de revue + travail des agents en crédits.\n- **Exemple** : export PDF des factures, 2 h de cadrage, 1,1 crédit d’agent, une revue de 20 min.\n- **Conclusion** : le coût se déplace vers le cadrage et la revue.'),
    done(s, 50, 1, 0.04),
  ]),
  's-page-tarifs': memo((s) => [
    ev(s, 70, 'instruction', { text: s.prompt }),
    said(s, 69, 'Je commence par regarder la page actuelle et les composants disponibles.'),
    ...tool(s, 69, 't1', 'Glob', { pattern: 'src/pages/**/*.astro' }, 'src/pages/index.astro\nsrc/pages/tarifs.astro\nsrc/pages/blog/[slug].astro\nsrc/pages/contact.astro'),
    ...tool(s, 68, 't2', 'Read', { file_path: '/workspace/src/pages/tarifs.astro' }, '---\nimport Layout from "../layouts/Layout.astro";\n---\n<Layout title="Tarifs">\n  <h1>Nos tarifs</h1>\n  …'),
    said(s, 66, 'La page tient en un tableau unique. Je crée un composant `PricingCard` et je réécris la page en trois sections : offres, comparatif, FAQ.'),
    ...tool(s, 64, 't3', 'Write', { file_path: '/workspace/src/components/PricingCard.astro', content: '---\nconst { name, price, features, highlighted } = Astro.props;\n---\n<article class:list={["card", { highlighted }]}>…</article>' }, 'File created successfully'),
    ...tool(s, 60, 't4', 'Edit', { file_path: '/workspace/src/pages/tarifs.astro', old_string: '<h1>Nos tarifs</h1>', new_string: '<h1>Des offres simples, sans engagement</h1>\n<section class="offers">…</section>' }, 'The file has been updated.'),
    said(s, 58, 'Les trois offres (Découverte, Équipe, Entreprise) sont en place, l’offre Équipe est mise en avant. Je vérifie le build avant de passer au comparatif.'),
    ...tool(s, 57, 't5', 'Bash', { command: 'npm run build', description: 'Build du site' }, '> astro build\n\n 14 page(s) built in 6.21s\n Complete!'),
    done(s, 56, 9, 0.92),
    ev(s, 20, 'instruction', { text: 'Super. Ajoute la FAQ avec les questions du support, et un interrupteur mensuel / annuel (-20 %).', author: { type: 'user', id: U.hugo.id, name: U.hugo.name, email: U.hugo.email } }),
    ...tool(s, 18, 't6', 'Read', { file_path: '/workspace/docs/faq-support.md' }, '## Puis-je changer d’offre ?\nOui, à tout moment…\n## Les agents ont-ils accès à mes données ?\n…'),
    said(s, 12, 'J’ajoute l’interrupteur de période : les prix annuels sont calculés à partir des prix mensuels (-20 %), et la FAQ reprend les six questions du support en accordéon.'),
    ...tool(s, 9, 't7', 'Edit', { file_path: '/workspace/src/pages/tarifs.astro', old_string: '<section class="offers">', new_string: '<BillingToggle />\n<section class="offers">' }, 'The file has been updated.'),
    ...tool(s, 8, 't8', 'mcp__tasks__create', { title: 'Traduire la page tarifs en anglais', priority: 'low' }, 'Tâche créée'),
    ev(s, 8, 'task', { action: 'created', taskId: 't-3', projectId: 'p-site', title: 'Traduire la page tarifs en anglais', status: 'todo', priority: 'low' }),
    ...tool(s, 7, 't9', 'mcp__context__write', { path: 'conventions/tarifs', content: '…' }, 'Mise à jour : conventions/tarifs (version 2)'),
    ev(s, 7, 'context', { action: 'updated', projectId: 'p-site', instructionId: 'i-tarifs', path: 'conventions/tarifs', description: 'Prix annuels = prix mensuels −20 %, arrondis à l’euro', version: 2, agentId: null, library: null, changeNote: 'Remise annuelle' }),
    said(s, 1, 'Il me reste à relancer le build et à pousser la branche : j’ai besoin de ton accord pour la commande.'),
  ]),
};
const defaultEvents = (s) => {
  const list = eventsBySession[s.id];
  if (list) return list(s);
  eventsBySession[s.id] = memo((x) => [
    ev(x, 60, 'instruction', { text: x.prompt }),
    said(x, 58, `Je regarde le code concerné par « ${x.name} » et je reviens avec un plan.`),
    ...tool(x, 55, `${x.id}-t1`, 'Grep', { pattern: x.name.split(' ')[0].toLowerCase(), path: 'src' }, 'src/index.ts\nsrc/services/main.ts'),
    said(x, 40, 'Plan :\n\n1. isoler la logique dans un service dédié ;\n2. ajouter les tests ;\n3. brancher l’interface.\n\nJe commence.'),
    done(x, 39, 4, 0.3),
  ]);
  return eventsBySession[s.id](s);
};

// ---- Tâches -------------------------------------------------------------------------------------------------------

let taskSeq = 0;
const tasks = [];
function task(p, title, status, priority, opts = {}) {
  const t = {
    __typename: 'Task',
    id: `t-${++taskSeq}`,
    project: p,
    title,
    description: opts.description ?? `${title}.\n\nCritères d’acceptation : le comportement est couvert par un test et la documentation est à jour.`,
    status,
    statusTag: opts.statusTag ?? null,
    tags: opts.tags ?? [],
    priority,
    sessionIds: opts.sessions?.map((s) => s.id) ?? [],
    session: () => opts.sessions?.[0] ?? null,
    sessionsInCharge: () => (status === 'IN_PROGRESS' ? opts.sessions ?? [] : []),
    resumableSession: null,
    sessions: () => opts.sessions ?? [],
    costUsd: (opts.sessions ?? []).reduce((n, s) => n + s.costUsd, 0),
    sessionCosts: () => (opts.sessions ?? []).map((s) => ({ __typename: 'TaskSessionCost', session: s, usd: s.costUsd })),
    createdByType: opts.byAgent ? 'session' : 'user',
    createdBySession: null,
    dueDate: opts.due ?? null,
    customFields: [],
    assignee: opts.assignee ? person(opts.assignee) : null,
    reporter: person(opts.reporter ?? U.me),
    attachmentCount: 0,
    attachments: [],
    reactions: [],
    mentionables: () => [...people, U.chris, U.max, U.nora].map((u) => ({ __typename: 'TaskMentionable', kind: 'person', id: u.id, label: u.name, detail: u.email, text: `@${u.name}` })),
    branch: opts.sessions?.[0]?.worksession?.branch ?? null,
    worksession: () => opts.sessions?.[0]?.worksession ?? null,
    pullRequest: null,
    pullRequests: () => pullRequests.filter((pr) => pr.task === t),
    createdAt: ago(opts.age ?? 60 * 24 * 3),
    updatedAt: ago(opts.updated ?? 60 * 2),
    completedAt: status === 'DONE' ? ago(opts.updated ?? 60 * 24) : null,
  };
  t.comments = () => comments.filter((c) => c.taskId === t.id);
  t.commentCount = () => comments.filter((c) => c.taskId === t.id).length;
  tasks.push(t);
  return t;
}
const T = {
  tarifs: task(P.site, 'Refondre la page tarifs (offres, comparatif, FAQ)', 'IN_PROGRESS', 'HIGH', { sessions: [S.tarifs], assignee: U.me, tags: ['site', 'design'], due: day(3), statusTag: 'en revue' }),
  contact: task(P.site, 'Le formulaire de contact déborde sur iPhone SE', 'IN_PROGRESS', 'MEDIUM', { sessions: [S.contact], assignee: U.me, tags: ['mobile', 'bug'] }),
  seo: task(P.site, 'Balises Open Graph pour les articles du blog', 'TODO', 'LOW', { tags: ['seo'], byAgent: true, reporter: U.chris }),
  cas: task(P.site, 'Page « Cas clients » avec trois témoignages', 'TODO', 'MEDIUM', { tags: ['contenu'], assignee: U.lea, due: day(10) }),
  perf: task(P.site, 'Score Lighthouse mobile au-dessus de 90', 'DONE', 'MEDIUM', { tags: ['perf'], updated: 60 * 24 * 2 }),
  pdf: task(P.api, 'Export des factures en PDF depuis l’espace client', 'IN_PROGRESS', 'URGENT', { sessions: [S.pdf], assignee: U.hugo, tags: ['factures'], due: day(1) }),
  stripe: task(P.api, 'Passer à l’API Stripe 2026-10', 'DONE', 'HIGH', { sessions: [S.stripe], assignee: U.me, tags: ['stripe'], updated: 60 * 22, statusTag: 'à livrer' }),
  relances: task(P.api, 'Relances automatiques des factures impayées (J+7, J+15, J+30)', 'IN_PROGRESS', 'HIGH', { sessions: [S.relances], assignee: U.me, tags: ['factures'], statusTag: 'bloquée', due: day(-1) }),
  tva: task(P.api, 'TVA intracommunautaire sur les factures B2B', 'TODO', 'MEDIUM', { tags: ['compta'] }),
  push: task(P.mobile, 'Rappel push la veille du départ en camp', 'IN_PROGRESS', 'HIGH', { sessions: [S.push], assignee: U.lea, tags: ['notifications'] }),
  cotis: task(P.mobile, 'Paiement des cotisations en trois fois', 'IN_PROGRESS', 'MEDIUM', { sessions: [S.revue], assignee: U.max, tags: ['paiement'], reporter: U.lea }),
  hors: task(P.mobile, 'Mode hors ligne pour la fiche sanitaire', 'TODO', 'LOW', { tags: ['offline'] }),
  ios: task(P.mobile, 'Publier la version 2.4 sur l’App Store', 'CANCELLED', 'MEDIUM', { updated: 60 * 24 * 5 }),
  hebdo: task(P.data, 'Rapport hebdomadaire des inscriptions par groupe', 'DONE', 'MEDIUM', { sessions: [S.hebdo], assignee: U.me, tags: ['rapport'], updated: 60 * 9 }),
  churn: task(P.data, 'Tableau de bord du churn mensuel dans Metabase', 'TODO', 'HIGH', { tags: ['metabase'], assignee: U.hugo, due: day(7) }),
};

let commentSeq = 0;
const comments = [];
const comment = (t, author, minutesAgo, body, extra = {}) => {
  const c = {
    __typename: 'TaskComment', id: `tc-${++commentSeq}`, taskId: t.id, parentId: null, authorType: author.kind === 'AGENT' ? 'session' : 'user',
    authorName: author.name, author, authorSession: null, agent: author.agent ?? null, body, mentions: [], reactions: [], attachments: [], editable: author === U.me,
    deletable: author === U.me, attachments: [], createdAt: ago(minutesAgo), updatedAt: ago(minutesAgo), ...extra,
  };
  comments.push(c);
  return c;
};
comment(T.tarifs, U.lea, 60 * 26, 'Le support reçoit beaucoup de questions sur l’offre annuelle : on peut l’afficher directement sur la page ?');
comment(T.tarifs, U.chris, 60 * 25, 'J’ai ajouté l’interrupteur mensuel / annuel aux critères d’acceptation. @Camille Laurent, tu valides la remise de 20 % ?', { authorType: 'agent', authorSession: S.blog });
comment(T.tarifs, U.me, 60 * 24, 'Oui, 20 % sur l’annuel. Go.', { reactions: [{ __typename: 'TaskReaction', emoji: '👍', count: 2, actors: ['Léa Fontaine', 'Chris'], mine: false }] });
// Message écrit par une session pilotée par une personne : signé par la personne, avec un lien discret vers la session.
comment(T.tarifs, U.me, 60 * 23, 'Interrupteur mensuel / annuel en place, remise de 20 % appliquée. Capture mobile jointe à la PR.', { authorType: 'agent', authorName: S.tarifs.name, author: null, authorSession: S.tarifs, editable: false });
comment(T.pdf, U.hugo, 90, 'Le rendu des montants négatifs (avoirs) est à vérifier avec la compta.');
comment(T.relances, U.me, 60 * 20, 'Bloqué tant qu’on n’a pas le modèle d’e-mail validé par le juridique.');
comment(T.pdf, U.nora, 20, 'Revue de la PR #118 : le calcul des totaux arrondit ligne par ligne, ce qui peut décaler d’un centime le total TTC. Voir `InvoicePdf.ts:84`.');
comment(T.cotis, U.max, 30, 'PR ouverte : échéancier calculé côté serveur, trois prélèvements Stripe programmés. Les tests passent.');

// ---- Conversations d'équipe (canaux) ------------------------------------------------------------------------------

let msgSeq = 0;
const messages = [];
const conversations = [];
const channel = (p, slug, name, topic, extra = {}) => {
  const c = {
    __typename: 'Conversation', id: `c-${p.id}-${slug}`, slug, name, topic, archivedAt: null, createdAt: ago(60 * 24 * 40), lastMessageAt: null,
    project: p, unreadCount: 0, messageCount: () => messages.filter((m) => m.conversationId === c.id).length,
    mentionables: () => [...people, ...agents.map((a) => a.user)].map((u) => ({ __typename: 'TaskMentionable', kind: 'user', id: u.id, label: u.name, detail: u.kind === 'AGENT' ? 'agent' : u.email, text: `@${u.name}` })),
    messages: () => messages.filter((m) => m.conversationId === c.id),
    ...extra,
  };
  conversations.push(c);
  return c;
};
const message = (c, author, minutesAgo, body, extra = {}) => {
  const m = {
    __typename: 'Message', id: `msg-${++msgSeq}`, conversationId: c.id, parentId: null, authorType: author.kind === 'AGENT' ? 'agent' : 'human',
    authorName: author.name, author, authorSession: null, agent: author.agent ?? null, body, mentions: [], reactions: [], attachments: [], editable: author === U.me,
    deletable: author === U.me, replyCount: () => messages.filter((r) => r.parentId === m.id).length, lastReplyAt: () => messages.filter((r) => r.parentId === m.id).at(-1)?.createdAt ?? null,
    respondingSessions: [], createdAt: ago(minutesAgo), updatedAt: ago(minutesAgo), ...extra,
  };
  if (!c.lastMessageAt || m.createdAt > c.lastMessageAt) c.lastMessageAt = m.createdAt;
  messages.push(m);
  return m;
};
const C = {
  siteGeneral: channel(P.site, 'general', 'général', 'Pilotage du site vitrine', { unreadCount: 2 }),
  siteLivraisons: channel(P.site, 'livraisons', 'livraisons', 'Mises en production et releases'),
  siteIdees: channel(P.site, 'idees', 'idées', ''),
  apiGeneral: channel(P.api, 'general', 'général', ''),
  mobileGeneral: channel(P.mobile, 'general', 'général', ''),
  dataGeneral: channel(P.data, 'general', 'général', ''),
};
const mention = (u) => ({ __typename: 'TaskMention', kind: 'user', id: u.id, label: u.name, text: `@${u.name}` });
const m1 = message(C.siteGeneral, U.me, 60 * 3, '@Chris @Léa Fontaine on vise la mise en ligne de la nouvelle page tarifs ce soir. Qu’est-ce qui bloque encore ?', {
  mentions: [mention(U.chris), mention(U.lea)], reactions: [{ __typename: 'TaskReaction', emoji: '👀', count: 2, actors: ['Chris', 'Léa Fontaine'], mine: false }],
  respondingSessions: () => [S.tarifs],
});
message(C.siteGeneral, U.chris, 60 * 3 - 2, 'Trois choses : la PR #142 attend une relecture, la tâche « Formulaire de contact sur mobile » n’est pas cadrée, et le test de la FAQ échoue sur Safari. Je propose de livrer sans le formulaire : je le cadre pour la suite.', { parentId: m1.id });
message(C.siteGeneral, U.lea, 60 * 3 - 20, 'OK pour moi. @Chris tu passes la tâche à « prête » une fois cadrée ?', { parentId: m1.id, mentions: [mention(U.chris)] });
message(C.siteGeneral, U.chris, 60 * 9, 'Point du matin : 2 PR fusionnées hier, 1 à relire (#142), aucune tâche bloquée. Les demandes du blog sont triées.', {
  reactions: [{ __typename: 'TaskReaction', emoji: '👍', count: 1, actors: ['Camille Laurent'], mine: true }],
});
message(C.siteGeneral, U.hugo, 60 * 26, 'Le support signale que la page tarifs n’affiche pas l’offre annuelle sur mobile. Quelqu’un peut jeter un œil ?', {
  attachments: [{ __typename: 'MessageAttachment', id: 'msg-att-1', name: 'ticket-support-4521.pdf', mediaType: 'application/pdf', size: 184_320, createdAt: ago(60 * 26) }],
});
message(C.siteLivraisons, U.me, 60 * 24 * 2, 'v1.7 en production. Rien à signaler sur les métriques.', { reactions: [{ __typename: 'TaskReaction', emoji: '🎉', count: 3, actors: ['Hugo Bernard', 'Léa Fontaine', 'Chris'], mine: false }] });
message(C.siteLivraisons, U.chris, 60 * 24 * 2 + 30, 'Notes de version préparées dans le contexte (`releases/v1.7`).');
message(C.apiGeneral, U.hugo, 60 * 5, '@Nora peux-tu relire la PR #118 ? Le calcul des totaux me semble fragile.', { mentions: [mention(U.nora)] });
message(C.apiGeneral, U.nora, 60 * 5 - 10, 'Relecture faite : l’arrondi ligne par ligne peut décaler le total TTC d’un centime. Détail dans la tâche « Export des factures en PDF ».', { parentId: messages.at(-1).id });

const filterTasks = (a = {}) =>
  tasks.filter(
    (t) =>
      (!a.projectId || t.project.id === a.projectId) &&
      (a.status === null || (a.status ?? ['TODO', 'IN_PROGRESS']).includes(t.status)) &&
      (!a.priority || t.priority === a.priority) &&
      (!a.tag || t.tags.some((x) => x.toLowerCase() === a.tag.toLowerCase())) &&
      (!a.mine || t.assignee?.email === U.me.email) &&
      (!a.assignee || (t.assignee?.name ?? '').toLowerCase().includes(a.assignee.toLowerCase())),
  ).slice(0, a.limit ?? 500);

// ---- Demandes -----------------------------------------------------------------------------------------------------

const requests = [
  {
    __typename: 'Request', id: 'r-build-tarifs', session: S.tarifs, type: 'permission', status: 'PENDING', title: 'Bash : npm run build && git push',
    message: null, payload: { toolName: 'Bash', input: { command: 'npm run build && git push -u origin page-tarifs', description: 'Build puis push de la branche' }, suggestions: [] },
    response: null, answeredBy: null, createdAt: ago(1), answeredAt: null,
  },
  {
    __typename: 'Request', id: 'r-question-pdf', session: S.pdf, type: 'question', status: 'PENDING', title: 'Question de l’agent', message: null,
    payload: {
      questions: [
        {
          header: 'Avoirs', question: 'Comment afficher les avoirs dans le PDF ?', multiSelect: false,
          options: [
            { label: 'Montants négatifs', description: 'Une ligne « Avoir » avec un montant en négatif, comme aujourd’hui à l’écran.' },
            { label: 'Document séparé', description: 'Un PDF « Avoir » distinct, rattaché à la facture d’origine.' },
          ],
        },
      ],
    },
    response: null, answeredBy: null, createdAt: ago(6), answeredAt: null,
  },
  {
    __typename: 'Request', id: 'r-old', session: S.stripe, type: 'permission', status: 'ANSWERED', title: 'Bash : npm test', message: null,
    payload: { toolName: 'Bash', input: { command: 'npm test' } }, response: { behavior: 'allow' }, answeredBy: U.me, createdAt: ago(60 * 23), answeredAt: ago(60 * 23 - 1),
  },
];

// ---- Pull requests ------------------------------------------------------------------------------------------------

let prSeq = 0;
const pr = (p, t, number, title, headBranch, stage, opts = {}) => ({
  __typename: 'TrackedPullRequest', id: `pr-${++prSeq}`, project: p, task: t, repo: p.gitUrl.replace('https://github.com/', ''), foreignRepo: false,
  number, url: number ? `${p.gitUrl}/pull/${number}` : '', worksession: () => sessions.find((s) => s.worksession?.branch === headBranch)?.worksession ?? null,
  localCommits: stage === 'PENDING' ? 3 : 0, localChanges: stage === 'PENDING' ? 2 : 0, title, headBranch, baseBranch: 'main',
  status: { PENDING: 'PENDING', DRAFT: 'OPEN', TO_MERGE: 'OPEN', MERGED: 'MERGED', CANCELLED: 'CLOSED' }[stage], isDraft: stage === 'DRAFT', stage,
  checksState: opts.checks ?? (stage === 'TO_MERGE' ? 'SUCCESS' : stage === 'DRAFT' ? 'PENDING' : null), reviewDecision: opts.review ?? null, mergeable: 'MERGEABLE',
  syncedAt: ago(1), mergeSha: stage === 'MERGED' ? '3d5e9cb' : null, note: opts.note ?? '', createdByType: 'session', createdBy: U.me, createdBySession: null,
  openedAt: ago(opts.age ?? 60 * 5), mergedAt: stage === 'MERGED' ? ago(60 * 22) : null, closedAt: null, createdAt: ago(opts.age ?? 60 * 5), updatedAt: ago(10),
  github: null, session: () => sessions.find((s) => s.worksession?.branch === headBranch) ?? null,
});
const pullRequests = [
  pr(P.site, T.tarifs, null, 'Refonte de la page tarifs', 'page-tarifs', 'PENDING'),
  pr(P.mobile, T.cotis, 42, 'Paiement des cotisations en trois fois', 'max-cotisations', 'TO_MERGE', { review: 'APPROVED', age: 40 }),
  pr(P.api, T.pdf, 118, 'Export PDF des factures', 'export-pdf', 'DRAFT', { age: 45 }),
  pr(P.api, T.stripe, 115, 'Migration vers l’API Stripe 2026-10', 'stripe-2026-10', 'MERGED', { age: 60 * 27 }),
  pr(P.site, T.contact, 87, 'Formulaire de contact : champs empilés sous 400 px', 'formulaire-contact', 'TO_MERGE', { checks: 'FAILURE', age: 60 * 4 }),
];

// ---- Notifications ------------------------------------------------------------------------------------------------

let notifSeq = 0;
const notif = (type, title, message, link, p, s, minutesAgo, read) => ({
  __typename: 'Notification', id: `n-${++notifSeq}`, type, title, message, link, project: p, session: s, payload: {}, user: U.me,
  readAt: read ? ago(minutesAgo - 1) : null, createdAt: ago(minutesAgo),
});
const notifications = [
  notif('request', 'Autorisation demandée', 'Refonte de la page tarifs : npm run build && git push', `/sessions/${S.tarifs.id}`, P.site, S.tarifs, 1, false),
  notif('request', 'Question de l’agent', 'Export des factures en PDF : comment afficher les avoirs ?', `/sessions/${S.pdf.id}`, P.api, S.pdf, 6, false),
  notif('task_mention', 'Chris vous a mentionné', 'Refondre la page tarifs : « tu valides la remise de 20 % ? »', `/tasks/${T.tarifs.id}`, P.site, null, 60 * 25, false),
  notif('session_failed', 'Session en erreur', 'Notifications push des camps : 2 tests en échec', `/sessions/${S.push.id}`, P.mobile, S.push, 60 * 2, true),
  notif('pull_request', 'PR fusionnée', 'api-facturation #115 : Migration vers l’API Stripe 2026-10', `/projects/${P.api.id}/pull-requests`, P.api, null, 60 * 22, true),
];

// ---- Coffre -------------------------------------------------------------------------------------------------------

const vault = (id, name, kind, description, extra = {}) => ({
  __typename: 'VaultItem', id, name, kind, description, ownerUser: extra.ownerProject ? null : U.me, ownerProject: null, ownerProjectName: extra.ownerProject?.name ?? null,
  myPermission: 'MANAGE', myShare: null, host: null, port: null, username: null, url: null, langfusePublicKey: null, token: null, fields: [], database: null,
  ssl: null, sslCa: null, via: null, authScheme: null, authName: null, google: null, aws: null, scaleway: null, readOnly: true, requireApproval: false,
  envExport: false, commandAllowlist: [], publicKey: null, hostFingerprint: null, hostKeySeenAt: null, hasSecret: true, revealableFields: [],
  secretUpdatedAt: ago(60 * 24 * 30), expiresAt: null, lastTestAt: ago(60 * 3), lastTestOk: true, lastTestError: null, shares: [], links: [], audit: [],
  createdBy: U.me, createdAt: ago(60 * 24 * 40), updatedAt: ago(60 * 24 * 2), ...extra,
});
const vaultItems = [
  vault('v-prod-ssh', 'serveur-prod', 'ssh', 'Serveur de production (Scaleway), utilisateur deploy.', { ownerProject: P.api, host: 'prod.toolso.io', port: 22, username: 'deploy', requireApproval: true, readOnly: false }),
  vault('v-db', 'base-facturation', 'postgres', 'Base PostgreSQL de la facturation, en lecture seule.', { ownerProject: P.api, host: 'db.toolso.io', port: 5432, username: 'lecture', database: 'facturation', ssl: true }),
  vault('v-stripe', 'stripe-test', 'api', 'Clé Stripe du mode test.', { ownerProject: P.api, url: 'https://api.stripe.com', authScheme: 'BEARER' }),
  vault('v-metabase', 'metabase', 'website', 'Compte de service Metabase.', { ownerProject: P.data, url: 'https://metabase.toolso.io', username: 'agents@toolso.io' }),
  vault('v-gmail', 'gmail-camille', 'google', 'Boîte Gmail de Camille, lecture seule.', { shared: true }),
];
for (const v of vaultItems) v.ownerProject = teamProjects.find((p) => p.name === v.ownerProjectName) ?? null;

// ---- Contexte -----------------------------------------------------------------------------------------------------

const contextFolders = [];
const contextInstructions = [];
const folder = (p, id, name) => {
  const f = { __typename: 'ContextFolder', id, projectId: p.id, parentId: null, name, slug: name.toLowerCase(), path: name.toLowerCase(), createdAt: ago(60 * 24 * 30), updatedAt: ago(60 * 24) };
  contextFolders.push(f);
  return f;
};
const instruction = (p, f, slug, name, description, content) => {
  const i = {
    __typename: 'ContextInstruction', id: `ci-${p.slug}-${slug}`, projectId: p.id, folderId: f?.id ?? null, name, slug, path: `${f ? `${f.slug}/` : ''}${slug}`, description,
    content, version: 2, createdAt: ago(60 * 24 * 20), updatedAt: ago(60 * 24 * 2),
  };
  i.versions = () => [2, 1].map((version) => ({ __typename: 'ContextInstructionVersion', version, name, description, content, createdAt: ago(60 * 24 * (version === 2 ? 2 : 20)), author: U.me, authorSession: null }));
  contextInstructions.push(i);
  return i;
};
for (const p of teamProjects) {
  const dev = folder(p, `cf-${p.slug}-dev`, 'Dev');
  const produit = folder(p, `cf-${p.slug}-produit`, 'Produit');
  instruction(p, dev, 'conventions', 'Conventions de code', 'Style, nommage, tests et revue des pull requests.', `# Conventions de code — ${p.name}\n\n- TypeScript strict, pas de \`any\`.\n- Un test par comportement, à côté du fichier testé.\n- Messages de commit en français, à l’impératif.\n\n| Dossier | Contenu |\n|---|---|\n| \`src/\` | code applicatif |\n| \`tests/\` | tests d’intégration |\n\n\`\`\`bash\nnpm run lint && npm test\n\`\`\`\n`);
  instruction(p, dev, 'deploiement', 'Déploiement', 'Comment livrer en production (jamais sans accord explicite).', '# Déploiement\n\n1. PR verte et relue.\n2. Fusion sur `main`.\n3. Le déploiement part tout seul ; vérifier les journaux.\n');
  instruction(p, produit, 'vocabulaire', 'Vocabulaire métier', 'Les mots du métier et leur sens.', '# Vocabulaire\n\n- **Groupe** : unité locale.\n- **Camp** : séjour de plusieurs jours.\n- **Cotisation** : adhésion annuelle.\n');
}

// ---- Tableau de bord, file « À traiter » ------------------------------------------------------------------------

const live = () => sessions.filter((s) => s.kind === 'SESSION' && !s.archivedAt);
const pending = () => requests.filter((r) => r.status === 'PENDING');
const usageDays = Array.from({ length: 30 }, (_, i) => ({ __typename: 'DashboardUsageDay', day: day(i - 29), usd: Math.round((4 + 6 * Math.abs(Math.sin(i * 1.7)) + (i % 7 < 5 ? 3 : 0)) * 100) / 100 }));
const inboxCounts = () => {
  const c = {
    __typename: 'InboxCounts', requests: pending().length, idleSessions: live().filter((s) => s.status === 'RUNNING' && s.activity === 'IDLE' && s.owner === U.me).length,
    failedSessions: live().filter((s) => s.status === 'FAILED').length, interruptedSessions: live().filter((s) => s.status === 'INTERRUPTED').length,
    pullRequests: pullRequests.filter((x) => x.stage === 'TO_MERGE').length,
  };
  c.total = c.requests + c.idleSessions + c.failedSessions + c.interruptedSessions + c.pullRequests;
  return c;
};
const dashboard = () => ({
  __typename: 'Dashboard',
  generatedAt: new Date().toISOString(),
  counts: {
    __typename: 'DashboardCounts', pendingRequests: pending().length, busySessions: live().filter((s) => s.activity === 'BUSY').length,
    idleSessions: live().filter((s) => s.status === 'RUNNING' && s.activity === 'IDLE').length, failedSessions24h: 1, endedSessions24h: 3,
    todoTasks: tasks.filter((t) => t.status === 'TODO').length, inProgressTasks: tasks.filter((t) => t.status === 'IN_PROGRESS').length,
    overdueTasks: tasks.filter((t) => t.dueDate && t.dueDate < day(0) && t.status !== 'DONE').length, doneTasks7d: tasks.filter((t) => t.status === 'DONE').length,
    unreadNotifications: notifications.filter((n) => !n.readAt).length, openPullRequests: pullRequests.filter((x) => x.status === 'OPEN').length,
    pendingPullRequests: pullRequests.filter((x) => x.stage === 'PENDING').length,
  },
  usage: {
    __typename: 'DashboardUsage', monthStart: new Date(new Date(NOW).getFullYear(), new Date(NOW).getMonth(), 1).toISOString(), monthUsd: 84.6, globalMonthUsd: 212.3,
    monthlyBudgetUsd: 300, todayUsd: 6.4, last7DaysUsd: 51.2, previous7DaysUsd: 43.8, byDay: usageDays, rateLimits: null,
    topSessions: [S.stripe, S.hebdo, S.tarifs, S.pdf].map((s) => ({ __typename: 'UsageBySession', sessionId: s.id, sessionName: s.name, projectName: s.project.name, usd: s.costUsd })),
  },
  projects: teamProjects.map((p, i) => {
    const ps = live().filter((s) => s.project === p);
    return {
      __typename: 'DashboardProject', project: p, busySessions: ps.filter((s) => s.activity === 'BUSY').length, idleSessions: ps.filter((s) => s.status === 'RUNNING' && s.activity === 'IDLE').length,
      pendingRequests: pending().filter((r) => r.session.project === p).length, todoTasks: tasks.filter((t) => t.project === p && t.status === 'TODO').length,
      inProgressTasks: tasks.filter((t) => t.project === p && t.status === 'IN_PROGRESS').length, overdueTasks: p === P.api ? 1 : 0, monthUsd: [24.1, 31.7, 18.2, 10.6][i], lastActivityAt: ago(i * 30 + 1),
    };
  }),
  pendingRequests: pending(),
  runningSessions: live().filter((s) => s.status === 'RUNNING'),
  recentSessions: [...live()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 6),
  attentionTasks: [T.relances, T.pdf, T.tarifs],
  pullRequests: pullRequests.filter((x) => x.stage !== 'MERGED'),
});

// ---- Git ---------------------------------------------------------------------------------------------------------

const commit = (hash, subject, author, minutesAgo) => ({ __typename: 'GitCommit', hash: `${hash}0000000000000000000000000000000000`.slice(0, 40), shortHash: hash.slice(0, 7), subject, author, date: ago(minutesAgo) });
const commits = [
  commit('a41c9e2', 'Page tarifs : interrupteur mensuel / annuel', 'Camille Laurent', 9),
  commit('7d03b1f', 'Page tarifs : composant PricingCard et trois offres', 'Camille Laurent', 62),
  commit('8b7bff3', 'Blog : balises canoniques', 'Léa Fontaine', 60 * 26),
  commit('3d5e9cb', 'Contact : validation côté serveur', 'Hugo Bernard', 60 * 50),
];
const branchFiles = [
  { path: 'src/pages/tarifs.astro', status: 'M', additions: 148, deletions: 41 },
  { path: 'src/components/PricingCard.astro', status: 'A', additions: 62, deletions: 0 },
  { path: 'src/components/BillingToggle.astro', status: 'A', additions: 37, deletions: 0 },
  { path: 'src/styles/pricing.css', status: 'M', additions: 24, deletions: 6 },
].map((f) => ({ __typename: 'SessionFileChange', origPath: null, untracked: false, ...f }));
const worksessionOf = (id) => (id ? sessions.map((s) => s.worksession).find((w) => w?.id === id) ?? null : null);
const gitStatus = (a) => {
  const w = worksessionOf(a.worksessionId);
  const dirty = w?.branch === 'page-tarifs';
  return {
    __typename: 'GitStatus', branch: w?.branch ?? 'main', upstream: `origin/${w?.branch ?? 'main'}`, ahead: w ? 2 : 0, behind: 0, detached: false, operation: null,
    headCommit: w ? commits[0] : commits[2],
    changes: dirty ? [{ __typename: 'GitFileChange', path: 'src/pages/tarifs.astro', origPath: null, indexStatus: ' ', worktreeStatus: 'M', staged: false, unstaged: true, untracked: false, conflicted: false }] : [],
  };
};

// ---- Requêtes racine ----------------------------------------------------------------------------------------------

const byId = (list, id) => list.find((x) => x.id === id) ?? null;
const allProjects = [P.perso, ...teamProjects];
const providers = [
  {
    __typename: 'Provider', type: 'claude', label: 'Claude Code', description: 'Agent de code Claude, dans le conteneur du projet.', interactive: true,
    configFields: [
      { __typename: 'ConfigField', key: 'model', label: 'Modèle', type: 'select', required: false, description: null, defaultValue: 'default', advanced: false, options: [
        { __typename: 'ConfigOption', value: 'default', label: 'Mon modèle par défaut (Opus 5.5)', description: null },
        { __typename: 'ConfigOption', value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: null },
        { __typename: 'ConfigOption', value: 'claude-haiku-5-5', label: 'Haiku 5.5', description: null },
      ] },
      { __typename: 'ConfigField', key: 'permissionMode', label: 'Autorisations', type: 'select', required: false, description: null, defaultValue: 'default', advanced: false, options: [
        { __typename: 'ConfigOption', value: 'default', label: 'Demander avant d’agir', description: null },
        { __typename: 'ConfigOption', value: 'acceptEdits', label: 'Accepter les modifications', description: null },
        { __typename: 'ConfigOption', value: 'plan', label: 'Planifier seulement', description: null },
        { __typename: 'ConfigOption', value: 'bypassPermissions', label: 'Tout autoriser', description: null },
      ] },
    ],
  },
];


/** Tableau de bord d'un projet : la vue d'ensemble restreinte au projet, plus l'équipe, le canal général, les planifications. */
const projectDashboard = (id) => {
  const p = byId(allProjects, id);
  const d = dashboard();
  const ps = live().filter((s) => s.project === p);
  const members = p.members();
  return {
    __typename: 'ProjectDashboard',
    generatedAt: d.generatedAt,
    counts: { ...d.counts, pendingRequests: pending().filter((r) => r.session.project === p).length, busySessions: ps.filter((s) => s.activity === 'BUSY').length, idleSessions: ps.filter((s) => s.status === 'RUNNING' && s.activity === 'IDLE').length, todoTasks: tasks.filter((t) => t.project === p && t.status === 'TODO').length, inProgressTasks: tasks.filter((t) => t.project === p && t.status === 'IN_PROGRESS').length },
    usage: { ...d.usage, monthUsd: 24.1 },
    pendingRequests: pending().filter((r) => r.session.project === p),
    runningSessions: ps.filter((s) => s.status === 'RUNNING'),
    recentSessions: [...ps].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 5),
    attentionTasks: tasks.filter((t) => t.project === p && ['URGENT', 'HIGH'].includes(t.priority) && t.status !== 'DONE'),
    pullRequests: pullRequests.filter((x) => x.project === p && x.stage !== 'MERGED'),
    mergedPullRequests: pullRequests.filter((x) => x.project === p && x.stage === 'MERGED'),
    staleTasks: tasks.filter((t) => t.project === p && t.status === 'IN_PROGRESS' && !(t.sessionIds ?? []).some((sid) => ps.some((s) => s.id === sid && s.status === 'RUNNING'))),
    schedules: sessions.filter((s) => s.schedule && s.project === p).map((s) => s.schedule),
    general: conversations.find((c) => c.project === p && c.slug === 'general') ?? null,
    team: members.map((m) => {
      const ms = ps.filter((s) => s.status === 'RUNNING' && s.owner === m.user);
      return { __typename: 'ProjectTeamMember', user: m.user, agent: m.user.agent ?? null, sessions: ms, tasks: tasks.filter((t) => t.project === p && (t.sessionIds ?? []).some((sid) => ms.some((s) => s.id === sid))), lastActivityAt: ms[0]?.updatedAt ?? m.user.lastLoginAt };
    }),
    tasks: tasks.filter((t) => t.project === p),
  };
};

/** Réponse de GET /api/share/<token> (backend/src/sessionShares/route.ts) pour le lien de démo ; null sinon (404). */
export function demoSharedSession(token) {
  if (token !== DEMO_SHARE_TOKEN) return null;
  const s = S.tarifs;
  const events = s.events().map(({ __typename, ...e }) => (e.type === 'claude.result' ? { ...e, payload: { ...e.payload, total_cost_usd: undefined } } : e));
  return { session: { name: s.name, projectName: s.project.name, ownerName: s.owner?.name ?? null, status: 'running', createdAt: s.createdAt }, expiresAt: inDays(6), truncated: false, events };
}

/** Relevé de consommation cohérent : jours → semaines, parts fixes par projet et par modèle, sessions existantes. */
const usageReport = (a = {}) => {
  const days = a.days ?? 30;
  const projects = a.projectId ? allProjects.filter((p) => p.id === a.projectId) : allProjects;
  const share = { 'p-perso': 0.03, 'p-site': 0.3, 'p-api': 0.42, 'p-mobile': 0.17, 'p-data': 0.08 };
  const k = projects.reduce((n, p) => n + share[p.id], 0);
  const round = (v) => Math.round(v * 100) / 100;
  const byDay = Array.from({ length: days }, (_, i) => {
    const usd = round((4 + 6 * Math.abs(Math.sin(i * 1.7)) + (i % 7 < 5 ? 3 : 0)) * k);
    return { __typename: 'UsageReportDay', day: day(i - days + 1), usd, turns: Math.round(usd * 9) };
  });
  const weeks = new Map();
  for (const d of byDay) {
    const dt = new Date(`${d.day}T00:00:00`);
    const monday = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - ((dt.getDay() + 6) % 7));
    const key = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
    const w = weeks.get(key) ?? { __typename: 'UsageReportDay', day: key, usd: 0, turns: 0 };
    w.usd = round(w.usd + d.usd);
    w.turns += d.turns;
    weeks.set(key, w);
  }
  const usd = round(byDay.reduce((n, d) => n + d.usd, 0));
  const turns = byDay.reduce((n, d) => n + d.turns, 0);
  const top = sessions.filter((s) => projects.includes(s.project) && s.costUsd > 0).sort((x, y) => y.costUsd - x.costUsd).slice(0, 15);
  return {
    __typename: 'UsageReport', from: ago(60 * 24 * days), to: new Date().toISOString(), days, usd, turns, sessions: Math.max(top.length, Math.round(turns / 40)),
    byProject: projects.map((p) => ({ __typename: 'UsageReportProject', projectId: p.id, projectName: p.name, isPersonal: p.isPersonal, usd: round((usd * share[p.id]) / k), turns: Math.round((turns * share[p.id]) / k), sessions: Math.max(1, Math.round((turns * share[p.id]) / k / 40)), monthUsd: p.monthUsd, monthlyBudgetUsd: p.monthlyBudgetUsd })).sort((x, y) => y.usd - x.usd),
    byModel: [['claude-opus-5-5', 0.71], ['claude-sonnet-5-5', 0.24], ['claude-haiku-5-5', 0.05]].map(([model, f]) => ({ __typename: 'UsageReportModel', model, usd: round(usd * f), turns: Math.round(turns * f) })),
    byDay,
    byWeek: [...weeks.values()],
    topSessions: top.map((s) => ({ __typename: 'UsageReportSession', sessionId: s.id, sessionName: s.name, projectId: s.project.id, projectName: s.project.name, ownerName: s.owner?.name ?? null, usd: s.costUsd, turns: Math.round(s.costUsd * 9) })),
  };
};

// ---- Journal d'audit (page Journal d'un projet) -----------------------------------------------------------------

const audit = (n, minutes, actorKind, actor, actorLabel, action, actionLabel, targetType, targetTypeLabel, targetId, targetLabel, details = {}, sessionId = null) => ({
  __typename: 'AuditEntry', id: String(1000 - n), createdAt: ago(minutes), action, actionLabel, targetType, targetTypeLabel, targetId, targetLabel, details, actorKind, actor, sessionId, actorLabel,
});
const auditEntries = [
  audit(1, 3, 'HUMAN', U.me, 'Camille Laurent', 'request.answer', 'a répondu à la demande', 'request', 'Demande', 'r-1', 'Autoriser Bash : npm run build ?', { type: 'permission', decision: 'allow', always: true, scope: 'project', rules: ['Bash(npm run build *)'] }),
  audit(2, 12, 'AGENT', U.max, 'Refonte de la page tarifs', 'task.status', 'a changé le statut de la tâche', 'task', 'Tâche', 't-1', 'Refondre la page tarifs', { from: 'todo', to: 'in_progress' }, 's-page-tarifs'),
  audit(3, 25, 'HUMAN', U.hugo, 'Hugo Bernard', 'git.commit', 'a commité', 'git', 'Git', 'w-1', 'page-tarifs (task/page-tarifs)', { message: 'Corrige le comparatif des offres', stageAll: true }),
  audit(4, 26, 'HUMAN', U.hugo, 'Hugo Bernard', 'git.push', 'a poussé', 'git', 'Git', 'w-1', 'page-tarifs (task/page-tarifs)'),
  audit(5, 40, 'HUMAN', U.me, 'Camille Laurent', 'session.stop', 'a arrêté la session', 'session', 'Session', 's-page-tarifs', 'Refonte de la page tarifs'),
  audit(6, 95, 'AGENT', U.chris, 'Cadrage du formulaire de contact', 'task.create', 'a créé la tâche', 'task', 'Tâche', 't-2', 'Formulaire de contact : anti-spam', { status: 'todo', priority: 'medium' }, 's-page-tarifs'),
  audit(7, 60 * 3, 'HUMAN', U.me, 'Camille Laurent', 'member.role', 'a changé le rôle de', 'member', 'Membre', 'u-thomas', 'thomas.petit@toolso.io', { role: 'VIEWER' }),
  audit(8, 60 * 5, 'HUMAN', U.lea, 'Léa Fontaine', 'vault.update', 'a modifié l’élément du coffre', 'vault', 'Coffre', 'v-1', 'base-staging', { fields: ['host', 'password'] }),
  audit(9, 60 * 26, 'SYSTEM', null, null, 'task.status', 'a changé le statut de la tâche', 'task', 'Tâche', 't-3', 'Mettre à jour Astro', { from: 'in_progress', to: 'done' }),
  audit(10, 60 * 30, 'HUMAN', U.me, 'Camille Laurent', 'session.create', 'a lancé la session', 'session', 'Session', 's-page-tarifs', 'Refonte de la page tarifs', { provider: 'claude' }),
];
const auditFacets = {
  __typename: 'AuditFacets',
  actors: [U.me, U.hugo, U.lea, U.max, U.chris],
  targetTypes: [['git', 'Git'], ['member', 'Membre'], ['request', 'Demande'], ['session', 'Session'], ['task', 'Tâche'], ['vault', 'Coffre']].map(([value, label]) => ({ __typename: 'AuditOption', value, label })),
  actions: [['git.commit', 'a commité'], ['git.push', 'a poussé'], ['member.role', 'a changé le rôle de'], ['request.answer', 'a répondu à la demande'], ['session.create', 'a lancé la session'], ['session.stop', 'a arrêté la session'], ['task.create', 'a créé la tâche'], ['task.status', 'a changé le statut de la tâche'], ['vault.update', 'a modifié l’élément du coffre']].map(([value, label]) => ({ __typename: 'AuditOption', value, label })),
};
const auditLog = (a = {}) => {
  const f = a.filter ?? {};
  return auditEntries.filter((e) => (!f.actorKind || e.actorKind === f.actorKind) && (!f.actorUserId || e.actor?.id === f.actorUserId) && (!f.targetType || e.targetType === f.targetType) && (!f.action || e.action === f.action) && (!f.from || e.createdAt >= f.from) && (!f.to || e.createdAt < f.to) && (!a.before || Number(e.id) < Number(a.before)));
};

export const demoRoot = {
  usageReport,
  auditLog,
  auditFacets: () => auditFacets,
  me: U.me,
  users: Object.values(U),
  sidebarProjects: allProjects,
  projects: (a = {}) => (a.includePersonal ? allProjects : teamProjects),
  project: (a) => byId(allProjects, a.id),
  personalSpace: P.perso,
  chats: (a = {}) => chats.slice(0, a.limit ?? 50),
  sessions: (a = {}) =>
    sessions
      .filter((s) => s.kind === (a.kind ?? 'SESSION') && !s.archivedAt && (!a.projectId || s.project.id === a.projectId) && (!a.status || s.status === a.status) && (!a.ownerId || s.owner.id === a.ownerId))
      .slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 100)),
  session: (a) => byId(sessions, a.id),
  archivedSessions: [],
  sessionOwners: () => [U.me, U.hugo, U.lea, U.chris, U.max, U.nora],
  tasks: (a = {}) => filterTasks({ ...a, status: a.status ?? undefined }),
  task: (a) => byId(tasks, a.id),
  conversation: (a) => byId(conversations, a.id),
  conversationBySlug: (a) => conversations.find((c) => c.project.id === a.projectId && c.slug === a.slug) ?? null,
  taskTags: () => [...new Set(tasks.flatMap((t) => t.tags))],
  taskPeople: () => people.map(person),
  requests: (a = {}) => requests.filter((r) => (a.status === null || r.status === (a.status ?? 'PENDING')) && (!a.sessionId || r.session.id === a.sessionId)),
  request: (a) => byId(requests, a.id),
  notifications: (a = {}) => notifications.filter((n) => !a.unreadOnly || !n.readAt).slice(0, a.limit ?? 50),
  unreadNotificationCount: () => notifications.filter((n) => !n.readAt).length,
  dashboard,
  projectDashboard: (a) => projectDashboard(a.id),
  inbox: () => ({
    __typename: 'Inbox', generatedAt: new Date().toISOString(), counts: inboxCounts(), requests: pending(),
    sessions: live().filter((s) => ['FAILED', 'INTERRUPTED'].includes(s.status) || (s.status === 'RUNNING' && s.activity === 'IDLE' && s.owner === U.me)),
    pullRequests: pullRequests.filter((x) => x.stage === 'TO_MERGE'),
  }),
  inboxCounts,
  unreadMessagesByProject: () => teamProjects.map((p) => ({ __typename: 'ProjectUnreadMessages', project: p, count: typeof p.unreadMessages === 'function' ? p.unreadMessages() : 0 })),
  pullRequests: (a = {}) => pullRequests.filter((x) => (!a.projectId || x.project.id === a.projectId) && (!a.taskId || x.task?.id === a.taskId) && (!a.stage || a.stage.includes(x.stage)) && (!a.status || a.status.includes(x.status))),
  pullRequest: (a) => byId(pullRequests, a.id),
  worksession: (a) => sessions.map((s) => s.worksession).find((w) => w?.id === a.id) ?? null,
  vaultItems: (a = {}) => vaultItems.filter((v) => !a.kind || v.kind === a.kind),
  vaultItem: (a) => byId(vaultItems, a.id),
  vaultShareCandidates: [U.hugo, U.lea],
  contextInstruction: (a) => byId(contextInstructions, a.id),
  searchContext: (a) => contextInstructions.filter((i) => i.projectId === a.projectId && `${i.name} ${i.content}`.toLowerCase().includes(a.query.toLowerCase())),
  schedulePermissionSuggestions: (a = {}) => [
    ...(a.sessionId ? [{ __typename: 'ScheduleToolSuggestion', rule: 'mcp__vault__sql_query(production)', source: 'DENIED', count: 2, lastSeenAt: ago(60 * 9) }, { __typename: 'ScheduleToolSuggestion', rule: 'Bash(git log *)', source: 'ASKED', count: 1, lastSeenAt: ago(60 * 24 * 7) }] : []),
    ...(/production/i.test(a.prompt ?? '') ? [{ __typename: 'ScheduleToolSuggestion', rule: 'mcp__vault__sql_query(production)', source: 'PROMPT', count: 0, lastSeenAt: null }] : []),
  ].filter((x, i, all) => all.findIndex((y) => y.rule === x.rule) === i),
  sessionSchedules: (a = {}) => sessions.filter((s) => s.schedule && (!a.projectId || s.project.id === a.projectId)).map((s) => s.schedule),
  providers,
  myAgents: agents,
  agent: (a) => byId(agents, a.id),
  costDisplay: { __typename: 'CostDisplay', unit: 'USD', creditPriceEur: null },
  workflows: [],
  workflowRuns: [],
  sharedPages: [],
  githubPullRequests: [],
  gitStatus,
  gitLog: (a = {}) => (worksessionOf(a.worksessionId) ? commits : commits.slice(2)).slice(0, a.limit ?? 50),
  gitBranches: (a = {}) => {
    const w = worksessionOf(a.worksessionId);
    return [{ name: 'main', current: !w }, ...(w ? [{ name: w.branch, current: true }] : [])].map((b) => ({ __typename: 'GitBranch', remote: false, upstream: `origin/${b.name}`, commit: commits[b.current && w ? 0 : 2], ...b }));
  },
  gitBranchChanges: (a = {}) => {
    const w = worksessionOf(a.worksessionId);
    return { __typename: 'GitBranchChanges', branch: w?.branch ?? 'main', baseBranch: 'main', mergeBase: commits[2].hash, commits: w ? 2 : 0, files: w ? branchFiles : [] };
  },
  sessionChanges: (a) => ({ __typename: 'SessionChanges', mode: 'COMMIT', baseCommit: commits[2].hash, truncated: false, files: a.sessionId === S.tarifs.id ? branchFiles : [] }),
  terminal: null,
  // « Tester » de la carte « Navigateur headless » (réglages du projet) : un contrôle réussi sur skipper-runner arm64.
  testProjectBrowser: (a) => {
    const step = (label, detail, durationMs) => ({ __typename: 'BrowserCheckStep', label, ok: true, detail, durationMs });
    const page = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="100%" height="100%" fill="white"/><text x="40" y="80" font-family="sans-serif" font-size="32" font-weight="bold">Navigateur opérationnel</text><text x="40" y="130" font-family="sans-serif" font-size="20">Page de test de Skipper.</text></svg>';
    return {
      __typename: 'BrowserCheck', ok: true, enabled: Boolean(byId(allProjects, a.id)?.runnerConfig?.browser), image: 'skipper-runner:latest', problems: [], durationMs: 2840,
      screenshot: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(page)}`,
      probe: {
        __typename: 'BrowserProbe', arch: 'aarch64', chromiumVersion: 'Google Chrome for Testing 156.0.7000.0', mcpPath: '/usr/local/bin/playwright-mcp', mcpVersion: 'Version 0.0.84',
        chromiumPath: '/opt/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux-arm64/chrome-headless-shell', browsers: ['chromium-1247', 'chromium_headless_shell-1247', 'ffmpeg-1013'],
        memoryLimitMb: 1536, memoryUsedMb: 612, memoryAvailableMb: 924,
      },
      steps: [
        step('Conteneur du projet', 'image skipper-runner:latest', 40),
        step('Navigateur dans l’image', 'Google Chrome for Testing 156.0.7000.0 · playwright-mcp Version 0.0.84 · aarch64', 910),
        step('Lancement de Chromium', 'port CDP 41233', 520),
        step('Démarrage de playwright-mcp', 'Playwright 1.65.0 · 25 outils', 1010),
        step('Ouverture d’une page locale', 'data:text/html (page de test, sans réseau)', 230),
        step('Capture de la page', '7 Ko', 130),
      ],
    };
  },
};

// ---- Valeurs générées pour les champs absents ---------------------------------------------------------------------

const WORDS = ['Préparation', 'Synthèse', 'Vérification', 'Mise à jour', 'Revue', 'Suivi'];
const FALSE_FLAGS = /^(isPersonal|isSuperAdmin|overThreshold|maintenance|foreignRepo|isDraft|isUsingOverage|pending|browserActive|outdated|advanced|isError|conflicted|truncated|binary)$/;

/** Valeur courte et plausible d'un scalaire absent des données ; undefined : laisser le générateur de l'audit. */
export function demoScalar(type, field, parentType, n) {
  const f = field.toLowerCase();
  switch (type.name) {
    case 'Boolean':
      return FALSE_FLAGS.test(field) ? false : undefined;
    case 'Int':
      if (f.includes('tokens')) return f.includes('window') ? 200_000 : 42_000;
      return f.includes('count') || f.includes('total') ? 4 : f.includes('percent') ? 38 : 2;
    case 'Float':
      return f.includes('cost') || f.includes('usd') ? 0.84 : f.includes('percent') ? 24.5 : 0.4;
    case 'DateTime':
      return ago(n * 37);
    case 'String': {
      if (f === 'email' || f.endsWith('email')) return people[n % people.length].email;
      if (f.includes('avatar')) return null;
      if (f.includes('url') || f.includes('link')) return 'https://github.com/toolso/site-vitrine';
      if (f === 'path' || f.endsWith('path') || f === 'cwd' || f.includes('dir')) return 'src/components/PricingCard.astro';
      if (f.includes('branch')) return 'main';
      if (f.includes('model')) return 'claude-opus-5-5';
      if (f === 'name' || f === 'label' || f === 'title' || f === 'subject') return `${WORDS[n % WORDS.length]} ${(n % 9) + 1}`;
      if (/content|text|body|description|message|summary|markdown|notes/.test(f)) return 'Mise à jour des composants et des tests.';
      if (/prompt|instruction/.test(f)) return 'Prépare la synthèse de la semaine.';
      if (/error|reason|stderr/.test(f)) return null;
      if (/output|stdout|answer|question|command/.test(f)) return 'ok';
      if (f.includes('kind') || f.includes('type') || f.includes('state') || f.includes('status') || f.includes('role')) return 'ok';
      return undefined;
    }
    default:
      return undefined;
  }
}
