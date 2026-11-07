import type { ReactNode } from 'react';
import '../pages/auth.css';

/** Marque Skipper (rose des vents) dessinée par masque CSS, en couleur d'accent, pour les deux thèmes. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return <span className="auth-brand-mark" style={{ width: size, height: size }} aria-hidden />;
}

const features = [
  {
    icon: 'bi-layers',
    title: 'Des sessions en parallèle',
    text: 'Chaque session a son dossier de travail et sa branche git : les agents avancent ensemble sans se gêner.',
  },
  {
    icon: 'bi-shield-lock',
    title: 'Isolées et sous contrôle',
    text: 'Un conteneur par projet, un coffre dont les agents ne voient jamais les secrets, et votre accord avant toute action sensible.',
  },
  {
    icon: 'bi-kanban',
    title: 'De la tâche à la livraison',
    text: 'Tâches, revues de code, pull requests et CI suivies au même endroit, jusqu’au bouton « Livrer ».',
  },
  {
    icon: 'bi-people',
    title: 'Une équipe, personnes et agents',
    text: 'Conversations, fils de tâches et agents Product Manager ou Developer, membres du projet comme vous.',
  },
];

/**
 * Illustration de l'application : une fenêtre stylisée (liste de sessions, échange avec un agent, PR prête).
 * En HTML/CSS plutôt qu'en image pour suivre le thème clair ou sombre. Purement décorative.
 */
function ProductIllustration() {
  return (
    <div className="auth-mock" aria-hidden>
      <div className="auth-mock-bar">
        <span />
        <span />
        <span />
        <div className="auth-mock-url">skipper · Projet Atlas</div>
      </div>
      <div className="auth-mock-body">
        <div className="auth-mock-side">
          <div className="auth-mock-side-title">Sessions</div>
          <div className="auth-mock-session active">
            <i className="auth-dot running" />
            <span>Export CSV des factures</span>
          </div>
          <div className="auth-mock-session">
            <i className="auth-dot waiting" />
            <span>Migration de la base</span>
            <em>Accord</em>
          </div>
          <div className="auth-mock-session">
            <i className="auth-dot done" />
            <span>Corriger la CI</span>
          </div>
          <div className="auth-mock-session">
            <i className="auth-dot done" />
            <span>Page de tarifs</span>
          </div>
        </div>
        <div className="auth-mock-main">
          <div className="auth-mock-user">Ajoute un export CSV des factures, avec un test.</div>
          <div className="auth-mock-agent">
            <div className="auth-mock-line" style={{ width: '88%' }} />
            <div className="auth-mock-line" style={{ width: '64%' }} />
          </div>
          <div className="auth-mock-tool">
            <i className="bi bi-check2" /> npm test <span>— 214 tests réussis</span>
          </div>
          <div className="auth-mock-pr">
            <i className="bi bi-git" />
            <div>
              <strong>PR #212 · Export CSV</strong>
              <span>CI verte · prête à fusionner</span>
            </div>
            <em>Livrer</em>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Habillage des pages hors application (connexion, choix du mot de passe) : présentation de Skipper à gauche
 * (titre, illustration, points forts), carte du formulaire à droite. Sur un écran étroit, la carte vient juste
 * après le titre et la présentation passe dessous, sans l'illustration.
 */
export default function AuthShell({ children, showcase = true }: { children: ReactNode; showcase?: boolean }) {
  return (
    <div className={`auth-page${showcase ? '' : ' auth-page-simple'}`}>
      <div className="auth-grid">
        <header className="auth-head">
          <div className="auth-brand">
            <BrandMark />
            <span>Skipper</span>
          </div>
          {showcase && (
            <>
              <div className="auth-eyebrow">Plateforme d’agents de développement</div>
              <h1 className="auth-title">Vos agents de code, pilotés comme une équipe.</h1>
              <p className="auth-lead">
                Skipper fait travailler des agents Claude Code en arrière-plan, chacun dans son environnement isolé et sur sa propre branche. Vous suivez leur travail, répondez à leurs
                questions et livrez leurs pull requests, depuis votre ordinateur ou votre téléphone.
              </p>
            </>
          )}
        </header>
        <main className="auth-card-wrap">
          <div className="auth-card">{children}</div>
          <p className="auth-note">
            <i className="bi bi-lock me-1" />
            Accès sur invitation. Vos données restent hébergées en France.
          </p>
        </main>
        {showcase && (
          <section className="auth-showcase">
            <ProductIllustration />
            <ul className="auth-features">
              {features.map((f) => (
                <li key={f.title}>
                  <i className={`bi ${f.icon}`} />
                  <div>
                    <strong>{f.title}</strong>
                    <span>{f.text}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <footer className="auth-footer">
        <span>© {new Date().getFullYear()} Toolso</span>
        <a href="/privacy.html">Confidentialité</a>
      </footer>
    </div>
  );
}
