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
const base = window.location.pathname.replace(/[^/]*$/u, '');
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

/** Shows a newly generated code until the admin dismisses it; refreshes keep it. */
function revealCode(container: HTMLElement, code: string, note: string): void {
  replaceChildren(
    container,
    h('span', { className: 'hint', text: note }),
    h(
      'div',
      { className: 'row' },
      h('code', { className: 'code', text: code }),
      copyButton(code),
      button('Dismiss', () => {
        container.hidden = true;
        replaceChildren(container);
      }),
    ),
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
  'wrong-account': [
    'That Twitch account isn’t the bot’s. Connect again and sign in to Twitch as the bot account.',
    'bad',
  ],
  unavailable: [
    'The bot is not reachable right now, so Twitch can’t be connected. Try again shortly.',
    'bad',
  ],
  'not-configured': ['Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET for the bot first.', 'bad'],
};

/** One app's part of the dashboard. Built once; refreshes only update its data. */
interface Section {
  readonly element: HTMLElement;
  load(): Promise<void>;
}

function renderDashboard(): void {
  const params = new URLSearchParams(window.location.search);
  const twitchResult = params.get('twitch');
  const banner = twitchResult === null ? undefined : TWITCH_MESSAGES[twitchResult];
  if (twitchResult !== null) window.history.replaceState(null, '', base);

  const sections = [createBotSection(), createHuesSection()];
  const refresh = (): void => {
    for (const section of sections) void section.load();
  };

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
    h('div', { className: 'stack' }, ...sections.map((section) => section.element)),
  );

  refresh();
  window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(refresh, REFRESH_MS);
}

/**
 * Section chrome: a title, an error card for when the app can't be reached,
 * and a grid of cards that is hidden while the error shows.
 */
function sectionFrame(
  title: string,
  cards: readonly HTMLElement[],
): { element: HTMLElement; show(): void; fail(error: unknown): void } {
  const errorText = h('p', { className: 'muted' });
  const errorCard = h(
    'div',
    { className: 'card card--wide card--error', attrs: { hidden: '' } },
    h('h3', { text: 'Unavailable' }),
    errorText,
  );
  const grid = h('div', { className: 'grid' }, ...cards);
  return {
    element: h('section', { className: 'app-section' }, h('h2', { text: title }), errorCard, grid),
    show() {
      errorCard.hidden = true;
      grid.hidden = false;
    },
    fail(error) {
      if (error instanceof HttpError && error.status === 401) {
        renderLogin();
        return;
      }
      errorText.textContent = error instanceof Error ? error.message : 'Could not load this app.';
      errorCard.hidden = false;
      grid.hidden = true;
    },
  };
}

// --- Dead by Daylight bot -----------------------------------------------------------

const EVENT_LABELS: Readonly<Record<string, string>> = {
  online: 'Stream started',
  offline: 'Stream ended',
  revoked: 'Subscription revoked',
};

function createBotSection(): Section {
  const statusCard = h('div', { className: 'card' });
  const reveal = h('div', { className: 'reveal', attrs: { hidden: '' } });
  const inviteList = h('ul', { className: 'list' });
  const channelsTitle = h('h3');
  const channelList = h('ul', { className: 'list' });
  const webhookCard = h('div', { className: 'card' });

  const generate: HTMLButtonElement = button(
    'Generate Code',
    () => {
      generate.disabled = true;
      api<{ code: string }>('dbd-bot/invites', { method: 'POST' })
        .then(({ code }) => {
          revealCode(reveal, code, 'New bot invite code:');
          return load();
        })
        .catch((error: unknown) => {
          fail(error, 'Could not generate a code.');
        })
        .finally(() => {
          generate.disabled = false;
        });
    },
    'primary',
  );

  const frame = sectionFrame('Dead by Daylight bot', [
    statusCard,
    h(
      'div',
      { className: 'card' },
      h('h3', { text: 'Invite codes' }),
      h('p', {
        className: 'muted',
        text: 'Single-use codes streamers enter on the bot’s landing page to connect their channel.',
      }),
      generate,
      reveal,
      inviteList,
    ),
    h('div', { className: 'card card--wide' }, channelsTitle, channelList),
    webhookCard,
  ]);

  async function load(): Promise<void> {
    let overview: BotOverview;
    try {
      overview = await api<BotOverview>('dbd-bot');
    } catch (error) {
      frame.fail(error);
      return;
    }
    frame.show();
    replaceChildren(statusCard, ...botStatusContent(overview.status));
    replaceChildren(inviteList, ...botInviteRows(overview.invites, load));
    channelsTitle.textContent = `Channels (${String(overview.channels.length)})`;
    replaceChildren(channelList, ...botChannelRows(overview.channels, load));
    replaceChildren(webhookCard, ...webhookContent(overview.status));
  }

  return { element: frame.element, load };
}

function botStatusContent(status: BotStatus): Child[] {
  return [
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
      ? // A POST, so only this page can start the flow (the server checks Origin).
        h(
          'form',
          { attrs: { method: 'post', action: `${base}twitch-connect` } },
          h('button', {
            className: 'button button--small',
            text: status.chatSelfRefreshing ? 'Reconnect via Twitch' : 'Connect via Twitch',
            attrs: { type: 'submit' },
          }),
          h('span', {
            className: 'hint',
            text: `Sign in to Twitch as ${status.botName} when asked.`,
          }),
        )
      : h('span', {
          className: 'hint',
          text: 'Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to connect via Twitch.',
        }),
  ];
}

function botInviteRows(invites: readonly BotInvite[], reload: () => Promise<void>): Node[] {
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

function botChannelRows(channels: readonly BotChannel[], reload: () => Promise<void>): Node[] {
  if (channels.length === 0) {
    return [h('li', { className: 'empty', text: 'No channels connected yet.' })];
  }
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
        // Joining/leaving chat is asynchronous in the bot; give it a moment.
        window.setTimeout(() => void reload(), 1500);
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

function webhookContent(status: BotStatus): Child[] {
  const webhook = status.webhook;
  if (!webhook.enabled) {
    return [
      h('h3', { text: 'Webhook activity' }),
      h('p', {
        className: 'muted',
        text: 'EventSub webhooks are off; live status comes from polling.',
      }),
    ];
  }
  const events = webhook.recentEvents ?? [];
  return [
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
  ];
}

// --- Hues & Cues ------------------------------------------------------------------

const HUES_STATUS: Readonly<
  Record<HuesInvite['status'], [string, 'ok' | 'warn' | 'bad' | 'plain']>
> = {
  unused: ['Unused', 'ok'],
  used: ['Used', 'plain'],
  expired: ['Expired', 'bad'],
  revoked: ['Revoked', 'bad'],
};

function createHuesSection(): Section {
  const intro = h('p', { className: 'muted' });
  const reveal = h('div', { className: 'reveal', attrs: { hidden: '' } });
  const inviteList = h('ul', { className: 'list' });
  const usersTitle = h('h3');
  const userList = h('ul', { className: 'list' });
  const note = h('input', {
    attrs: {
      id: 'hues-note',
      maxlength: '100',
      placeholder: 'Who is it for? (optional)',
      autocomplete: 'off',
      'aria-label': 'Who the Hues & Cues invite is for',
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
        note.value = '';
        revealCode(
          reveal,
          code,
          'New Hues & Cues invite code — copy it now; it won’t be shown again:',
        );
        return load();
      })
      .catch((error: unknown) => {
        fail(error, 'Could not generate a code.');
      })
      .finally(() => {
        generate.disabled = false;
      });
  });

  const frame = sectionFrame('Hues & Cues', [
    h(
      'div',
      { className: 'card' },
      h('h3', { text: 'Invite codes' }),
      intro,
      form,
      reveal,
      inviteList,
    ),
    h('div', { className: 'card' }, usersTitle, userList),
  ]);

  async function load(): Promise<void> {
    let overview: HuesOverview;
    try {
      overview = await api<HuesOverview>('hues-and-cues');
    } catch (error) {
      frame.fail(error);
      return;
    }
    frame.show();
    intro.textContent = `Sign-up is invite-only. Each code works once and expires after ${String(overview.inviteTtlDays)} days. The full code is shown only once.`;
    replaceChildren(inviteList, ...huesInviteRows(overview.invites, load));
    usersTitle.textContent = `Users (${String(overview.users.length)})`;
    replaceChildren(userList, ...huesUserRows(overview.users));
  }

  return { element: frame.element, load };
}

function huesInviteRows(invites: readonly HuesInvite[], reload: () => Promise<void>): Node[] {
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
