import type {
  ApiError,
  BotChannel,
  BotInvite,
  BotOverview,
  BotStatus,
  HuesCreatedInvite,
  HuesInvite,
  HuesOverview,
  HuesUser,
} from '../shared/api.js';
import { type Child, h, replaceChildren, requireElement } from './dom.js';

// The page lives at /admin/<secret path>/; everything is relative to it.
const base = window.location.pathname.endsWith('/')
  ? window.location.pathname
  : `${window.location.pathname}/`;
const app = requireElement('#app', HTMLElement);
const REFRESH_MS = 30_000;

class HttpError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${base}api/${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as T | ApiError | null;
  if (!response.ok) {
    const message =
      payload !== null && typeof payload === 'object' && 'error' in payload
        ? payload.error
        : `Request failed (${String(response.status)})`;
    throw new HttpError(message, response.status);
  }
  return payload as T;
}

function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const container = requireElement('#toasts', HTMLElement);
  const element = h('div', {
    className: `toast${kind === 'error' ? ' toast--error' : ''}`,
    text: message,
  });
  container.append(element);
  window.setTimeout(() => {
    element.remove();
  }, 4000);
}

function fail(error: unknown, fallback: string): void {
  if (error instanceof HttpError && error.status === 401) {
    renderLogin();
    return;
  }
  toast(error instanceof Error ? error.message : fallback, 'error');
}

function formatDate(epochMs: number | null | undefined): string {
  return epochMs == null
    ? '—'
    : new Date(epochMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatAgo(epochMs: number | null | undefined): string {
  if (epochMs == null) return 'never';
  const seconds = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (seconds < 60) return `${String(seconds)}s ago`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))}h ago`;
  return `${String(Math.floor(seconds / 86_400))}d ago`;
}

function formatUptime(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${String(days)}d ${String(hours % 24)}h`;
  if (hours > 0) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(minutes)}m`;
}

const badge = (text: string, tone: 'ok' | 'warn' | 'bad' | 'plain' = 'plain'): HTMLElement =>
  h('span', { className: `badge${tone === 'plain' ? '' : ` badge--${tone}`}`, text });

function button(
  text: string,
  onClick: () => void,
  variant: 'primary' | 'danger' | 'default' = 'default',
): HTMLButtonElement {
  return h('button', {
    className: `button button--small${variant === 'default' ? '' : ` button--${variant}`}`,
    text,
    attrs: { type: 'button' },
    on: { click: onClick },
  });
}

function copyButton(value: string): HTMLButtonElement {
  return button('Copy', () => {
    void navigator.clipboard.writeText(value).then(
      () => {
        toast('Copied.');
      },
      () => {
        toast('Copy failed — select the code and copy it manually.', 'error');
      },
    );
  });
}

function revealCode(container: HTMLElement, code: string, note: string): void {
  replaceChildren(
    container,
    h('span', { className: 'hint', text: note }),
    h('div', { className: 'row' }, h('code', { className: 'code', text: code }), copyButton(code)),
  );
  container.hidden = false;
}

// -----------------------------------------------------------------------------
// Sign in
// -----------------------------------------------------------------------------

function renderLogin(): void {
  window.clearInterval(refreshTimer);
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
    { className: 'card login' },
    h('p', { className: 'brand', text: 'stream-tools' }),
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
    api('login', { method: 'POST', body: { password: password.value } })
      .then(() => {
        renderDashboard();
      })
      .catch((reason: unknown) => {
        error.textContent = reason instanceof Error ? reason.message : 'Sign-in failed.';
        error.hidden = false;
        submit.disabled = false;
        password.select();
      });
  });
  replaceChildren(app, form);
  password.focus();
}

// -----------------------------------------------------------------------------
// Dashboard
// -----------------------------------------------------------------------------

let refreshTimer = 0;

const TWITCH_MESSAGES: Readonly<Record<string, [string, 'ok' | 'bad']>> = {
  connected: ['Twitch chat login connected — the bot is restarting to apply it.', 'ok'],
  declined: ['Twitch authorization was declined.', 'bad'],
  expired: ['That Twitch authorization link expired or was already used. Try again.', 'bad'],
  failed: ['Twitch rejected the authorization. Check the bot logs and try again.', 'bad'],
  'not-configured': ['Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET for the bot first.', 'bad'],
};

function renderDashboard(): void {
  const botSection = h('section', { className: 'app-section' });
  const huesSection = h('section', { className: 'app-section' });

  const params = new URLSearchParams(window.location.search);
  const twitchResult = params.get('twitch');
  const banner = twitchResult === null ? undefined : TWITCH_MESSAGES[twitchResult];
  if (twitchResult !== null) window.history.replaceState(null, '', base);

  replaceChildren(
    app,
    h(
      'header',
      { className: 'topbar' },
      h(
        'div',
        {},
        h('span', { className: 'brand', text: 'stream-tools' }),
        ' ',
        h('span', { className: 'muted', text: 'admin' }),
      ),
      h(
        'div',
        { className: 'row' },
        button('Refresh', refresh),
        button('Sign out', () => {
          void api('logout', { method: 'POST' }).finally(renderLogin);
        }),
      ),
    ),
    banner &&
      h('div', {
        className: `banner banner--${banner[1]}`,
        attrs: { role: 'status' },
        text: banner[0],
      }),
    h('div', { className: 'stack' }, botSection, huesSection),
  );

  function refresh(): void {
    void loadBot(botSection);
    void loadHues(huesSection);
  }
  refresh();
  window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(refresh, REFRESH_MS);
}

function sectionShell(container: HTMLElement, title: string, ...children: Child[]): void {
  replaceChildren(
    container,
    h('h2', { text: title }),
    h('div', { className: 'grid' }, ...children),
  );
}

function unreachable(container: HTMLElement, title: string, error: unknown): void {
  if (error instanceof HttpError && error.status === 401) {
    renderLogin();
    return;
  }
  sectionShell(
    container,
    title,
    h(
      'div',
      { className: 'card card--wide card--error' },
      h('h3', { text: 'Unavailable' }),
      h('p', {
        className: 'muted',
        text: error instanceof Error ? error.message : 'Could not load this app.',
      }),
    ),
  );
}

// --- Dead by Daylight bot -----------------------------------------------------------

const BOT_TITLE = 'Dead by Daylight bot';
const EVENT_LABELS: Readonly<Record<string, string>> = {
  online: 'Stream started',
  offline: 'Stream ended',
  revoked: 'Subscription revoked',
};

async function loadBot(container: HTMLElement): Promise<void> {
  try {
    renderBot(container, await api<BotOverview>('dbd-bot'));
  } catch (error) {
    unreachable(container, BOT_TITLE, error);
  }
}

function renderBot(container: HTMLElement, overview: BotOverview): void {
  const reload = (): void => void loadBot(container);
  const reveal = h('div', { className: 'reveal', attrs: { hidden: '' } });
  sectionShell(
    container,
    BOT_TITLE,
    botStatusCard(overview.status),
    h(
      'div',
      { className: 'card' },
      h('h3', { text: 'Invite codes' }),
      h('p', {
        className: 'muted',
        text: 'Single-use codes streamers enter on the bot’s landing page to connect their channel.',
      }),
      button(
        'Generate Code',
        () => {
          api<{ code: string }>('dbd-bot/invites', { method: 'POST' })
            .then(({ code }) => {
              container.dataset.revealed = code;
              reload();
            })
            .catch((error: unknown) => {
              fail(error, 'Could not generate a code.');
            });
        },
        'primary',
      ),
      reveal,
      h('ul', { className: 'list' }, ...botInviteRows(overview.invites, reload)),
    ),
    h(
      'div',
      { className: 'card card--wide' },
      h('h3', { text: `Channels (${String(overview.channels.length)})` }),
      h('ul', { className: 'list' }, ...botChannelRows(overview.channels, reload)),
    ),
    webhookCard(overview.status),
  );
  const revealed = container.dataset.revealed;
  if (revealed) {
    revealCode(reveal, revealed, 'New bot invite code:');
    delete container.dataset.revealed;
  }
}

function botStatusCard(status: BotStatus): HTMLElement {
  return h(
    'div',
    { className: 'card' },
    h('h3', { text: 'Status' }),
    h(
      'dl',
      { className: 'stats' },
      h(
        'div',
        {},
        h('dt', { text: 'Twitch chat' }),
        h('dd', {}, status.connected ? badge('Connected', 'ok') : badge('Disconnected', 'bad')),
      ),
      h('div', {}, h('dt', { text: 'Uptime' }), h('dd', { text: formatUptime(status.uptimeMs) })),
      h('div', {}, h('dt', { text: 'Bot account' }), h('dd', { text: status.botName })),
      h(
        'div',
        {},
        h('dt', { text: 'Prefix' }),
        h('dd', { className: 'mono', text: status.prefix.trim() }),
      ),
    ),
    h('h3', { text: 'Chat login' }),
    h('p', {
      className: 'muted',
      text: status.chatSelfRefreshing
        ? 'Self-refreshing login is active.'
        : 'Using a static token that will eventually expire.',
    }),
    status.twitch.configured
      ? h('a', {
          className: 'button button--small',
          text: status.chatSelfRefreshing ? 'Reconnect via Twitch' : 'Connect via Twitch',
          attrs: { href: `${base}twitch-connect` },
        })
      : h('span', {
          className: 'hint',
          text: 'Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to connect via Twitch.',
        }),
  );
}

function botInviteRows(invites: readonly BotInvite[], reload: () => void): Node[] {
  if (invites.length === 0) return [h('li', { className: 'empty', text: 'No unused codes.' })];
  return invites.map((invite) =>
    h(
      'li',
      {},
      h(
        'div',
        {},
        h('strong', { className: 'mono', text: invite.code }),
        h('span', { className: 'hint', text: `Created ${formatDate(invite.createdAt)}` }),
      ),
      h(
        'div',
        { className: 'actions' },
        copyButton(invite.code),
        button(
          'Revoke',
          () => {
            if (!window.confirm(`Revoke bot invite ${invite.code}?`)) return;
            api(`dbd-bot/invites/${String(invite.id)}`, { method: 'DELETE' })
              .then(reload)
              .catch((error: unknown) => {
                fail(error, 'Could not revoke the code.');
              });
          },
          'danger',
        ),
      ),
    ),
  );
}

function botChannelRows(channels: readonly BotChannel[], reload: () => void): Node[] {
  if (channels.length === 0)
    return [h('li', { className: 'empty', text: 'No channels connected yet.' })];
  const act = (channel: string, action: 'join' | 'leave' | 'disconnect'): void => {
    if (
      action === 'disconnect' &&
      !window.confirm(`Disconnect #${channel} from the bot? This clears its queue.`)
    ) {
      return;
    }
    api(`dbd-bot/channels/${channel}/${action}`, { method: 'POST' })
      .then(() => {
        toast(`#${channel}: ${action} requested.`);
        window.setTimeout(reload, 1500);
      })
      .catch((error: unknown) => {
        fail(error, `Could not ${action} #${channel}.`);
      });
  };
  return channels.map((ch) =>
    h(
      'li',
      {},
      h(
        'div',
        {},
        h('strong', { text: `#${ch.channel}` }),
        ' ',
        ch.inChat ? badge('In chat', 'ok') : badge('Not in chat'),
        ' ',
        ch.queueOpen ? badge('Queue open') : badge('Queue closed', 'warn'),
        h('span', {
          className: 'hint',
          text: `${String(ch.queueSize)} in queue · added ${formatDate(ch.addedAt)}`,
        }),
      ),
      h(
        'div',
        { className: 'actions' },
        ch.inChat
          ? button('Leave', () => {
              act(ch.channel, 'leave');
            })
          : button('Join', () => {
              act(ch.channel, 'join');
            }),
        button(
          'Disconnect',
          () => {
            act(ch.channel, 'disconnect');
          },
          'danger',
        ),
      ),
    ),
  );
}

function webhookCard(status: BotStatus): HTMLElement {
  const webhook = status.webhook;
  if (!webhook.enabled) {
    return h(
      'div',
      { className: 'card' },
      h('h3', { text: 'Webhook activity' }),
      h('p', {
        className: 'muted',
        text: 'EventSub webhooks are off; live status comes from polling.',
      }),
    );
  }
  const events = webhook.recentEvents ?? [];
  return h(
    'div',
    { className: 'card' },
    h('h3', { text: 'Webhook activity' }),
    h(
      'dl',
      { className: 'stats' },
      h('div', {}, h('dt', { text: 'Received' }), h('dd', { text: String(webhook.received ?? 0) })),
      h('div', {}, h('dt', { text: 'Rejected' }), h('dd', { text: String(webhook.rejected ?? 0) })),
      h('div', {}, h('dt', { text: 'Last' }), h('dd', { text: formatAgo(webhook.lastReceivedAt) })),
    ),
    h(
      'ul',
      { className: 'list' },
      ...(events.length === 0
        ? [h('li', { className: 'empty', text: 'No events received yet.' })]
        : events.map((event) =>
            h(
              'li',
              {},
              h('span', { text: `#${event.channel}` }),
              h('span', {
                className: 'muted',
                text: `${EVENT_LABELS[event.type] ?? event.type} · ${formatAgo(event.time)}`,
              }),
            ),
          )),
    ),
  );
}

// --- Hues & Cues ------------------------------------------------------------------

const HUES_TITLE = 'Hues & Cues';
const HUES_STATUS: Readonly<
  Record<HuesInvite['status'], [string, 'ok' | 'warn' | 'bad' | 'plain']>
> = {
  unused: ['Unused', 'ok'],
  used: ['Used', 'plain'],
  expired: ['Expired', 'bad'],
  revoked: ['Revoked', 'bad'],
};

async function loadHues(container: HTMLElement): Promise<void> {
  try {
    renderHues(container, await api<HuesOverview>('hues-and-cues'));
  } catch (error) {
    unreachable(container, HUES_TITLE, error);
  }
}

function renderHues(container: HTMLElement, overview: HuesOverview): void {
  const reload = (): void => void loadHues(container);
  const reveal = h('div', { className: 'reveal', attrs: { hidden: '' } });
  const note = h('input', {
    attrs: {
      id: 'hues-note',
      maxlength: '100',
      placeholder: 'Who is it for? (optional)',
      autocomplete: 'off',
    },
  });
  const generate = h('button', {
    className: 'button button--primary button--small',
    text: 'Generate Code',
    attrs: { type: 'submit' },
  });
  const form = h('form', { className: 'row' }, note, generate);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    generate.disabled = true;
    api<HuesCreatedInvite>('hues-and-cues/invites', { method: 'POST', body: { note: note.value } })
      .then(({ code }) => {
        container.dataset.revealed = code;
        reload();
      })
      .catch((error: unknown) => {
        fail(error, 'Could not generate a code.');
        generate.disabled = false;
      });
  });

  sectionShell(
    container,
    HUES_TITLE,
    h(
      'div',
      { className: 'card' },
      h('h3', { text: 'Invite codes' }),
      h('p', {
        className: 'muted',
        text: `Sign-up is invite-only. Each code works once and expires after ${String(overview.inviteTtlDays)} days. The full code is shown only once.`,
      }),
      form,
      reveal,
      h('ul', { className: 'list' }, ...huesInviteRows(overview.invites, reload)),
    ),
    h(
      'div',
      { className: 'card' },
      h('h3', { text: `Users (${String(overview.users.length)})` }),
      h('ul', { className: 'list' }, ...huesUserRows(overview.users)),
    ),
  );
  const revealed = container.dataset.revealed;
  if (revealed) {
    revealCode(
      reveal,
      revealed,
      'New Hues & Cues invite code — copy it now; it won’t be shown again:',
    );
    delete container.dataset.revealed;
  }
}

function huesInviteRows(invites: readonly HuesInvite[], reload: () => void): Node[] {
  if (invites.length === 0) return [h('li', { className: 'empty', text: 'No invite codes yet.' })];
  return invites.map((invite) => {
    const [label, tone] = HUES_STATUS[invite.status];
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
        badge(label, tone),
        invite.note === null ? null : h('span', { className: 'hint', text: invite.note }),
        h('span', { className: 'hint', text: detail }),
      ),
      invite.status === 'unused'
        ? button(
            'Revoke',
            () => {
              if (!window.confirm(`Revoke Hues & Cues invite ${invite.hint}-…?`)) return;
              api(`hues-and-cues/invites/${String(invite.id)}`, { method: 'DELETE' })
                .then(reload)
                .catch((error: unknown) => {
                  fail(error, 'Could not revoke the code.');
                });
            },
            'danger',
          )
        : null,
    );
  });
}

function huesUserRows(users: readonly HuesUser[]): Node[] {
  if (users.length === 0) return [h('li', { className: 'empty', text: 'No accounts yet.' })];
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
          text: `Joined ${formatDate(user.createdAt)} · last sign-in ${formatDate(user.lastLoginAt)}`,
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

// -----------------------------------------------------------------------------

void api<{ signedIn: boolean }>('session')
  .then(({ signedIn }) => {
    if (signedIn) renderDashboard();
    else renderLogin();
  })
  .catch(() => {
    renderLogin();
  });
