/**
 * Minimal router. The whole app is served from one origin with an SPA fallback,
 * so plain history navigation is enough -- no router library needed for nine
 * routes, and nothing to load from a CDN.
 */
import { useCallback, useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';

export interface RouteInfo {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

function read(): RouteInfo {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  return {
    path,
    segments: path.split('/').filter(Boolean),
    query: new URLSearchParams(window.location.search),
  };
}

export function useRoute(): RouteInfo {
  const [route, setRoute] = useState<RouteInfo>(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  }, []);
  return route;
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === `${window.location.pathname}${window.location.search}`) return;
  if (options.replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useNavigate(): (path: string, options?: { replace?: boolean }) => void {
  return useCallback((path: string, options?: { replace?: boolean }) => navigate(path, options), []);
}

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  children: ReactNode;
}

export function Link({ to, children, onClick, ...rest }: LinkProps) {
  return (
    <a
      href={to}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

/** Build a display URL, opening it in a new tab when asked. */
export function openWindow(path: string, features = 'width=1280,height=800'): void {
  window.open(path, '_blank', features);
}
