import { useEffect, useRef, useState } from 'react';

/**
 * Renders an exploded-view SVG produced by the `teardown` skill
 * (teardown-work/svgs -> public/illustrations). The SVG groups every component
 * with data-item="<BOM part id>", so we can highlight exactly the components
 * being installed in the current assembly step (accent) vs already installed
 * (default ink) vs not yet installed (faded).
 */

const svgCache = new Map<string, Promise<string>>();
function loadSvg(url: string): Promise<string> {
  let p = svgCache.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });
    svgCache.set(url, p);
  }
  return p;
}

export interface ExplodedViewProps {
  svgUrl: string;
  installedIds: string[];
  activeIds: string[];
}

export function ExplodedView({ svgUrl, installedIds, activeIds }: ExplodedViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    loadSvg(svgUrl)
      .then((text) => {
        if (cancelled || !hostRef.current) return;
        hostRef.current.innerHTML = text;
        setLoaded(true);
      })
      .catch((e: Error) => !cancelled && setError(`Could not load the exploded view (${e.message}).`));
    return () => {
      cancelled = true;
    };
  }, [svgUrl]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !loaded) return;
    const active = new Set(activeIds);
    const installed = new Set(installedIds);
    host.querySelectorAll('[data-item]').forEach((el) => {
      const id = el.getAttribute('data-item') ?? '';
      el.classList.remove('bfv-active', 'bfv-installed', 'bfv-pending');
      if (active.has(id)) el.classList.add('bfv-active');
      else if (installed.has(id)) el.classList.add('bfv-installed');
      else el.classList.add('bfv-pending');
    });
  }, [loaded, installedIds, activeIds]);

  return (
    <div className="bfv-exploded">
      {!loaded && !error && (
        <div className="illustration-loading">
          <span className="spinner" aria-hidden /> Loading exploded view…
        </div>
      )}
      {error && <p className="illustration-error">{error}</p>}
      <div ref={hostRef} className="bfv-exploded-host" />
      <span className="illustrative-badge">Exploded view — illustrative concept, dimensions not verified</span>
    </div>
  );
}
