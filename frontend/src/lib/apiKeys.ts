/** Exemples d'appel montrés à la création d'une clé (secret en clair, cette seule fois). */
export function curlExamples(base: string, secret: string, scopes: string[], signingSecret: string | null): string {
  const out: string[] = [];
  if (scopes.includes('tasks:write')) {
    out.push(`# Créer une tâche (API REST des tâches)\ncurl -X POST ${base}/api/v1/tasks \\\n  -H "Authorization: Bearer ${secret}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"title": "Nouvelle tâche", "description": "…", "priority": "medium"}'`);
  }
  if (scopes.some((s) => s.startsWith('inbound:'))) {
    const body = JSON.stringify({
      externalId: 'evt-123',
      source: 'mon-outil',
      ...(scopes.includes('inbound:task') ? { task: { title: 'Erreur de paiement', priority: 'high', tags: ['support'] } } : {}),
      ...(scopes.includes('inbound:triage') ? { triage: true } : {}),
      payload: { exemple: 'événement brut' },
    });
    if (signingSecret) {
      out.push(
        `# Événement entrant signé (HMAC-SHA256 de "<horodatage>.<corps>")\nBODY='${body}'\nTS=$(date +%s)\nSIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac '${signingSecret}' | sed 's/^.* //')\ncurl -X POST ${base}/api/v1/inbound \\\n  -H "Authorization: Bearer ${secret}" \\\n  -H "Content-Type: application/json" \\\n  -H "X-Skipper-Timestamp: $TS" \\\n  -H "X-Skipper-Signature: sha256=$SIG" \\\n  -d "$BODY"`,
      );
    } else {
      out.push(`# Événement entrant\ncurl -X POST ${base}/api/v1/inbound \\\n  -H "Authorization: Bearer ${secret}" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`);
    }
  }
  return out.join('\n\n');
}
