import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  PASSWORD_MIN,
  PASSWORD_STRENGTH_LABELS,
  USERNAME_PROBLEM_MESSAGES,
  checkUsername,
  passwordStrength,
} from '@lethalmagotchi/shared';
import { ApiRequestError, api } from '../api/client.js';
import { useSession } from '../session/SessionProvider.js';

type Mode = 'login' | 'register';

interface AvailabilityState {
  status: 'idle' | 'checking' | 'available' | 'taken' | 'invalid';
  suggestions: string[];
}

export function AuthScreen() {
  const { login, register } = useSession();
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [availability, setAvailability] = useState<AvailabilityState>({ status: 'idle', suggestions: [] });
  const [banner, setBanner] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const passwordRef = useRef<HTMLInputElement>(null);

  const usernameProblem = usernameTouched ? checkUsername(username) : null;
  const strength = passwordStrength(password);

  useEffect(() => {
    if (mode !== 'register') return;
    if (username.trim().length < 3 || checkUsername(username)) {
      setAvailability({ status: username.trim().length >= 3 ? 'invalid' : 'idle', suggestions: [] });
      return;
    }
    const controller = new AbortController();
    setAvailability({ status: 'checking', suggestions: [] });
    const timer = window.setTimeout(() => {
      api
        .usernameAvailable(username, controller.signal)
        .then((result) =>
          setAvailability({
            status: result.available ? 'available' : 'taken',
            suggestions: result.suggestions,
          }),
        )
        .catch(() => setAvailability({ status: 'idle', suggestions: [] }));
    }, 400);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [username, mode]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  function switchMode(next: Mode) {
    setMode(next);
    setBanner(null);
    setFieldErrors({});
    setPassword('');
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting || cooldown > 0) return;
    setBanner(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      if (mode === 'login') await login({ username, password });
      else await register({ username, password });
    } catch (error) {
      setPassword('');
      if (error instanceof ApiRequestError) {
        if (error.retryAfterSeconds) setCooldown(error.retryAfterSeconds);
        if (Object.keys(error.fields).length > 0) setFieldErrors(error.fields);
        else setBanner(error.message);
        if (error.code === 'INVALID_CREDENTIALS') passwordRef.current?.focus();
      } else {
        setBanner((error as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const submitDisabled = submitting || cooldown > 0 || username.length === 0 || password.length < 1;

  return (
    <div className="auth-layout">
      <aside className="auth-hero" aria-hidden="true">
        <div className="hero-mascot">🦦</div>
        <h1>LethalMagotchi</h1>
        <p>Raise one small, well-dressed animal. Keep it alive.</p>
      </aside>

      <main className="auth-panel">
        <div className="card auth-card">
          <div className="segmented" role="tablist" aria-label="Login or register">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={mode === 'login' ? 'segment active' : 'segment'}
              onClick={() => switchMode('login')}
            >
              Log in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={mode === 'register' ? 'segment active' : 'segment'}
              onClick={() => switchMode('register')}
            >
              Register
            </button>
          </div>

          {banner && (
            <div className="banner error" role="alert">
              {cooldown > 0 ? `Too many attempts. Try again in ${cooldown}s.` : banner}
            </div>
          )}

          <form onSubmit={onSubmit} noValidate>
            <label className="field">
              <span className="field-label">Username</span>
              <input
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                onBlur={() => setUsernameTouched(true)}
                aria-invalid={Boolean(usernameProblem || fieldErrors.username)}
              />
              {mode === 'register' && (
                <span className="field-hint" aria-live="polite">
                  {usernameProblem
                    ? USERNAME_PROBLEM_MESSAGES[usernameProblem]
                    : availability.status === 'checking'
                      ? 'Checking…'
                      : availability.status === 'available'
                        ? '✓ Available'
                        : availability.status === 'taken'
                          ? `Taken. Try ${availability.suggestions.join(', ')}`
                          : ''}
                </span>
              )}
              {fieldErrors.username && <span className="field-error">{fieldErrors.username}</span>}
            </label>

            <label className="field">
              <span className="field-label">Password</span>
              <input
                ref={passwordRef}
                name="password"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyUp={(event) => setCapsLock(event.getModifierState('CapsLock'))}
                aria-invalid={Boolean(fieldErrors.password)}
              />
              {capsLock && <span className="field-hint">Caps Lock is on.</span>}
              {mode === 'register' && (
                <>
                  <span className="strength" aria-hidden="true">
                    {[0, 1, 2, 3].map((index) => (
                      <i key={index} className={index < strength ? `seg on s${strength}` : 'seg'} />
                    ))}
                  </span>
                  <span className="field-hint" aria-live="polite">
                    {password.length === 0
                      ? `At least ${PASSWORD_MIN} characters.`
                      : password.length < PASSWORD_MIN
                        ? `${password.length}/${PASSWORD_MIN} characters`
                        : PASSWORD_STRENGTH_LABELS[strength]}
                  </span>
                </>
              )}
              {fieldErrors.password && <span className="field-error">{fieldErrors.password}</span>}
            </label>

            <button type="submit" className="primary" disabled={submitDisabled}>
              {submitting && <span className="spinner" aria-hidden="true" />}
              {mode === 'login' ? 'Log in' : 'Create account'}
            </button>
          </form>

          <p className="muted small">
            {mode === 'login' ? (
              <>
                New here?{' '}
                <button type="button" className="link" onClick={() => switchMode('register')}>
                  Create account
                </button>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <button type="button" className="link" onClick={() => switchMode('login')}>
                  Log in
                </button>
              </>
            )}
          </p>
        </div>
      </main>
    </div>
  );
}
