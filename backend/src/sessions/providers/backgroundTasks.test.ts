import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundHold, describeBackgroundTasks, reportingBackgroundTasks } from './backgroundTasks.js';

const agent = (id: string, description = `agent ${id}`) => ({ task_id: id, task_type: 'local_agent', description });

describe('reportingBackgroundTasks', () => {
  it('compte les sous-agents et les workflows, pas les commandes Bash ni les tâches ambiantes', () => {
    const tasks = [
      agent('a'),
      { task_id: 'w', task_type: 'local_workflow', description: 'spec' },
      { task_id: 'r', task_type: 'remote_agent', description: 'distant' },
      { task_id: 'b', task_type: 'local_bash', description: 'npm run dev' },
      { task_id: 'm', task_type: 'monitor', description: 'surveillance' },
      { task_id: 'x', task_type: 'local_agent', description: 'technique', ambient: true },
    ];
    expect(reportingBackgroundTasks(tasks).map((t) => t.task_id)).toEqual(['a', 'w', 'r']);
    expect(reportingBackgroundTasks(undefined)).toEqual([]);
  });
});

describe('describeBackgroundTasks', () => {
  it('nomme les sous-agents', () => {
    expect(describeBackgroundTasks([agent('a', 'Check elixis 22 produits')])).toBe('1 sous-agent en arrière-plan (« Check elixis 22 produits »)');
    expect(describeBackgroundTasks([agent('a', 'A'), agent('b', 'B')])).toBe('2 sous-agents en arrière-plan (« A », « B »)');
  });
});

describe('BackgroundHold', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("laisse la session redevenir inactive à la fin d'un tour sans sous-agent", () => {
    const release = vi.fn(async (_notice: string | null) => undefined);
    const hold = new BackgroundHold(release);
    expect(hold.turnEnded()).toEqual({ hold: false, first: false });
    expect(hold.isHolding).toBe(false);
  });

  // Cas du 09/11 (session toolso 06fd9ea2) : tour clos sur « j'attends les sous-agents », puis le CLI ouvre un tour
  // pour chaque compte rendu.
  it("garde la session au travail tant que des sous-agents tournent, jusqu'au tour qui traite leur compte rendu", () => {
    const release = vi.fn(async (_notice: string | null) => undefined);
    const hold = new BackgroundHold(release, { settleMs: 1000 });
    hold.setTasks([agent('a'), agent('b')]);
    expect(hold.turnEnded()).toEqual({ hold: true, first: true });
    hold.setTasks([agent('b')]);
    hold.turnStarted(); // compte rendu du premier : le CLI relance l'agent
    expect(hold.isHolding).toBe(false);
    expect(hold.turnEnded()).toEqual({ hold: true, first: true });
    hold.setTasks([]);
    hold.turnStarted(); // compte rendu du second
    expect(hold.turnEnded()).toEqual({ hold: false, first: false });
    vi.advanceTimersByTime(10_000);
    expect(release).not.toHaveBeenCalled();
  });

  it('ne signale le début de l’attente qu’une fois par tour', () => {
    const hold = new BackgroundHold(async () => undefined);
    hold.setTasks([agent('a')]);
    expect(hold.turnEnded().first).toBe(true);
    expect(hold.turnEnded().first).toBe(false);
  });

  it("rend la session inactive si le CLI n'ouvre aucun tour après le dernier sous-agent", () => {
    const release = vi.fn(async (_notice: string | null) => undefined);
    const hold = new BackgroundHold(release, { settleMs: 1000 });
    hold.setTasks([agent('a')]);
    hold.turnEnded();
    hold.setTasks([]);
    vi.advanceTimersByTime(999);
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(release).toHaveBeenCalledWith(null);
    expect(hold.isHolding).toBe(false);
  });

  it('annule le délai si un tour s’ouvre ou si une nouvelle tâche démarre', () => {
    const release = vi.fn(async (_notice: string | null) => undefined);
    const hold = new BackgroundHold(release, { settleMs: 1000 });
    hold.setTasks([agent('a')]);
    hold.turnEnded();
    hold.setTasks([]);
    hold.setTasks([agent('c')]);
    vi.advanceTimersByTime(5000);
    expect(release).not.toHaveBeenCalled();
    hold.setTasks([]);
    hold.turnStarted();
    vi.advanceTimersByTime(5000);
    expect(release).not.toHaveBeenCalled();
  });

  it("met fin à l'attente au bout de la durée maximale, avec une notice", () => {
    const release = vi.fn(async (_notice: string | null) => undefined);
    const hold = new BackgroundHold(release, { maxMs: 60_000 });
    hold.setTasks([agent('a')]);
    hold.turnEnded();
    vi.advanceTimersByTime(60_000);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0]).toMatch(/après 1 min/);
  });

  it("n'appelle plus rien après la fin de l'exécution", () => {
    const release = vi.fn(async (_notice: string | null) => undefined);
    const hold = new BackgroundHold(release, { settleMs: 1000, maxMs: 2000 });
    hold.setTasks([agent('a')]);
    hold.turnEnded();
    hold.dispose();
    vi.advanceTimersByTime(10_000);
    expect(release).not.toHaveBeenCalled();
  });
});
