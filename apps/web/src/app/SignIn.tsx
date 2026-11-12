import { useState } from 'react';
import { api, errText } from '../app/api';
import { useSession } from '../app/session';
import { Alert, Button, Field, Input } from '../ui';
import { AuthShell } from './AuthShell';
import { ThemeMenu } from './ThemeMenu';

/** Sign-in: the only signed-out screen. The demo mode starts signed in, so this is for real servers. */
export function SignIn() {
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <AuthShell
      title="Sign in"
      lead="Use the e-mail address your workspace admin invited."
      actions={<ThemeMenu />}
      footer={<p>Agentic SEO is open source. Ask a workspace admin for an invitation if you do not have an account yet.</p>}
    >
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api.signIn({ email, password });
            await refresh();
          } catch (e) {
            setError(errText(e) || 'Couldn’t sign in. Check your e-mail and password, then try again.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="E-mail" id="signin-email">
          <Input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            data-autofocus
            autoFocus
          />
        </Field>
        <Field label="Password" id="signin-password">
          <Input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
