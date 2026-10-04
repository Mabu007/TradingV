/**
 * Sign-in.
 *
 * ## What this gate is and is not
 *
 * It is not a wall. An unconfigured build — no Firebase project — renders the
 * application exactly as it did before, with a stated reason in place of the
 * account form. Someone developing this repository without a Firebase project
 * should get the product, not a dead end, and should be told why.
 *
 * When Firebase *is* configured, a session is restored on load, so a refresh
 * comes back signed in without the password. Until there is a session, the gate
 * shows the two forms and nothing else — and the reason it is showing them is the
 * one honest reason: there is no account yet.
 *
 * ## What signing in does and does not do
 *
 * Signing in establishes an identity and a session. It does not start anything,
 * stop anything, or change which wallets are connected. Privy still owns the
 * wallet, and a GOAT that is already deployed keeps running while somebody
 * closes a laptop — because a sign-in is not a process the GOAT depends on.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  AuthError,
  type AuthFailure,
  type AuthSession,
} from '../../services/firebase/auth';
import { unavailableNotice, type FirebaseServices } from '../../services/firebase/configure';

type Mode = 'signIn' | 'register';

export interface AuthGateProps {
  services: FirebaseServices;
  /** Rendered when there is a session. Normally the whole application. */
  children: React.ReactNode;
}

export function AuthGate({ services, children }: AuthGateProps): React.ReactElement {
  const { auth } = services;
  const [session, setSession] = React.useState<AuthSession | null>(auth.current);
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    let live = true;
    // A restore that resolves after the user navigates away must not set state.
    void auth.start().then((restored) => {
      if (live) {
        setSession(restored);
        setRestoring(false);
      }
    });
    const unsubscribe = auth.subscribe((next) => {
      if (live) setSession(next);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [auth]);

  if (restoring) {
    /*
     * A spinner rather than the form, for one specific reason: showing the sign-in
     * form for the moment it takes to read a session that already exists is a
     * flash of "please sign in" at a user who is already signed in.
     */
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center" role="status">
        <span className="text-slate-400 text-sm">Restoring your session…</span>
      </div>
    );
  }

  if (session !== null) return <>{children}</>;
  if (!services.configured) return <>{children}</>;

  return <AccountForm services={services} onAuthenticated={setSession} />;
}

interface AccountFormProps {
  services: FirebaseServices;
  /** Called with the session that was established, not the credentials. */
  onAuthenticated: (session: AuthSession) => void;
}

function AccountForm({ services, onAuthenticated }: AccountFormProps): React.ReactElement {
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(unavailableNotice(services.unavailableReason));
  const busy = services.auth.inFlight;

  const canSubmit = useMemo(() => email.trim().length > 0 && password.length > 0, [email, password]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setFailure(null);
      setNotice(null);
      try {
        const account =
          mode === 'register'
            ? await services.auth.register({ email, password, passwordConfirmation: confirmation })
            : await services.auth.signIn({ email, password });
        onAuthenticated(account);
      } catch (error) {
        // Every failure in this layer is a typed one, so the form can render the
        // reason rather than "something went wrong".
        setFailure(error instanceof AuthError ? error.failure : { code: 'UNKNOWN', message: 'Sign-in failed. Try again.' });
      }
    },
    [mode, email, password, confirmation, services.auth, onAuthenticated],
  );

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <main className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-slate-100 mb-1">TradingGOATs</h1>
        <p className="text-sm text-slate-400 mb-6">
          {mode === 'signIn'
            ? 'Sign in to your account.'
            : 'Create an account. Your password is handled by Firebase and is never stored here.'}
        </p>

        <form onSubmit={submit} className="space-y-3" noValidate>
          <label className="block">
            <span className="text-xs text-slate-400">Email</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-1 w-full rounded-md bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100"
            />
          </label>

          <label className="block">
            <span className="text-xs text-slate-400">Password</span>
            <input
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 w-full rounded-md bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100"
            />
          </label>

          {mode === 'register' && (
            <label className="block">
              <span className="text-xs text-slate-400">Confirm password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                className="mt-1 w-full rounded-md bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100"
              />
            </label>
          )}

          {failure !== null && (
            <p role="alert" className="text-sm text-rose-300">
              {failure.message}
            </p>
          )}
          {notice !== null && (
            <p role="status" className="text-sm text-amber-300">
              {notice}
            </p>
          )}

          <button
            type="submit"
            disabled={!canSubmit || busy}
            className="w-full rounded-md bg-indigo-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Working…' : mode === 'signIn' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <button
          type="button"
          onClick={() => {
            setMode(mode === 'signIn' ? 'register' : 'signIn');
            setFailure(null);
          }}
          className="mt-4 text-xs text-slate-400 hover:text-slate-200"
        >
          {mode === 'signIn' ? 'No account? Create one' : 'Have an account? Sign in'}
        </button>
      </main>
    </div>
  );
}

export default AuthGate;