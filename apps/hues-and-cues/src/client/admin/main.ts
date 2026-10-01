import type {
  AdminOverviewResponse,
  AdminUserSummary,
  CreateInviteResponse,
  InviteSummary,
} from '../../shared/protocol.js';
import { ApiError, post, request } from '../common/api.js';
import { h, replaceChildren, requireElement } from '../common/dom.js';
import { toast } from '../control/toast.js';

/** The page is served at /admin/<secret path>; its API lives beneath it. */
const base = window.location.pathname.replace(/\/+$/u, '');
const apiUrl = (path: string): string => `${base}/api/${path}`;
const app = requireElement('#app', HTMLElement);

const STATUS_LABELS: Readonly<Record<InviteSummary['status'], string>> = {
  unused: 'Unused',
  used: 'Used',
  expired: 'Expired',
  revoked: 'Revoked',
};

function formatDate(epochMs: number | null): string {
  return epochMs === null
    ? '—'
    : new Date(epochMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function handleError(error: unknown, fallback: string): void {
  if (error instanceof ApiError && error.status === 401) {
    renderLogin();
    return;
  }
  toast(error instanceof Error ? error.message : fallback, 'error');
}

// -----------------------------------------------------------------------------
// Sign in
// -----------------------------------------------------------------------------

function renderLogin(): void {
  const password = h('input', {
    attrs: { id: 'password', type: 'password', required: '', autocomplete: 'current-password' },
  });
  const submit = h('button', {
    className: 'button button--primary',
    text: 'Sign in',
    attrs: { type: 'submit' },
  });
  const error = h('p', { className: 'form-error', attrs: { role: 'alert', hidden: '' } });
  const form = h(
    'form',
    { className: 'card auth__card' },
    h('h1', { text: 'Admin' }),
    h('label', { attrs: { for: 'password' }, text: 'Admin password' }),
    password,
    error,
    submit,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.hidden = true;
    post<undefined>(apiUrl('login'), { password: password.value })
      .then(() => {
        void loadDashboard();
      })
      .catch((reason: unknown) => {
        error.textContent = reason instanceof Error ? reason.message : 'Sign-in failed.';
        error.hidden = false;
        submit.disabled = false;
        password.select();
      });
  });
  replaceChildren(
    app,
    h(
      'main',
      { className: 'auth' },
      h('a', { className: 'auth__brand', text: 'Hues & Cues', attrs: { href: '/' } }),
      form,
    ),
  );
  password.focus();
}

// -----------------------------------------------------------------------------
// Dashboard
// -----------------------------------------------------------------------------

async function loadDashboard(): Promise<void> {
  try {
    renderDashboard(await request<AdminOverviewResponse>(apiUrl('overview')));
  } catch (error) {
    handleError(error, 'Could not load the dashboard.');
  }
}

function renderDashboard(overview: AdminOverviewResponse): void {
  const generated = h('div', { className: 'invite-reveal', attrs: { hidden: '' } });
  const note = h('input', {
    attrs: {
      id: 'invite-note',
      maxlength: '100',
      placeholder: 'Who is it for? (optional)',
      autocomplete: 'off',
    },
  });
  const generate = h('button', {
    className: 'button button--primary',
    text: 'Generate Code',
    attrs: { type: 'submit' },
  });
  const generateForm = h('form', { className: 'clue-form__row' }, note, generate);
  generateForm.addEventListener('submit', (event) => {
    event.preventDefault();
    generate.disabled = true;
    post<CreateInviteResponse>(
      apiUrl('invites'),
      note.value.trim() === '' ? {} : { note: note.value },
    )
      .then(({ code }) => {
        note.value = '';
        showGeneratedCode(generated, code);
        return request<AdminOverviewResponse>(apiUrl('overview'));
      })
      .then((next) => {
        replaceChildren(inviteList, ...inviteRows(next.invites));
      })
      .catch((error: unknown) => {
        handleError(error, 'Could not generate a code.');
      })
      .finally(() => {
        generate.disabled = false;
      });
  });

  const inviteList = h('ul', { className: 'room-list' }, ...inviteRows(overview.invites));

  replaceChildren(
    app,
    h(
      'header',
      { className: 'topbar' },
      h(
        'div',
        { className: 'topbar__brand' },
        h('a', { attrs: { href: '/' } }, h('strong', { text: 'Hues & Cues' })),
        h('span', { className: 'muted', text: 'Admin' }),
      ),
      h(
        'div',
        { className: 'topbar__status' },
        h('button', {
          className: 'button button--ghost button--small',
          text: 'Sign out',
          attrs: { type: 'button' },
          on: {
            click: () => {
              void post<undefined>(apiUrl('logout')).finally(renderLogin);
            },
          },
        }),
      ),
    ),
    h(
      'div',
      { className: 'lobby' },
      h(
        'section',
        { className: 'card' },
        h('h2', { text: 'Invite codes' }),
        h('p', {
          className: 'muted',
          text: `Sign-up is invite-only. Each code works once and expires after ${String(overview.inviteTtlDays)} days. The full code is shown only when it's generated.`,
        }),
        generateForm,
        generated,
        inviteList,
      ),
      h(
        'section',
        { className: 'card' },
        h('h2', { text: `Users (${String(overview.users.length)})` }),
        h('ul', { className: 'room-list' }, ...userRows(overview.users)),
      ),
    ),
  );

  function inviteRows(invites: readonly InviteSummary[]): Node[] {
    if (invites.length === 0) {
      return [h('li', { className: 'empty muted', text: 'No invite codes yet.' })];
    }
    return invites.map((invite) => {
      const detail =
        invite.status === 'used'
          ? `Used by ${invite.usedBy ?? 'a deleted account'} · ${formatDate(invite.usedAt)}`
          : invite.status === 'unused'
            ? `Expires ${formatDate(invite.expiresAt)}`
            : `Created ${formatDate(invite.createdAt)}`;
      return h(
        'li',
        {},
        h(
          'div',
          {},
          h('strong', { className: 'mono', text: `${invite.hint}-····-····` }),
          ' ',
          h('span', {
            className: `badge badge--${invite.status}`,
            text: STATUS_LABELS[invite.status],
          }),
          invite.note === null ? null : h('span', { className: 'hint', text: invite.note }),
          h('span', { className: 'hint', text: detail }),
        ),
        invite.status === 'unused'
          ? h('button', {
              className: 'button button--danger button--small',
              text: 'Revoke',
              attrs: { type: 'button', 'aria-label': `Revoke invite ${invite.hint}` },
              on: {
                click: () => {
                  if (
                    !window.confirm(
                      `Revoke invite ${invite.hint}-…? It will stop working immediately.`,
                    )
                  )
                    return;
                  request<undefined>(apiUrl(`invites/${String(invite.id)}`), { method: 'DELETE' })
                    .then(loadDashboard)
                    .catch((error: unknown) => {
                      handleError(error, 'Could not revoke the code.');
                    });
                },
              },
            })
          : null,
      );
    });
  }
}

function showGeneratedCode(container: HTMLElement, code: string): void {
  const copy = h('button', {
    className: 'button',
    text: 'Copy',
    attrs: { type: 'button' },
    on: {
      click: () => {
        void navigator.clipboard.writeText(code).then(
          () => {
            toast('Invite code copied.');
          },
          () => {
            toast('Copy failed — select the code and copy it manually.', 'error');
          },
        );
      },
    },
  });
  replaceChildren(
    container,
    h('p', { className: 'hint', text: 'New invite code — copy it now; it won’t be shown again:' }),
    h(
      'div',
      { className: 'clue-form__row' },
      h('code', { className: 'invite-code', text: code }),
      copy,
    ),
  );
  container.hidden = false;
}

function userRows(users: readonly AdminUserSummary[]): Node[] {
  if (users.length === 0) return [h('li', { className: 'empty muted', text: 'No users yet.' })];
  return users.map((user) =>
    h(
      'li',
      {},
      h(
        'div',
        {},
        h('strong', { text: user.username }),
        h('span', {
          className: 'hint',
          text: `Joined ${formatDate(user.createdAt)} · Last sign-in ${formatDate(user.lastLoginAt)}`,
        }),
      ),
      h('span', {
        className: 'muted',
        text:
          user.channels.length === 0 ? 'No games' : user.channels.map((c) => `#${c}`).join(', '),
      }),
    ),
  );
}

void loadDashboard();
