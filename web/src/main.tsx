import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DataSource } from '@shared/datasource';
import { createSource, loadConfig } from './data/source';
import { SourceProvider, ToastProvider, useSource } from './lib/app';
import { useRoute } from './lib/router';
import { Overview } from './pages/Overview';
import { ProjectPage } from './pages/Project';
import { Spinner } from './components/ui';
import './styles.css';

function Shell() {
  const route = useRoute();
  const source = useSource();
  useEffect(() => {
    document.title = route.page === 'project' ? `${route.id} · varvar` : 'varvar';
  }, [route]);
  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">
          <span className="logo" aria-hidden>
            ▦
          </span>
          varvar
        </a>
        <span className={`source source-${source.kind}`} title={capabilityText(source)}>
          {source.label}
        </span>
      </header>
      <main>
        {route.page === 'overview' ? <Overview /> : <ProjectPage key={route.id} id={route.id} tab={route.tab} item={route.item} />}
      </main>
    </>
  );
}

function capabilityText(s: DataSource): string {
  const c = s.capabilities;
  return [
    c.write ? 'Can edit project files' : 'Read-only',
    c.uncommitted ? 'Shows uncommitted work' : 'Pushed state only',
    c.live ? 'Live updates' : 'No live updates',
  ].join(' · ');
}

function Root() {
  const [source, setSource] = useState<DataSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadConfig()
      .then(createSource)
      .then(setSource)
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) {
    return (
      <div className="page">
        <div className="alert alert-error">{error}</div>
      </div>
    );
  }
  if (!source) return <Spinner />;
  return (
    <SourceProvider source={source}>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </SourceProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
