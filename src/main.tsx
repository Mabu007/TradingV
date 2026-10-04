import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AuthGate } from './components/auth/AuthGate';
import { configureFirebase } from './services/firebase/configure';
import App from './App.tsx';
import { ErrorBoundary } from './components/layout/ErrorBoundary.tsx';
import { WalletProvider } from './services/wallet/index.ts';
import { ThemeProvider } from './services/theme/index.ts';
import { applyThemeAttribute, resolveInitialTheme } from './services/theme/theme';
import './index.css';

/*
 * Apply the theme before the first paint so the shell never flashes the
 * wrong palette. ThemeProvider takes over from here.
 */
applyThemeAttribute(
  resolveInitialTheme(
    typeof localStorage === 'undefined' ? null : localStorage,
    (() => {
      try {
        return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches;
      } catch {
        return undefined;
      }
    })(),
  ),
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        {/*
          Privy is mounted once, at the root, and only when an application
          id is configured. The rest of the application reads wallet state
          through `useWallet()` and never touches the SDK directly.
        */}
        <WalletProvider>
          {/*
            The account gate sits outside the application, not inside a view, for
            one reason: it must be in effect before any surface reads a session.
            Wrapping a single view would leave the rest of the tree rendering for a
            user who is not signed in.
          */}
          <AuthGate services={configureFirebase()}>
            <App />
          </AuthGate>
        </WalletProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
