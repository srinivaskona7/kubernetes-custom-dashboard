import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { initTheme } from './theme';
import './theme.css';

/**
 * Before `createRoot`, deliberately. Applying the stored theme in an effect instead would paint
 * one frame in the wrong theme on every load, and going dark → light that frame is a full-screen
 * white flash. See `src/theme.ts`.
 */
initTheme();

/**
 * HashRouter, not BrowserRouter. Express serves this as static files under a
 * base path; a deep link like /compliance under BrowserRouter would be a 404 from the
 * server before React ever loads. A hash route never leaves the index document.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>
);
