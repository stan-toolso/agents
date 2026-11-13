import { AppError } from '../errors.js';
import { log } from '../log.js';
import { notificationService } from '../notifications/service.js';
import { projectService } from '../projects/service.js';
import type { Project } from '../projects/types.js';
import { userService } from '../users/service.js';
import { alertRepository } from './alertRepository.js';
import { ALERT_LIMITS, alertInstruction, describeCondition, evaluateAlert, nextAlertState, parseAlerts, shortValue, type AlertEvaluation, type AlertInput, type DataAlert } from './alerts.js';
import { dataSourceRepository } from './dataRepository.js';
import { launchArtifactSession, sessionBusy } from './launch.js';
import { sharedPageRepository } from './repository.js';
import type { SharedPage } from './types.js';

/** Lien de l'artefact dans l'application (la notification le rend absolu pour les canaux). */
const pageLink = (page: Pick<SharedPage, 'id'>) => `/shared/${page.id}`;

/** Le propriétaire peut-il encore faire tourner quelque chose dans le projet (membre, ou admin de Skipper) ? */
async function ownerActive(page: SharedPage, project: Project): Promise<boolean> {
  if ((await userService.memberRoleFor(page.ownerId, project.id)) !== null) return true;
  return Boolean((await userService.get(page.ownerId).catch(() => null))?.isAdmin);
}

async function notify(page: SharedPage, alert: DataAlert, ev: AlertEvaluation, event: 'triggered' | 'resolved'): Promise<void> {
  const c = alert.config;
  if (c.notify === 'none' || (event === 'resolved' && !c.notifyResolved)) return;
  const target = c.notify === 'project' && page.projectId ? { projectId: page.projectId } : { userId: page.ownerId, projectId: page.projectId };
  const value = ev.value !== undefined && ev.value !== null ? ` — valeur ${shortValue(ev.value, 160)}` : '';
  await notificationService.notify({
    type: event === 'triggered' ? 'page.alert' : 'page.alert_resolved',
    title: event === 'triggered' ? `Alerte « ${alert.name} » · ${page.title}` : `Alerte « ${alert.name} » revenue à la normale · ${page.title}`,
    message: `${c.message ? `${c.message} · ` : ''}${describeCondition(alert)}${value}`,
    link: pageLink(page),
    ...target,
    payload: { pageId: page.id, alert: alert.name, event },
  });
}

/**
 * Session lancée au déclenchement (consigne de l'alerte, ou agent convoqué). Jamais plus d'une par alerte et par heure,
 * jamais tant que la précédente travaille : une session qui ferait rebasculer l'alerte ne peut pas emballer les coûts.
 * Un refus (budget, identifiants, agent introuvable) est gardé dans `error` de l'alerte, sans lever.
 */
async function launchSession(page: SharedPage, project: Project | null, alert: DataAlert, ev: AlertEvaluation): Promise<void> {
  const c = alert.config;
  if (!c.prompt && !c.agent) return;
  try {
    if (!project) throw new AppError("le projet d'origine de l'artefact n'existe plus");
    if (!(await ownerActive(page, project))) throw new AppError("le propriétaire de l'artefact n'est plus membre du projet");
    if (alert.sessionAt && Date.now() - alert.sessionAt.getTime() < ALERT_LIMITS.sessionCooldownMinutes * 60_000) {
      throw new AppError(`une session a déjà été lancée il y a moins de ${ALERT_LIMITS.sessionCooldownMinutes} minutes`);
    }
    if (alert.sessionId) {
      const { sessionRepository } = await import('../sessions/repository.js');
      if (sessionBusy(await sessionRepository.findById(alert.sessionId))) throw new AppError(`la session ${alert.sessionId} lancée par l'alerte travaille encore`);
    }
    const { config } = await import('../config.js');
    const text = alertInstruction(page, alert, ev, `${config.appUrl}${pageLink(page)}`);
    const sessionId = await launchArtifactSession(page, project, { agent: c.agent, text, name: `Alerte · ${page.title} · ${alert.name}` });
    await alertRepository.markSession(alert.id, sessionId);
    log.info(`[artifacts] alerte ${page.title} · ${alert.name} : session ${sessionId} lancée`);
  } catch (err) {
    const message = `Session non lancée : ${(err as Error).message}`;
    await alertRepository.setError(alert.id, message);
    log.warn(`[artifacts] alerte ${page.title} · ${alert.name} : ${message}`);
  }
}

export const alertService = {
  list: (pageId: string) => alertRepository.list(pageId),

  /** Définit (remplace) les alertes d'un artefact de données, vérifiées contre ses sources actuelles ; fige la version. */
  async setAlerts(page: SharedPage, inputs: AlertInput[]): Promise<DataAlert[]> {
    if (page.kind !== 'data') throw new AppError('Seul un artefact de données porte des alertes');
    const sources = await dataSourceRepository.list(page.id);
    const parsed = parseAlerts(inputs, sources);
    await alertRepository.replace(page.id, parsed);
    await sharedPageRepository.snapshotLatest(page.id);
    return alertRepository.list(page.id);
  },

  /**
   * Évalue les alertes portant sur les sources nommées (état et données après leur rafraîchissement) et
   * exécute les actions des franchissements. Ne lève jamais : une alerte ne doit pas faire échouer un rafraîchissement.
   * Renvoie les alertes qui ont basculé.
   */
  async evaluate(page: SharedPage, sourceNames: string[], project?: Project | null): Promise<{ alert: DataAlert; event: 'triggered' | 'resolved' }[]> {
    const fired: { alert: DataAlert; event: 'triggered' | 'resolved' }[] = [];
    try {
      const alerts = (await alertRepository.list(page.id)).filter((a) => sourceNames.includes(a.source));
      if (!alerts.length) return fired;
      const sources = await dataSourceRepository.list(page.id, true);
      let proj = project;
      for (const alert of alerts) {
        const source = sources.find((s) => s.name === alert.source);
        if (!source) continue;
        const ev = evaluateAlert(alert.config, source, alert.evaluatedAt ? alert.lastValue : undefined);
        const next = nextAlertState(alert, ev.matched, alert.config);
        if (ev.matched === null && !ev.note) continue;
        await alertRepository.saveEvaluation(alert.id, { state: next.state, streak: next.streak, value: ev.matched === null ? alert.lastValue : ev.value, event: next.event, error: ev.note });
        if (!next.event) continue;
        log.info(`[artifacts] alerte ${page.title} · ${alert.name} ${next.event === 'triggered' ? 'déclenchée' : 'revenue à la normale'}`);
        fired.push({ alert: { ...alert, state: next.state }, event: next.event });
        await notify(page, alert, ev, next.event);
        if (next.event === 'triggered' && (alert.config.prompt || alert.config.agent)) {
          if (proj === undefined) proj = page.projectId ? await projectService.get(page.projectId).catch(() => null) : null;
          await launchSession(page, proj, alert, ev);
        }
      }
    } catch (err) {
      log.error(`[artifacts] évaluation des alertes de ${page.title}`, err);
    }
    return fired;
  },
};
