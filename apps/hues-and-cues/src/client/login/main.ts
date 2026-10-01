import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '../../shared/endpoints.js';
import { api } from '../common/api.js';
import { h, replaceChildren, requireElement } from '../common/dom.js';

type Mode = 'login' | 'register';

const card = requireElement('#auth-card', HTMLElement);
const params = new URLSearchParams(window.location.search);

/**
 * Only same-origin destinations, so the login page can't be used as an open
 * redirect. Resolving with the URL parser (rather than checking prefixes)
 * handles the tabs, newlines and backslashes browsers silently normalise.
 */
function nextUrl(): string {
  const next = params.get('next');
  if (next === null) return '/control';
  try {
    const url = new URL(next, window.location.origin);
    return url.origin === window.location.origin
      ? `${url.pathname}${url.search}${url.hash}`
      : '/control';
  } catch {
    return '/control';
  }
}

function field(label: string, input: HTMLInputElement, hint?: string): HTMLElement {
  return h(
    'div',
    { className: 'field' },
    h('label', { attrs: { for: input.id }, text: label }),
    input,
    hint === undefined ? null : h('span', { className: 'hint', text: hint }),
  );
}

function render(mode: Mode): void {
  const isRegister = mode === 'register';
  const error = h('p', { className: 'form-error', attrs: { role: 'alert', hidden: '' } });
  const username = h('input', {
    attrs: {
      id: 'username',
      name: 'username',
      required: '',
      autocomplete: 'username',
      autocapitalize: 'none',
      spellcheck: 'false',
      ...(isRegister
        ? {
            minlength: String(USERNAME_MIN_LENGTH),
            maxlength: String(USERNAME_MAX_LENGTH),
            pattern: '[A-Za-z0-9_\\-]+',
          }
        : {}),
    },
  });
  const password = h('input', {
    attrs: {
      id: 'password',
      name: 'password',
      type: 'password',
      required: '',
      autocomplete: isRegister ? 'new-password' : 'current-password',
      maxlength: String(PASSWORD_MAX_LENGTH),
      ...(isRegister ? { minlength: String(PASSWORD_MIN_LENGTH) } : {}),
    },
  });
  const confirm = h('input', {
    attrs: {
      id: 'confirm',
      name: 'confirm',
      type: 'password',
      required: '',
      autocomplete: 'new-password',
    },
  });
  const code = h('input', {
    attrs: {
      id: 'invite-code',
      name: 'inviteCode',
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      placeholder: 'XXXX-XXXX-XXXX',
      required: '',
      maxlength: '64',
    },
  });
  const submit = h('button', {
    className: 'button button--primary',
    text: isRegister ? 'Create account' : 'Sign in',
    attrs: { type: 'submit' },
  });

  const showError = (message: string): void => {
    error.textContent = message;
    error.hidden = false;
  };

  const form = h(
    'form',
    { attrs: { novalidate: '' } },
    field(
      'Username',
      username,
      isRegister
        ? `${String(USERNAME_MIN_LENGTH)}–${String(USERNAME_MAX_LENGTH)} letters, numbers, _ or -`
        : undefined,
    ),
    field(
      'Password',
      password,
      isRegister
        ? `At least ${String(PASSWORD_MIN_LENGTH)} characters. A passphrase works well.`
        : undefined,
    ),
    isRegister && field('Confirm password', confirm),
    isRegister &&
      field(
        'Invite code',
        code,
        'Sign-up is invite-only. Ask the person who runs this site for a code.',
      ),
    error,
    submit,
  );

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    error.hidden = true;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    if (isRegister && password.value !== confirm.value) {
      showError('Passwords do not match.');
      confirm.focus();
      return;
    }
    submit.disabled = true;
    const request = isRegister
      ? api.register({
          username: username.value,
          password: password.value,
          inviteCode: code.value,
        })
      : api.login({ username: username.value, password: password.value });
    request
      .then(() => {
        window.location.assign(nextUrl());
      })
      .catch((reason: unknown) => {
        showError(reason instanceof Error ? reason.message : 'Something went wrong.');
        submit.disabled = false;
        password.select();
      });
  });

  const switcher = h(
    'p',
    { className: 'auth__switch muted' },
    isRegister ? 'Already have an account? ' : 'Have an invite code? ',
    h('a', {
      text: isRegister ? 'Sign in' : 'Create an account',
      attrs: { href: isRegister ? '?mode=login' : '?mode=register' },
      on: {
        click: (event) => {
          event.preventDefault();
          const target: Mode = isRegister ? 'login' : 'register';
          params.set('mode', target);
          window.history.replaceState(null, '', `?${params.toString()}`);
          render(target);
        },
      },
    }),
  );

  replaceChildren(
    card,
    h('h1', { text: isRegister ? 'Create your account' : 'Sign in' }),
    h('p', {
      className: 'muted',
      text: isRegister
        ? 'An account keeps your games and scores. Your viewers never need one.'
        : 'Sign in to run Hues & Cues on your stream.',
    }),
    form,
    switcher,
  );
  username.focus();
}

render(params.get('mode') === 'register' ? 'register' : 'login');
