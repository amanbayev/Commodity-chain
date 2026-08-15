import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App.js';
import { AppProviders } from './app/AppProviders.js';
import './theme/global.css';
import { applyThemeTokens } from './theme/tokens.js';

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('Root element is missing');
}

applyThemeTokens(document.documentElement);

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <AppProviders>
        <App />
      </AppProviders>
    </BrowserRouter>
  </StrictMode>,
);
