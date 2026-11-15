// Hash routing, so the static build works on any host without server rewrites.
import { useEffect, useState } from 'react';

export type Route =
  | { page: 'overview' }
  | { page: 'project'; id: string; tab: string; item: string | null };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'p' && parts[1]) return { page: 'project', id: parts[1], tab: parts[2] ?? 'handoff', item: parts[3] ?? null };
  return { page: 'overview' };
}

export function href(route: Route): string {
  if (route.page === 'overview') return '#/';
  const parts = ['p', route.id, route.tab, route.item].filter((p): p is string => !!p).map(encodeURIComponent);
  return `#/${parts.join('/')}`;
}

export function navigate(route: Route): void {
  window.location.hash = href(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
