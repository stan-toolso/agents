import { useMutation } from '@apollo/client';
import { useCallback, useEffect, useState } from 'react';
import { useDialogs } from '../components/Dialogs';
import { COCKPIT_LAYOUT, RESET_COCKPIT_LAYOUT, RESTORE_COCKPIT_LAYOUT, UPDATE_COCKPIT_LAYOUT, type CockpitLayoutData } from '../graphql/cockpit';
import { usePollingQuery } from '../lib/usePollingQuery';
import { sameLayout, type Layout, type WidgetDef } from './types';

/**
 * Agencement d'une portée du cockpit et son mode « Personnaliser » : l'agencement affiché est le brouillon pendant
 * l'édition, sinon celui du serveur (relu toutes les 30 s : un agent ou un autre membre a pu le changer). Rien n'est
 * enregistré avant « Enregistrer ».
 */
export interface CockpitState {
  data: CockpitLayoutData | null;
  layout: Layout | null;
  catalog: WidgetDef[];
  canEdit: boolean;
  editing: boolean;
  dirty: boolean;
  saving: boolean;
  startEdit: () => void;
  cancel: () => void;
  setDraft: (layout: Layout) => void;
  save: (note?: string | null) => Promise<void>;
  reset: () => Promise<void>;
  restore: (version: number) => Promise<void>;
  /** Version vue par la personne la dernière fois (pour signaler un changement fait ailleurs). */
  changedElsewhere: CockpitLayoutData | null;
  acknowledge: () => void;
  /** Avertissements du dernier enregistrement (artefact invisible pour l'équipe…). */
  warnings: string[];
  clearWarnings: () => void;
}

const EMPTY: WidgetDef[] = [];

export function useCockpit(scope: string | null): CockpitState {
  const { showError, confirm } = useDialogs();
  const { data } = usePollingQuery<{ cockpitLayout: CockpitLayoutData }>(COCKPIT_LAYOUT, { variables: { scope: scope ?? '' }, skip: !scope, pollInterval: 30_000, fetchPolicy: 'cache-and-network' });
  const current = data?.cockpitLayout ?? null;
  const [draft, setDraftState] = useState<Layout | null>(null);
  const [editing, setEditing] = useState(false);
  const [seenVersion, setSeenVersion] = useState<number | null>(null);
  const [changedElsewhere, setChangedElsewhere] = useState<CockpitLayoutData | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [update, { loading: saving }] = useMutation<{ updateCockpitLayout: CockpitLayoutData }>(UPDATE_COCKPIT_LAYOUT);
  const [resetMutation] = useMutation<{ resetCockpitLayout: CockpitLayoutData }>(RESET_COCKPIT_LAYOUT);
  const [restoreMutation] = useMutation<{ restoreCockpitLayout: CockpitLayoutData }>(RESTORE_COCKPIT_LAYOUT);

  // Changement fait ailleurs (agent, autre membre) pendant qu'on regarde : signalé, pas imposé en cours d'édition.
  useEffect(() => {
    if (!current) return;
    if (seenVersion === null) {
      setSeenVersion(current.version);
      return;
    }
    if (current.version !== seenVersion) {
      setSeenVersion(current.version);
      if (current.updatedBy) setChangedElsewhere(current);
    }
  }, [current, seenVersion]);
  useEffect(() => {
    setSeenVersion(null);
    setChangedElsewhere(null);
    setEditing(false);
    setDraftState(null);
  }, [scope]);

  const startEdit = useCallback(() => {
    if (!current) return;
    setDraftState(current.layout);
    setEditing(true);
    setChangedElsewhere(null);
  }, [current]);
  const cancel = useCallback(() => {
    setEditing(false);
    setDraftState(null);
  }, []);
  const save = useCallback(
    async (note?: string | null) => {
      if (!scope || !draft) return;
      try {
        const res = await update({ variables: { scope, layout: draft, note: note ?? null } });
        const saved = res.data?.updateCockpitLayout;
        if (saved) {
          setSeenVersion(saved.version);
          setWarnings(saved.warnings ?? []);
        }
        setEditing(false);
        setDraftState(null);
      } catch (err) {
        await showError(err);
      }
    },
    [scope, draft, update, showError],
  );
  const reset = useCallback(async () => {
    if (!scope) return;
    if (!(await confirm({ title: 'Réinitialiser le tableau de bord', message: 'Revenir à l’agencement par défaut de Skipper ? Les versions précédentes restent dans l’historique.', confirmLabel: 'Réinitialiser' }))) return;
    try {
      const res = await resetMutation({ variables: { scope } });
      const saved = res.data?.resetCockpitLayout;
      if (saved) setSeenVersion(saved.version);
      setEditing(false);
      setDraftState(null);
    } catch (err) {
      await showError(err);
    }
  }, [scope, confirm, resetMutation, showError]);
  const restore = useCallback(
    async (version: number) => {
      if (!scope) return;
      try {
        const res = await restoreMutation({ variables: { scope, version } });
        const saved = res.data?.restoreCockpitLayout;
        if (saved) setSeenVersion(saved.version);
        setEditing(false);
        setDraftState(null);
      } catch (err) {
        await showError(err);
      }
    },
    [scope, restoreMutation, showError],
  );

  return {
    data: current,
    layout: editing && draft ? draft : current?.layout ?? null,
    catalog: current?.catalog ?? EMPTY,
    canEdit: Boolean(current?.canEdit),
    editing,
    dirty: Boolean(editing && draft && current && !sameLayout(draft, current.layout)),
    saving,
    startEdit,
    cancel,
    setDraft: setDraftState,
    save,
    reset,
    restore,
    changedElsewhere,
    acknowledge: () => setChangedElsewhere(null),
    warnings,
    clearWarnings: () => setWarnings([]),
  };
}
