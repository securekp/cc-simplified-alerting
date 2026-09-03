import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@capra/theme/base.css';
import '@capra/core/styles.css';
import '@capra/icons/styles.css';
import App from './App.tsx';
import './App.css';

const root = document.getElementById('root');
if (!root) throw new Error('Simplified Alerting could not find its #root element.');

createRoot(root).render(
  <StrictMode>
    {/*
      The platform serves the app under a path it chooses and exposes it as
      `window.CRIBL_BASE_PATH`. Routing without that basename produces links that
      escape the app's mount point.
    */}
    <BrowserRouter basename={window.CRIBL_BASE_PATH}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
