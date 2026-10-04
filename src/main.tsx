import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
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
          <App />
        </WalletProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
