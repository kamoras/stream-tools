import { formatCoord } from '../../shared/board.js';
import { cellColor, readableOnDark } from '../../shared/color.js';
import type { PublicGameState, PublicGuess, RoundResult } from '../../shared/protocol.js';
import { BoardView } from '../common/board-view.js';
import { formatSeconds, h, replaceChildren, requireElement } from '../common/dom.js';
import { GameSocket, ServerClock } from '../common/game-socket.js';

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;
const FEED_LENGTH = 8;
const LEADERBOARD_LENGTH = 8;

const params = new URLSearchParams(window.location.search);
const roomId = params.get('room') ?? '';
const stage = requireElement('#stage', HTMLElement);
document.body.classList.toggle('overlay--solid', params.get('bg') === 'solid');

/** Scales the fixed 1920×1080 stage to whatever size the browser source is. */
function fitStage(): void {
  const scale = Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT);
  stage.style.transform = `scale(${String(scale)})`;
}
window.addEventListener('resize', fitStage);
fitStage();

if (roomId === '') {
  replaceChildren(
    stage,
    h(
      'div',
      { className: 'notice' },
      h('h1', { text: 'Overlay link is missing its room' }),
      h('p', { text: 'Copy the overlay URL from the control page into your OBS browser source.' }),
    ),
  );
} else {
  startOverlay(roomId);
}

function startOverlay(room: string): void {
  const clock = new ServerClock();
  const board = new BoardView();

  const title = h('div', { className: 'hud__title' });
  const banner = h('div', { className: 'banner' });
  const timer = h('div', { className: 'timer', attrs: { hidden: '' } });
  const timerFill = h('div', { className: 'timer__fill' });
  const timerText = h('div', { className: 'timer__text' });
  timer.append(timerFill, timerText);
  const status = h('div', { className: 'status-pill', attrs: { hidden: '' } });
  const leaderboard = h('ol', { className: 'leaderboard' });
  const feed = h('ul', { className: 'feed' });
  const results = h('section', { className: 'panel results', attrs: { hidden: '' } });
  const feedPanel = h('section', { className: 'panel' }, h('h2', { text: 'Latest guesses' }), feed);

  replaceChildren(
    stage,
    h('header', { className: 'hud' }, title, status),
    h('section', { className: 'banner-row' }, banner, timer),
    h('section', { className: 'board-wrap panel' }, board.element),
    h(
      'aside',
      { className: 'sidebar' },
      results,
      h('section', { className: 'panel' }, h('h2', { text: 'Leaderboard' }), leaderboard),
      feedPanel,
    ),
  );

  let current: PublicGameState | null = null;
  let chatConnected = true;
  let socketHealthy = false;

  const renderStatus = (): void => {
    const problem = !socketHealthy
      ? 'Reconnecting to game server…'
      : !chatConnected
        ? 'Reconnecting to Twitch chat…'
        : null;
    status.hidden = problem === null;
    status.textContent = problem ?? '';
  };

  const renderTimer = (): void => {
    const deadline = current?.deadline ?? null;
    const duration = current?.settings.guessDurationSeconds ?? 0;
    if (deadline === null || duration <= 0) {
      timer.hidden = true;
      return;
    }
    const remaining = Math.max(0, clock.secondsUntil(deadline));
    timer.hidden = false;
    timer.classList.toggle('timer--urgent', remaining <= 10);
    timerFill.style.width = `${String(Math.min(100, (remaining / duration) * 100))}%`;
    timerText.textContent = formatSeconds(remaining);
  };

  const render = (state: PublicGameState): void => {
    current = state;
    title.textContent =
      state.roundNumber > 0 ? `Hues & Cues · Round ${String(state.roundNumber)}` : 'Hues & Cues';
    replaceChildren(banner, ...bannerContent(state));

    const revealed = state.phase === 'reveal' ? state.lastResult : null;
    board.render({
      cellCounts: state.cellCounts,
      target: revealed?.target ?? null,
      showFrames: revealed !== null,
    });

    results.hidden = revealed === null;
    feedPanel.hidden = revealed !== null;
    if (revealed) replaceChildren(results, ...resultsContent(revealed));

    replaceChildren(
      leaderboard,
      ...(state.leaderboard.length === 0
        ? [h('li', { className: 'empty', text: 'No points yet — be the first!' })]
        : state.leaderboard.slice(0, LEADERBOARD_LENGTH).map((player, index) =>
            h(
              'li',
              {},
              h('span', { className: 'rank', text: String(index + 1) }),
              h('span', {
                className: 'name',
                text: player.displayName,
                style: player.color ? { color: readableOnDark(player.color) } : {},
              }),
              h('span', { className: 'score', text: String(player.score) }),
            ),
          )),
    );

    const latest = [...state.guesses].slice(-FEED_LENGTH).reverse();
    replaceChildren(
      feed,
      ...(latest.length === 0
        ? [
            h('li', {
              className: 'empty',
              text: state.phase === 'guessing' ? 'Waiting for guesses…' : '—',
            }),
          ]
        : latest.map((guess) => feedItem(guess))),
    );
    renderTimer();
  };

  const socket = new GameSocket<PublicGameState>(
    { type: 'hello', role: 'overlay', roomId: room },
    {
      onState: (state, serverTime) => {
        clock.sync(serverTime);
        render(state);
      },
      onStatus: (connection, detail) => {
        socketHealthy = connection === 'open';
        if (connection === 'failed') {
          replaceChildren(
            stage,
            h('div', { className: 'notice' }, h('h1', { text: detail ?? 'Disconnected' })),
          );
          return;
        }
        renderStatus();
      },
      onChatStatus: (connected) => {
        chatConnected = connected;
        renderStatus();
      },
    },
  );
  socket.connect();
  window.setInterval(renderTimer, 250);
}

function bannerContent(state: PublicGameState): (Node | string)[] {
  const clue = (text: string, label: string): Node =>
    h(
      'div',
      { className: 'clue' },
      h('span', { className: 'clue__label', text: label }),
      h('span', { className: 'clue__text', text }),
    );

  switch (state.phase) {
    case 'idle':
      return [h('div', { className: 'banner__message', text: 'Waiting for the next round…' })];
    case 'picking':
      return [
        h('div', { className: 'banner__message', text: `${state.channel} is choosing a colour…` }),
      ];
    case 'guessing': {
      const clues = state.clues.map((text, index) => clue(text, `Clue ${String(index + 1)}`));
      const how = state.settings.requireGuessCommand
        ? 'Type !guess F12 in chat'
        : 'Type a square like F12 in chat';
      return [
        ...clues,
        h('div', {
          className: 'banner__hint',
          text: `${how} · ${String(state.totalGuesses)} guesses`,
        }),
      ];
    }
    case 'intermission':
      return [
        ...state.clues.map((text, index) => clue(text, `Clue ${String(index + 1)}`)),
        h('div', { className: 'banner__message', text: 'Second clue coming up…' }),
      ];
    case 'reveal':
      return state.clues.map((text, index) => clue(text, `Clue ${String(index + 1)}`));
  }
}

function resultsContent(result: RoundResult): Node[] {
  const top = result.awards.slice(0, 5);
  return [
    h('h2', { text: `Round ${String(result.roundNumber)} results` }),
    h(
      'div',
      { className: 'results__target' },
      h('span', { className: 'swatch', style: { background: cellColor(result.target) } }),
      h('span', { text: `The colour was ${formatCoord(result.target)}` }),
    ),
    h(
      'ol',
      { className: 'results__list' },
      ...(top.length === 0
        ? [h('li', { className: 'empty', text: 'Nobody scored this round!' })]
        : top.map((award) =>
            h(
              'li',
              {},
              h('span', {
                className: 'name',
                text: award.displayName,
                style: award.color ? { color: readableOnDark(award.color) } : {},
              }),
              h('span', { className: 'score', text: `+${String(award.points)}` }),
            ),
          )),
    ),
    h('div', {
      className: 'results__meta',
      text: `${String(result.totalGuessers)} players · streamer +${String(result.hostPoints)}`,
    }),
  ];
}

function feedItem(guess: PublicGuess): Node {
  return h(
    'li',
    {},
    h('span', { className: 'swatch swatch--small', style: { background: cellColor(guess.coord) } }),
    h('span', {
      className: 'name',
      text: guess.displayName,
      style: guess.color ? { color: readableOnDark(guess.color) } : {},
    }),
    h('span', { className: 'coord', text: formatCoord(guess.coord) }),
  );
}
