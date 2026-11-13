import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Button, Card, Form, Spinner } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useDialogs } from '../components/Dialogs';
import { WORK_TABS as TABS } from '../components/ProjectHeader';
import { CREATE_PROJECT_PAGE, DELETE_PROJECT_PAGE, PROJECT_TABS, UPDATE_PROJECT_PAGE, UPDATE_PROJECT_TABS, type ProjectPageInfo, type ProjectTabsSetting } from '../graphql/cockpit';

const NEVER_HIDDEN = new Set(['overview']);
const ICONS = ['bi-layout-text-window', 'bi-graph-up', 'bi-bar-chart-line', 'bi-clipboard-data', 'bi-people', 'bi-rocket-takeoff', 'bi-bug', 'bi-globe', 'bi-star', 'bi-journal-richtext', 'bi-kanban', 'bi-megaphone'];
const REFETCH = ['ProjectTabs'];

/**
 * Réglages › « Onglets et pages » : masquer des onglets natifs (sauf le tableau de bord et les réglages), ordonner les
 * onglets (flèches), et gérer les pages personnalisées (créer, renommer, icône, supprimer). Chaque page se compose
 * ensuite sur place avec « Personnaliser » (portée page:<slug>), ou par un agent (outil cockpit).
 */
export default function ProjectTabsCard({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { confirm, prompt, showError } = useDialogs();
  const { data, loading } = useQuery<{ project: { id: string; tabs: ProjectTabsSetting | null; pages: ProjectPageInfo[] } | null }>(PROJECT_TABS, { variables: { id: projectId } });
  const [updateTabs, { loading: savingTabs }] = useMutation(UPDATE_PROJECT_TABS, { refetchQueries: REFETCH });
  const [createPage] = useMutation(CREATE_PROJECT_PAGE, { refetchQueries: REFETCH });
  const [updatePage] = useMutation(UPDATE_PROJECT_PAGE, { refetchQueries: REFETCH });
  const [deletePage] = useMutation(DELETE_PROJECT_PAGE, { refetchQueries: REFETCH });
  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState(ICONS[0]);
  const setting: ProjectTabsSetting = { hidden: data?.project?.tabs?.hidden ?? [], order: data?.project?.tabs?.order ?? [] };
  const pages = [...(data?.project?.pages ?? [])].sort((a, b) => a.position - b.position);
  const hidden = new Set(setting.hidden);
  // L'ordre affiché : les clés citées d'abord, puis le tableau de bord, les pages par position et les autres natifs (comme effectiveTabs).
  const keys = ['overview', ...pages.map((p) => `page:${p.slug}`), ...TABS.filter((t) => t.key !== 'overview').map((t) => t.key as string)];
  const rank = new Map(setting.order.map((k, i) => [k, i]));
  const ordered = [...keys].sort((a, b) => {
    const ra = rank.get(a);
    const rb = rank.get(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return keys.indexOf(a) - keys.indexOf(b);
  });
  const labelOf = (k: string) => (k.startsWith('page:') ? pages.find((p) => `page:${p.slug}` === k)?.title ?? k : TABS.find((t) => t.key === k)?.label ?? k);
  const iconOf = (k: string) => (k.startsWith('page:') ? pages.find((p) => `page:${p.slug}` === k)?.icon ?? 'bi-layout-text-window' : TABS.find((t) => t.key === k)?.icon ?? 'bi-dot');
  const save = (tabs: ProjectTabsSetting) => updateTabs({ variables: { projectId, tabs } }).catch(showError);
  const toggle = (k: string) => save({ ...setting, hidden: hidden.has(k) ? setting.hidden.filter((x) => x !== k) : [...setting.hidden, k] });
  const move = (k: string, dir: -1 | 1) => {
    const i = ordered.indexOf(k);
    const j = i + dir;
    if (j < 0 || j >= ordered.length) return;
    const next = [...ordered];
    [next[i], next[j]] = [next[j], next[i]];
    void save({ ...setting, order: next });
  };
  const add = async () => {
    const t = title.trim();
    if (!t) return;
    try {
      await createPage({ variables: { projectId, title: t, icon } });
      setTitle('');
    } catch (err) {
      await showError(err);
    }
  };
  const rename = async (p: ProjectPageInfo) => {
    const t = await prompt({ title: 'Renommer la page', defaultValue: p.title, confirmLabel: 'Renommer' });
    if (t === null || !t.trim()) return;
    await updatePage({ variables: { id: p.id, title: t.trim() } }).catch(showError);
  };
  const remove = async (p: ProjectPageInfo) => {
    if (await confirm({ title: 'Supprimer la page', message: `Supprimer la page « ${p.title} » et son agencement ? Les artefacts qui y étaient épinglés ne sont pas supprimés.`, confirmLabel: 'Supprimer', danger: true })) await deletePage({ variables: { id: p.id } }).catch(showError);
  };

  return (
    <Card className="mb-3">
      <Card.Body className="small">
        {loading && !data && <Spinner animation="border" size="sm" />}
        <p className="text-secondary">
          Choisissez les onglets du projet : masquez ceux qui lui sont inutiles (un projet sans dépôt n’a que faire de Dépôt, Pull requests et Livraisons), ordonnez-les, et ajoutez des <b>pages personnalisées</b>, affichées juste après le tableau de bord : chacune est un onglet de plus, composé de blocs et d’artefacts avec « Personnaliser » ou par un agent (outil <code>cockpit</code>, portée <code>page:&lt;slug&gt;</code>).
        </p>
        <ul className="list-unstyled ck-tabs-list mb-3">
          {ordered.map((k, i) => {
            const page = k.startsWith('page:') ? pages.find((p) => `page:${p.slug}` === k) : null;
            return (
              <li key={k} className={hidden.has(k) ? 'hidden' : ''}>
                <Form.Check type="switch" id={`tab-${k}`} checked={!hidden.has(k)} disabled={!canManage || NEVER_HIDDEN.has(k) || Boolean(page) || savingTabs} onChange={() => toggle(k)} title={NEVER_HIDDEN.has(k) ? 'Toujours visible' : page ? 'Une page personnalisée se supprime, elle ne se masque pas' : hidden.has(k) ? 'Afficher' : 'Masquer'} />
                <i className={`bi ${iconOf(k)}`} />
                <span className="lbl">
                  {page ? <Link to={`/projects/${projectId}/p/${page.slug}`}>{page.title}</Link> : labelOf(k)}
                  {page && <code className="ms-2 text-secondary">page:{page.slug}</code>}
                </span>
                {canManage && (
                  <span className="ck-tabs-actions">
                    <button type="button" className="btn btn-link btn-sm p-0" title="Monter" disabled={i === 0 || savingTabs} onClick={() => move(k, -1)}><i className="bi bi-arrow-up" /></button>
                    <button type="button" className="btn btn-link btn-sm p-0" title="Descendre" disabled={i === ordered.length - 1 || savingTabs} onClick={() => move(k, 1)}><i className="bi bi-arrow-down" /></button>
                    {page && (
                      <>
                        <button type="button" className="btn btn-link btn-sm p-0" title="Renommer" onClick={() => void rename(page)}><i className="bi bi-pencil" /></button>
                        <button type="button" className="btn btn-link btn-sm p-0 text-danger" title="Supprimer la page" onClick={() => void remove(page)}><i className="bi bi-trash" /></button>
                      </>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {canManage && (
          <Form
            className="d-flex gap-2 align-items-center flex-wrap"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <Form.Control size="sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nouvelle page (ex. Reporting client)" style={{ maxWidth: 280 }} />
            <Form.Select size="sm" value={icon} onChange={(e) => setIcon(e.target.value)} style={{ maxWidth: 200 }} title="Icône de l’onglet">
              {ICONS.map((i) => (
                <option key={i} value={i}>{i.replace(/^bi-/, '')}</option>
              ))}
            </Form.Select>
            <Button type="submit" size="sm" variant="outline-primary" disabled={!title.trim()}>
              <i className="bi bi-plus-lg me-1" />Ajouter la page
            </Button>
          </Form>
        )}
      </Card.Body>
    </Card>
  );
}
