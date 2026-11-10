import { useMutation, useQuery } from '@apollo/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Form } from 'react-bootstrap';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { sharedPageUrl } from '../apollo';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import PopMenu, { type MenuItem } from '../components/PopMenu';
import PageComments from '../components/pages/PageComments';
import PageData, { refreshLabel } from '../components/pages/PageData';
import SlidesBar, { useSlides } from '../components/pages/SlidesBar';
import SharePageModal from '../components/pages/SharePageModal';
import FavoriteButton from '../components/pages/FavoriteButton';
import { DELETE_ALL_SHARED_PAGE_COMMENTS, DELETE_SHARED_PAGE, DUPLICATE_SHARED_PAGE, REFRESH_SHARED_PAGE_DATA, REMOVE_SHARED_PAGE_MEMBER, REQUEST_SHARED_PAGE_UPDATE, SET_SHARED_PAGE_HISTORY, SHARED_PAGE, SHARED_PAGE_VERSION_SOURCES, type SharedPageSource, UPDATE_SHARED_PAGE, type SharedPage, type SharedPageAgentHandoff } from '../graphql/misc';
import { useAuth } from '../auth/AuthContext';
import { formatSize } from '../lib/files';
import { timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';
import { ARTIFACT_KINDS, accessLabel } from './SharedPagesPage';

/** « il y a 5 min » → « 5 min » pour la pastille de l'en-tête. */
const timeAgoShort = (iso: string) => timeAgo(iso).replace(/^il y a /, '');

const fmt = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Lecture d'une page partagée dans un bac à sable. En-tête sur une ligne : titre (cliquer déplie les détails :
 * propriétaire, accès, versions, origine), Commentaires, Partager, et un menu « ⋯ » pour le reste (lien, onglet,
 * téléchargement, renommer, supprimer, quitter). Panneau de commentaires : généraux ou ancrés sur un élément de la
 * page (components/pages/PageComments.tsx). Artefact de données : panneau « Données » (components/pages/PageData.tsx)
 * avec le rafraîchissement et l'état des sources ; le cadre est rechargé à chaque rafraîchissement (clé de l'iframe).
 * Diapositives : barre de navigation (components/pages/SlidesBar.tsx) reliée au lecteur injecté dans la page par
 * postMessage, mode présentation en plein écran du cadre, export PDF (`print=1` : la page s'imprime, une diapositive par page).
 *
 * Deux adresses : /shared/<id>, la page à part entière (lien partagé, notifications, personnes qui ne voient pas la
 * session), et /sessions/<session>/pages/<id>, la même page ouverte dans le dossier de la session qui l'a publiée
 * (onglet de la sous-barre). Le lien copié reste toujours /shared/<id>.
 */
export default function SharedPagePage() {
  const { id = '', sessionId } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const focusComment = search.get('comment');
  const { user } = useAuth();
  const { confirm, prompt, alert, showError } = useDialogs();
  const { data, loading, error } = usePollingQuery<{ sharedPage: SharedPage | null }>(SHARED_PAGE, { variables: { id }, pollInterval: 15_000 });
  const page = data?.sharedPage;
  useTabTitle(page?.title ?? 'Page');
  const [pickedVersion, setVersion] = useState<number | null>(null);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(Boolean(focusComment));
  const [dataOpen, setDataOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [details, setDetails] = useState(false);
  const [menuAt, setMenuAt] = useState<{ top: number; right: number } | null>(null);
  // Message du partage, montré à la personne avec qui la page a été partagée jusqu'à ce qu'elle le referme.
  const [hiddenNotes, setHiddenNotes] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('skipper.sharedPage.hiddenNotes') ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  // Ancienne version d'un artefact de données : ses propres sources (chaque version garde leur définition).
  const oldVersion = page && page.historyEnabled && pickedVersion && pickedVersion !== page.version ? pickedVersion : null;
  const oldVersionKind = oldVersion ? page?.versions.find((v) => v.version === oldVersion)?.kind : null;
  const versionSourcesQ = useQuery<{ sharedPage: { id: string; versionSources: SharedPageSource[] } | null }>(SHARED_PAGE_VERSION_SOURCES, { variables: { id, version: oldVersion }, skip: !oldVersion || oldVersionKind !== 'DATA' });
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Même clé que le cadre (recréé à chaque changement) : l'état du lecteur repart avec lui.
  const slides = useSlides(frameRef, page ? `${page.id}:${page.historyEnabled ? pickedVersion : null}:${page.dataRefreshedAt ?? ''}` : '');
  // Mode présentation : plein écran du cadre ; le lecteur est prévenu (un clic avance, pas de marge).
  useEffect(() => {
    const onChange = () => slides.send({ type: 'present', on: document.fullscreenElement === frameRef.current });
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [slides]);
  const openComments_ = useCallback(() => {
    setCommentsOpen(true);
    setDataOpen(false);
  }, []);
  // Le lien d'une notification (?comment=) ouvre le panneau sur le commentaire ; le paramètre est ensuite retiré.
  useEffect(() => {
    if (focusComment) setCommentsOpen(true);
  }, [focusComment]);
  const [update] = useMutation(UPDATE_SHARED_PAGE, { refetchQueries: ['SharedPage', 'SharedPages'], onError: (e) => void showError(e) });
  const [remove] = useMutation(DELETE_SHARED_PAGE, { refetchQueries: ['SharedPages', 'Sidebar'], onError: (e) => void showError(e) });
  const [leave] = useMutation(REMOVE_SHARED_PAGE_MEMBER, { refetchQueries: ['SharedPages', 'Sidebar'], onError: (e) => void showError(e) });
  const [setHistory] = useMutation(SET_SHARED_PAGE_HISTORY, { refetchQueries: ['SharedPage'], onError: (e) => void showError(e) });
  const [purgeComments] = useMutation<{ deleteAllSharedPageComments: number }>(DELETE_ALL_SHARED_PAGE_COMMENTS, { refetchQueries: ['SharedPage', 'SharedPageComments', 'SharedPages'], onError: (e) => void showError(e) });
  const [requestUpdate] = useMutation<{ requestSharedPageUpdate: { id: string; name: string } }>(REQUEST_SHARED_PAGE_UPDATE, { onError: (e) => void showError(e) });
  const [duplicate] = useMutation<{ duplicateSharedPage: { id: string; title: string } }>(DUPLICATE_SHARED_PAGE, { refetchQueries: ['SharedPages', 'Sidebar'], onError: (e) => void showError(e) });
  const [refreshData, { loading: refreshing }] = useMutation(REFRESH_SHARED_PAGE_DATA, { refetchQueries: ['SharedPage', 'SharedPages'], onError: (e) => void showError(e) });

  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger" className="m-3">Erreur : {error.message}</Alert>;
  if (!page) return <Alert variant="warning" className="m-3">Cette page n'existe pas, ou elle ne vous a pas été partagée. Demandez à son propriétaire de la partager avec vous.</Alert>;
  const owner = page.viewerAccess.owner;
  // Propriétaire ou administrateur de Skipper : historique et suppression de tous les commentaires.
  const admin = page.viewerAccess.admin;
  // Historique désactivé : seule la dernière version (le serveur refuse aussi les autres).
  const version = page.historyEnabled ? pickedVersion : null;
  const shown = version ?? page.version;
  const shownVersion = page.versions.find((v) => v.version === shown);
  const viewUrl = sharedPageUrl(page.id, version);
  const access = accessLabel(page);
  const shared = page.linkAccess || page.members.length > 0;
  const openComments = page.openComments;
  const link = `${window.location.origin}/shared/${page.id}`;
  // Artefact de données : sources en défaut (pastille du bouton « Données »), rechargement du cadre après un rafraîchissement.
  // Chaque version garde son type, son rafraîchissement et ses sources : l'affichage suit la version montrée.
  const shownKind = shownVersion?.kind ?? page.kind;
  const isData = shownKind === 'DATA';
  const kindDef = ARTIFACT_KINDS[shownKind] ?? ARTIFACT_KINDS.PAGE;
  const dataPage = oldVersion ? { ...page, sources: versionSourcesQ.data?.sharedPage?.versionSources ?? [], refreshMinutes: shownVersion?.refreshMinutes ?? null } : page;
  const failingSources = isData ? dataPage.sources.filter((s) => s.status === 'error' || s.status === 'skipped').length : 0;
  const frameKey = `${page.id}:${shown}:${page.dataRefreshedAt ?? ''}`;
  const isSlides = shownKind === 'SLIDES';
  const present = () => {
    const frame = frameRef.current;
    if (!frame) return;
    void frame.requestFullscreen?.().then(() => {
      slides.send({ type: 'present', on: true });
      slides.send({ type: 'focus' });
    });
  };
  const toggleComments = () => {
    setCommentsOpen((o) => !o);
    setDataOpen(false);
  };
  const toggleData = () => {
    setDataOpen((o) => !o);
    setCommentsOpen(false);
    setPicking(false);
  };
  const mine = page.members.find((m) => m.user.id === user?.id && m.message);
  const noteKey = mine ? `${page.id}:${mine.message!.length}:${mine.message!.slice(0, 40)}` : null;
  const note = mine && noteKey && !hiddenNotes.includes(noteKey) ? mine : null;
  const hideNote = () => {
    if (!noteKey) return;
    const next = [...hiddenNotes.filter((k) => !k.startsWith(`${page.id}:`)), noteKey].slice(-200);
    setHiddenNotes(next);
    localStorage.setItem('skipper.sharedPage.hiddenNotes', JSON.stringify(next));
  };
  // Renvoi à la session qui a publié la page (propriétaire) : les commentaires à traiter, et/ou une demande libre.
  // Réglage par page (propriétaire) : désactivé, sur demande, ou automatique (chaque commentaire part à la session).
  const hasAgent = owner && Boolean(page.session);
  const canSendToAgent = hasAgent && page.agentHandoff !== 'OFF';
  const setHandoff = (mode: SharedPageAgentHandoff) => void update({ variables: { id: page.id, input: { agentHandoff: mode } } });
  const sendToAgent = async (instruction: string | null) => {
    const res = await requestUpdate({ variables: { id: page.id, instruction, withComments: true } });
    const session = res.data?.requestSharedPageUpdate;
    if (!session) return;
    await alert({
      title: "Instruction envoyée à l'agent",
      message: (
        <>
          La session <Link to={`/sessions/${session.id}`}>{session.name}</Link> met la page à jour : elle publiera une nouvelle version et marquera les commentaires pris en compte comme traités. Cette page se rafraîchit toute seule.
        </>
      ),
      closeLabel: 'Fermer',
    });
  };
  const askUpdate = async () => {
    const instruction = await prompt({
      title: "Demander une mise à jour à l'agent",
      message: openComments > 0 ? `Les ${openComments} commentaire${openComments > 1 ? 's' : ''} à traiter ser${openComments > 1 ? 'ont' : 'a'} joint${openComments > 1 ? 's' : ''} à la demande. Précisez ce qu'il faut changer (facultatif).` : 'Que faut-il changer dans la page ?',
      placeholder: 'Ex. « mets les chiffres de novembre à jour », « ajoute un graphique par client »…',
      confirmLabel: 'Envoyer',
      required: openComments === 0,
    });
    if (instruction === null) return;
    await sendToAgent(instruction || null);
  };
  const sendComments = async () => {
    if (await confirm({ title: "Transmettre les commentaires à l'agent", message: `Envoyer les ${openComments} commentaire${openComments > 1 ? 's' : ''} à traiter à la session « ${page.session?.name} » ? L'agent mettra la page à jour, publiera une nouvelle version et marquera les commentaires traités.`, confirmLabel: 'Envoyer' })) await sendToAgent(null);
  };
  const menu: MenuItem[] = [
    {
      label: copied ? 'Lien copié' : 'Copier le lien',
      icon: copied ? 'bi-check2' : 'bi-link-45deg',
      onClick: () => {
        void navigator.clipboard?.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
    },
    { label: 'Ouvrir dans un onglet', icon: 'bi-box-arrow-up-right', onClick: () => void window.open(viewUrl, '_blank', 'noopener') },
    ...(isSlides ? [{ label: 'Exporter en PDF', icon: 'bi-file-earmark-pdf', onClick: () => void window.open(`${viewUrl}${viewUrl.includes('?') ? '&' : '?'}print=1`, '_blank', 'noopener') }] : []),
    { label: 'Télécharger le HTML', icon: 'bi-download', onClick: () => void window.open(sharedPageUrl(page.id, version, true), '_self') },
    // Copie privée (sources de données comprises) ; un artefact de données seulement par qui en voit les requêtes.
    ...(!user?.isGuest && (shownKind !== 'DATA' || admin)
      ? [
          {
            label: 'Dupliquer',
            icon: 'bi-copy',
            onClick: async () => {
              const title = await prompt({
                title: shownKind === 'DATA' ? "Dupliquer l'artefact de données" : 'Dupliquer la page',
                message: `Une copie privée${version && version !== page.version ? ` de la version ${version}` : ''}, à votre nom${shownKind === 'DATA' ? ', avec ses sources de données' : ''} ; ni les personnes avec qui elle est partagée, ni les commentaires, ni l'historique ne suivent.`,
                defaultValue: `Copie de ${page.title}`,
                confirmLabel: 'Dupliquer',
              });
              if (title === null) return;
              const res = await duplicate({ variables: { id: page.id, title: title.trim() || null, version } });
              const copy = res.data?.duplicateSharedPage;
              if (copy) navigate(`/shared/${copy.id}`);
            },
          },
        ]
      : []),
    ...(canSendToAgent ? [{ label: "Demander une mise à jour à l'agent", icon: 'bi-robot', separatorBefore: true, onClick: () => void askUpdate() }] : []),
    ...(admin
      ? [
          {
            label: page.historyEnabled ? "Désactiver l'historique" : "Réactiver l'historique",
            icon: 'bi-clock-history',
            separatorBefore: true,
            onClick: async () => {
              if (page.historyEnabled) {
                const ok = await confirm({
                  title: "Désactiver l'historique",
                  message: `Les anciennes versions de « ${page.title} » ne seront plus consultables par personne : seule la dernière version restera visible. Elles ne sont pas supprimées et réapparaîtront si l'historique est réactivé.`,
                  confirmLabel: 'Désactiver',
                });
                if (!ok) return;
                setVersion(null);
              }
              await setHistory({ variables: { id: page.id, enabled: !page.historyEnabled } });
            },
          },
          {
            label: 'Supprimer tous les commentaires',
            icon: 'bi-chat-square-text',
            danger: true,
            onClick: async () => {
              const total = page.openComments;
              const ok = await confirm({
                title: 'Supprimer tous les commentaires',
                message: `Supprimer tous les commentaires de « ${page.title} », traités ou non, avec leurs réponses${total > 0 ? ` (dont ${total} à traiter)` : ''} ? Cette action est définitive.`,
                confirmLabel: 'Tout supprimer',
                danger: true,
              });
              if (!ok) return;
              const res = await purgeComments({ variables: { id: page.id } });
              const n = res.data?.deleteAllSharedPageComments;
              if (n != null) await alert({ title: 'Commentaires supprimés', message: n === 0 ? "La page n'avait aucun commentaire." : `${n} fil${n > 1 ? 's' : ''} de commentaires supprimé${n > 1 ? 's' : ''}.`, closeLabel: 'Fermer' });
            },
          },
        ]
      : []),
    ...(owner
      ? [
          {
            label: 'Renommer',
            icon: 'bi-pencil',
            separatorBefore: true,
            onClick: async () => {
              const title = await prompt({ title: 'Renommer la page', defaultValue: page.title, confirmLabel: 'Renommer' });
              if (title && title.trim() && title.trim() !== page.title) update({ variables: { id: page.id, input: { title: title.trim() } } });
            },
          },
          {
            label: 'Supprimer la page',
            icon: 'bi-trash',
            danger: true,
            onClick: async () => {
              if (await confirm({ title: 'Supprimer la page', message: `Supprimer « ${page.title} » et ses ${page.versions.length} version${page.versions.length > 1 ? 's' : ''} ?${shared ? ' Le lien cessera de fonctionner pour toutes les personnes avec qui elle est partagée.' : ''}`, confirmLabel: 'Supprimer', danger: true })) {
                await remove({ variables: { id: page.id } });
                navigate(sessionId ? `/sessions/${sessionId}` : '/shared');
              }
            },
          },
        ]
      : []),
    ...(!owner && page.viewerAccess.member
      ? [
          {
            label: 'Quitter la page',
            icon: 'bi-box-arrow-left',
            separatorBefore: true,
            onClick: async () => {
              if (await confirm({ title: 'Quitter la page', message: `Ne plus voir cette page de ${page.owner.name} ?${page.linkAccess ? ' Le lien restera ouvert à toute personne de Skipper.' : ''}`, confirmLabel: 'Quitter' })) {
                await leave({ variables: { id: page.id, userId: user?.id } });
                navigate(sessionId ? `/sessions/${sessionId}` : '/shared');
              }
            },
          },
        ]
      : []),
  ];
  return (
    <div className="preview-page">
      <div className="sp-head">
        <button type="button" className={`sp-head-title${details ? ' open' : ''}`} onClick={() => setDetails((d) => !d)} title={details ? 'Masquer les détails' : 'Détails de la page (propriétaire, versions, origine)'} aria-expanded={details}>
          <i className={`bi ${shownKind !== 'PAGE' ? kindDef.icon : access.icon} sp-head-access`} title={shownKind !== 'PAGE' ? `${kindDef.label} · ${access.text}` : access.text} />
          <span className="sp-head-name">{page.title}</span>
          {isData && page.dataRefreshedAt && <span className="sp-chip d-none d-md-inline" title={`Données rafraîchies ${new Date(page.dataRefreshedAt).toLocaleString()} · ${refreshLabel(page.refreshMinutes)}`}>{timeAgoShort(page.dataRefreshedAt)}</span>}
          {shown !== page.version && <span className="sp-chip">v{shown}</span>}
          <i className={`bi bi-chevron-${details ? 'up' : 'down'} sp-head-chevron`} />
        </button>
        <div className="sp-head-actions">
          <FavoriteButton page={page} className="sp-btn sp-fav" />
          {isData && admin && (
            <button type="button" className="sp-btn" onClick={() => void refreshData({ variables: { id: page.id } })} disabled={refreshing || !page.sources.length} title="Rafraîchir les données maintenant" aria-label="Rafraîchir les données">
              <i className={`bi bi-arrow-repeat${refreshing ? ' spin' : ''}`} />
              <span className="sp-btn-label">{refreshing ? 'En cours…' : 'Rafraîchir'}</span>
            </button>
          )}
          {isData && (
            <button type="button" className={`sp-btn${dataOpen ? ' on' : ''}`} onClick={toggleData} title={dataOpen ? 'Masquer les données' : 'Données : sources, rafraîchissement et état'} aria-pressed={dataOpen}>
              <i className="bi bi-bar-chart-line" />
              <span className="sp-btn-label">Données</span>
              {failingSources > 0 && <span className="pc-count">{failingSources}</span>}
            </button>
          )}
          <button type="button" className={`sp-btn${commentsOpen ? ' on' : ''}`} onClick={toggleComments} title={commentsOpen ? 'Masquer les commentaires' : 'Commentaires : remarques générales ou sur un endroit précis de la page'} aria-pressed={commentsOpen}>
            <i className="bi bi-chat-left-text" />
            <span className="sp-btn-label">Commentaires</span>
            {openComments > 0 && <span className="pc-count">{openComments}</span>}
          </button>
          {owner && (
            <button type="button" className="sp-btn primary" onClick={() => setSharing(true)} title="Partager la page">
              <i className="bi bi-people" />
              <span className="sp-btn-label">Partager</span>
            </button>
          )}
          <button
            type="button"
            className="sp-btn"
            title="Plus d'actions"
            aria-label="Plus d'actions"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setMenuAt({ top: r.bottom + 4, right: window.innerWidth - r.right });
            }}
          >
            <i className="bi bi-three-dots" />
          </button>
          {menuAt && <PopMenu items={menu} onClose={() => setMenuAt(null)} at={menuAt} />}
        </div>
      </div>
      {details && (
        <div className="sp-details">
          <span>
            <i className="bi bi-person" /> {owner ? 'À vous' : `Par ${page.owner.name}`}
          </span>
          <span>
            <i className={`bi ${access.icon}`} /> {access.text}
          </span>
          {isData && (
            <span title="Artefact de données : la page lit ses chiffres dans des sources rafraîchies par Skipper">
              <i className={`bi ${kindDef.icon}`} /> {kindDef.label} · {page.dataRefreshedAt ? `mis à jour ${timeAgo(page.dataRefreshedAt)}` : 'pas encore rafraîchi'} · {refreshLabel(dataPage.refreshMinutes)}
            </span>
          )}
          {!page.historyEnabled && (
            <span title="Seule la dernière version est consultable">
              <i className="bi bi-eye-slash" /> Historique désactivé
            </span>
          )}
          {page.versions.length > 1 ? (
            <span>
              <i className="bi bi-clock-history" />{' '}
              <Form.Select size="sm" className="d-inline-block w-auto py-0 sp-version" value={version ?? ''} onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : null)} aria-label="Version affichée">
                <option value="">Dernière version (v{page.version})</option>
                {page.versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version} · {fmt(v.createdAt)}
                    {v.kind !== page.kind ? ` · ${ARTIFACT_KINDS[v.kind]?.label ?? v.kind}` : ''}
                    {v.kind === 'DATA' && v.sourceCount != null ? ` · ${v.sourceCount} source${v.sourceCount > 1 ? 's' : ''}` : ''}
                  </option>
                ))}
              </Form.Select>
            </span>
          ) : (
            shownVersion && (
              <span>
                <i className="bi bi-clock-history" /> Publiée {fmt(shownVersion.createdAt)}
              </span>
            )
          )}
          {shownVersion && page.versions.length > 1 && <span>Mise à jour {fmt(shownVersion.createdAt)}</span>}
          {shownVersion && <span>{formatSize(shownVersion.size)}</span>}
          {owner && page.session && (
            <span>
              <i className="bi bi-robot" /> Depuis{' '}
              <Link to={`/sessions/${page.session.id}`} title={page.sourcePath ?? undefined}>
                {page.session.name}
              </Link>
            </span>
          )}
          {owner && !page.session && page.project && (
            <span>
              <i className="bi bi-folder" /> Depuis {page.project.name}
            </span>
          )}
        </div>
      )}
      {note && (
        <div className="sp-note" role="note">
          <i className="bi bi-chat-quote" />
          <div className="sp-note-body">
            <div className="sp-note-from">{note.addedBy?.name ?? page.owner.name} vous a partagé cette page :</div>
            <div className="sp-note-text">{note.message}</div>
          </div>
          <button type="button" className="sp-note-close" onClick={hideNote} title="Masquer le message" aria-label="Masquer le message">
            <i className="bi bi-x-lg" />
          </button>
        </div>
      )}
      {picking && (
        <div className="sp-pickbar">
          <i className="bi bi-cursor" /> Cliquez sur l'élément de la page à commenter (Échap pour annuler).
          <button type="button" className="cc-btn ms-auto" onClick={() => setPicking(false)}>
            Annuler
          </button>
        </div>
      )}
      {isSlides && <SlidesBar state={slides.state} silent={slides.silent} send={slides.send} onPresent={present} />}
      <div className={`sp-body${commentsOpen ? ' with-comments' : ''}${dataOpen ? ' with-data' : ''}${picking ? ' picking' : ''}`}>
        <iframe ref={frameRef} key={frameKey} className="preview-frame" title={page.title} src={viewUrl} sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads" allow="clipboard-write; fullscreen" />
        <PageComments
          page={page}
          version={shown}
          frameRef={frameRef}
          picking={picking}
          setPicking={setPicking}
          initialFocus={focusComment}
          open={commentsOpen}
          onOpen={openComments_}
          agent={hasAgent && page.session ? { sessionName: page.session.name, onSetMode: setHandoff, onSend: sendComments } : undefined}
          onClose={() => {
            setCommentsOpen(false);
            setPicking(false);
            if (focusComment) setSearch({}, { replace: true });
          }}
        />
        {isData && dataOpen && (
          <PageData
            page={dataPage}
            oldVersion={oldVersion}
            manage={admin}
            refreshing={refreshing}
            onRefresh={() => void refreshData({ variables: { id: page.id } })}
            onSetRefresh={(minutes) => void update({ variables: { id: page.id, input: { refreshMinutes: minutes } } })}
            onAskAgent={canSendToAgent ? () => void askUpdate() : undefined}
            onClose={() => setDataOpen(false)}
          />
        )}
      </div>
      {sharing && <SharePageModal page={page} onClose={() => setSharing(false)} />}
    </div>
  );
}
