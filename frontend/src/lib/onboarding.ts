import { useQuery } from '@apollo/client';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { SETTINGS, type AppSettings } from '../graphql/settings';

/**
 * Ouvre l'assistant d'office, une fois par chargement, à la première connexion : quand la personne arrive sur le tableau de
 * bord sans l'avoir passé ni terminé et sans aucun compte à elle (ni Claude, ni GitHub, ni GitLab) — les personnes déjà
 * installées ne le voient pas apparaître.
 */
export function useOnboardingAutoOpen(pathname: string) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const skip = !user || user.isGuest || pathname !== '/';
  const { data } = useQuery<{ settings: AppSettings }>(SETTINGS, { skip, fetchPolicy: 'cache-first' });
  useEffect(() => {
    if (skip || !data) return;
    const s = data.settings;
    if (s.onboarding.dismissedAt || s.onboarding.completedAt) return;
    const ownClaude = s.claudeAuth.hasOauthToken || s.claudeAuth.hasApiKey;
    if (ownClaude || s.github.connected || s.gitlab.connected) return;
    try {
      if (sessionStorage.getItem('skipper.onboarding.opened')) return;
      sessionStorage.setItem('skipper.onboarding.opened', '1');
    } catch {
      /* navigation privée : on ouvre quand même */
    }
    navigate('/welcome', { replace: true });
  }, [skip, data, navigate]);
}
