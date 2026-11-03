/**
 * Masquage des secrets dans un texte montré hors de Skipper (lien public d'une session) ou dans le journal du
 * serveur (écran du CLI pendant une connexion Claude). Même règle de base que le journal du CLI (`sk-ant-…` →
 * `sk-ant-[masqué]`), étendue aux jetons reconnaissables (GitHub, GitLab, Slack, AWS, clés d'API Skipper, JWT),
 * aux en-têtes `Authorization`, aux identifiants dans les URL, aux clés privées PEM et aux affectations de
 * variables sensibles (`PASSWORD=…`, `"token": "…"`). Le préfixe reconnaissable est gardé pour la lecture.
 */
export const MASK = '[masqué]';

const RULES: Array<[RegExp, string]> = [
  // Clés privées (bloc PEM entier).
  [/-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g, `-----BEGIN $1PRIVATE KEY----- ${MASK} -----END $1PRIVATE KEY-----`],
  // Anthropic (règle du journal du CLI), puis autres clés `sk-…` (OpenAI et compatibles).
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, `sk-ant-${MASK}`],
  [/\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/g, `sk-${MASK}`],
  // GitHub, GitLab, Slack, clés d'API de Skipper, Scaleway.
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, `$1_${MASK}`],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, `github_pat_${MASK}`],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, `glpat-${MASK}`],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, `xox-${MASK}`],
  [/\bskp_[A-Za-z0-9_-]{16,}/g, `skp_${MASK}`],
  // Clés d'accès AWS (l'identifiant n'est pas secret, mais il désigne un compte).
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, `$1${MASK}`],
  // JWT (trois segments base64url, les deux premiers commençant par `eyJ`).
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, `eyJ${MASK}`],
  // En-têtes d'authentification.
  [/\b(Authorization\s*:\s*(?:Bearer|Basic|token|Token)\s+)[^\s"'`]+/gi, `$1${MASK}`],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, `$1${MASK}`],
  [/\b(X-Api-Key\s*:\s*)[^\s"'`]+/gi, `$1${MASK}`],
  // Identifiants dans une URL (`scheme://user:mot-de-passe@hôte`).
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]+:)[^\s@/"'`]+@/gi, `$1${MASK}@`],
  // Affectations de variables sensibles (env, shell, YAML) : NOM_EN_MAJUSCULES=valeur.
  [/\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"'`]{4,})\3/g, `$1$2$3${MASK}$3`],
  // Champs JSON sensibles : "password": "valeur".
  [/("[A-Za-z0-9_-]*(?:password|passwd|secret|token|api_?key|apiKey|private_?key|access_?key)"\s*:\s*")([^"\\]|\\.){4,}?"/gi, `$1${MASK}"`],
];

/** Le texte, secrets masqués. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

/** Nom de champ dont la valeur (chaîne) est masquée entière : `password`, `apiKey`, `db_secret`… */
const SENSITIVE_KEY = /(?:^|[_-])(?:password|passwd|secret|token|api_?key|private_?key|access_?key)$|^(?:apiKey|privateKey|accessKey|secretKey|clientSecret)$/i;

/** Copie profonde d'une valeur JSON, secrets masqués dans toutes ses chaînes (les noms des champs sont gardés). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = typeof v === 'string' && v && SENSITIVE_KEY.test(k) ? MASK : redactDeep(v);
    return out as T;
  }
  return value;
}
