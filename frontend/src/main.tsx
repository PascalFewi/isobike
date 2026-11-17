import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { loadAnalytics } from './lib/analytics.ts';
import './index.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root not found');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

loadAnalytics();

// Optional site script of a deployment (e.g. what fills the ad slots, AdSlot.tsx).
// Not part of this code base; without VITE_SITE_SCRIPT_URL nothing is loaded.
const siteScript = import.meta.env.VITE_SITE_SCRIPT_URL;
if (siteScript) {
  const s = document.createElement('script');
  s.type = 'module';
  s.src = siteScript;
  document.head.append(s);
}
