/**
 * Graphe des dépendances entre tâches (« A dépend de B » = arête A → B), sans base : détection des cycles avant
 * d'enregistrer de nouvelles dépendances.
 */

export interface DependencyEdge {
  taskId: string;
  dependsOnId: string;
}

/**
 * Le cycle que formeraient les dépendances `dependsOn` données à `taskId` (les siennes actuelles étant remplacées),
 * sous forme de chemin `taskId → … → taskId` ; null s'il n'y en a pas. Une tâche nouvelle (pas encore en base) ne
 * peut pas former de cycle : personne ne dépend d'elle.
 */
export function dependencyCycle(taskId: string, dependsOn: string[], edges: DependencyEdge[]): string[] | null {
  const next = new Map<string, string[]>();
  for (const e of edges) {
    if (e.taskId === taskId) continue; // remplacées par dependsOn
    next.set(e.taskId, [...(next.get(e.taskId) ?? []), e.dependsOnId]);
  }
  next.set(taskId, [...dependsOn]);
  // Parcours en profondeur depuis taskId, en gardant le chemin pour l'expliquer.
  const seen = new Set<string>();
  const path: string[] = [taskId];
  const visit = (id: string): boolean => {
    for (const dep of next.get(id) ?? []) {
      if (dep === taskId) {
        path.push(dep);
        return true;
      }
      if (seen.has(dep)) continue;
      seen.add(dep);
      path.push(dep);
      if (visit(dep)) return true;
      path.pop();
    }
    return false;
  };
  return visit(taskId) ? path : null;
}

/** Identifiants nettoyés : espaces retirés, vides et doublons écartés, ordre conservé. */
export function normalizeDependencyIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}
