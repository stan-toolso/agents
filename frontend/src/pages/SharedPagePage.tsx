import { useMutation } from '@apollo/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Form } from 'react-bootstrap';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { sharedPageUrl } from '../apollo';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import PopMenu, { type MenuItem } from '../components/PopMenu';
import PageComments from '../components/pages/PageComments';
import SharePageModal from '../components/pages/SharePageModal';
import { DELETE_SHARED_PAGE, REMOVE_SHARED_PAGE_MEMBER, REQUEST_SHARED_PAGE_UPDATE, SHARED_PAGE, UPDATE_SHARED_PAGE, type SharedPage } from '../graphql/misc';
import { useAuth } from '../auth/AuthContext';
import { formatSize } from '../lib/files';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';
import { accessLabel } from './SharedPagesPage';

const fmt = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Lecture d'une page partagée dans un bac à sable. En-tête sur une ligne : titre (cliquer déplie les détails :
 * propriétaire, accès, versions, origine), Commentaires, Partager, et un menu « ⋯ » pour le reste (lien, onglet,
 * téléchargement, renommer, supprimer, quitter). Panneau de commentaires : généraux ou ancrés sur un élément de la
 * page (components/pages/PageComments.tsx).
 */
export default function SharedPagePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const focusComment = search.get('comment');
  const { user } = useAuth();
  const { confirm, prompt, alert, showError } = useDialogs();
  const { data, loading, error } = usePollingQuery<{ sharedPage: SharedPage | null }>(SHARED_PAGE, { variables: { id }, pollInterval: 15_000 });
  const page = data?.sharedPage;
  useTabTitle(page?.title ?? 'Page');
  const [version, setVersion] = useState<number | null>(null);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(Boolean(focusComment));
  const [picking, setPicking] = useState(false);
  const [details, setDetails] = useState(false);
  const [menuAt, setMenuAt] = useState<{ top: number; right: number } | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const openComments_ = useCallback(() => setCommentsOpen(true), []);
  // Le lien d'une notification (?comment=) ouvre le panneau sur le commentaire ; le paramètre est ensuite retiré.
  useEffect(() => {
    if (focusComment) setCommentsOpen(true);
  }, [focusComment]);
  const [update] = useMutation(UPDATE_SHARED_PAGE, { refetchQueries: ['SharedPage', 'SharedPages'], onError: (e) => void showError(e) });
  const [remove] = useMutation(DELETE_SHARED_PAGE, { refetchQueries: ['SharedPages'], onError: (e) => void showError(e) });
  const [leave] = useMutation(REMOVE_SHARED_PAGE_MEMBER, { refetchQueries: ['SharedPages'], onError: (e) => void showError(e) });
  const [requestUpdate] = useMutation<{ requestSharedPageUpdate: { id: string; name: string } }>(REQUEST_SHARED_PAGE_UPDATE, { onError: (e) => void showError(e) });

  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger" className="m-3">Erreur : {error.message}</Alert>;
  if (!page) return <Alert variant="warning" className="m-3">Cette page n'existe pas, ou elle ne vous a pas été partagée. Demandez à son propriétaire de la partager avec vous.</Alert>;
  const owner = page.viewerAccess.owner;
  const shown = version ?? page.version;
  const shownVersion = page.versions.find((v) => v.version === shown);
  const viewUrl = sharedPageUrl(page.id, version);
  const access = accessLabel(page);
  const shared = page.linkAccess || page.members.length > 0;
  const openComments = page.openComments;
  const link = `${window.location.origin}/shared/${page.id}`;
  // Renvoi à la session qui a publié la page (propriétaire) : les commentaires à traiter, et/ou une demande libre.
  const canSendToAgent = owner && Boolean(page.session);
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
    { label: 'Télécharger le HTML', icon: 'bi-download', onClick: () => void window.open(sharedPageUrl(page.id, version, true), '_self') },
    ...(canSendToAgent ? [{ label: "Demander une mise à jour à l'agent", icon: 'bi-robot', separatorBefore: true, onClick: () => void askUpdate() }] : []),
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
                navigate('/shared');
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
                navigate('/shared');
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
          <i className={`bi ${access.icon} sp-head-access`} title={access.text} />
          <span className="sp-head-name">{page.title}</span>
          {shown !== page.version && <span className="sp-chip">v{shown}</span>}
          <i className={`bi bi-chevron-${details ? 'up' : 'down'} sp-head-chevron`} />
        </button>
        <div className="sp-head-actions">
          <button type="button" className={`sp-btn${commentsOpen ? ' on' : ''}`} onClick={() => setCommentsOpen((o) => !o)} title={commentsOpen ? 'Masquer les commentaires' : 'Commentaires : remarques générales ou sur un endroit précis de la page'} aria-pressed={commentsOpen}>
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
          {page.versions.length > 1 ? (
            <span>
              <i className="bi bi-clock-history" />{' '}
              <Form.Select size="sm" className="d-inline-block w-auto py-0 sp-version" value={version ?? ''} onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : null)} aria-label="Version affichée">
                <option value="">Dernière version (v{page.version})</option>
                {page.versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version} · {fmt(v.createdAt)}
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
      {picking && (
        <div className="sp-pickbar">
          <i className="bi bi-cursor" /> Cliquez sur l'élément de la page à commenter (Échap pour annuler).
          <button type="button" className="cc-btn ms-auto" onClick={() => setPicking(false)}>
            Annuler
          </button>
        </div>
      )}
      <div className={`sp-body${commentsOpen ? ' with-comments' : ''}${picking ? ' picking' : ''}`}>
        <iframe ref={frameRef} key={`${page.id}:${shown}`} className="preview-frame" title={page.title} src={viewUrl} sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads" allow="clipboard-write" />
        <PageComments
          page={page}
          version={shown}
          frameRef={frameRef}
          picking={picking}
          setPicking={setPicking}
          initialFocus={focusComment}
          open={commentsOpen}
          onOpen={openComments_}
          onSendToAgent={canSendToAgent ? sendComments : undefined}
          onClose={() => {
            setCommentsOpen(false);
            setPicking(false);
            if (focusComment) setSearch({}, { replace: true });
          }}
        />
      </div>
      {sharing && <SharePageModal page={page} onClose={() => setSharing(false)} />}
    </div>
  );
}
