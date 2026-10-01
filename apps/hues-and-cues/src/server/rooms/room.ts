import type { Logger } from 'pino';
import type { ClientRole, HostCommand, ServerMessage } from '../../shared/protocol.js';
import { GameError } from '../game/errors.js';
import { GameEngine, type GuessOutcome } from '../game/game-engine.js';
import type { GameSnapshot } from '../game/snapshot.js';
import type { ChatMessage } from '../twitch/chat-client.js';
import { parseChatGuess } from '../twitch/guess-parser.js';

/** A connected browser, abstracted away from the transport. */
export interface RoomClient {
  readonly role: ClientRole;
  send(message: ServerMessage): void;
  /** Disconnects the client, e.g. when the room is deleted. */
  close(code: number, reason: string): void;
}

export interface RoomOptions {
  readonly id: string;
  readonly channel: string;
  readonly ownerId: number;
  readonly createdAt: number;
  readonly lastActiveAt: number;
  readonly snapshot?: GameSnapshot;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly random?: () => number;
  /** Minimum gap between state broadcasts triggered by chat, to bound fan-out. */
  readonly broadcastIntervalMs?: number;
  /** Called whenever durable state changes. */
  readonly onChange: (room: Room) => void;
}

/**
 * One streamer's game: the engine plus the browsers watching it.
 *
 * Host commands are applied and broadcast immediately. Chat guesses can
 * arrive in bursts of hundreds per second, so their broadcasts are coalesced.
 */
export class Room {
  public readonly id: string;
  public readonly channel: string;
  public readonly ownerId: number;
  public readonly createdAt: number;

  private readonly engine: GameEngine;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly broadcastIntervalMs: number;
  private readonly onChange: (room: Room) => void;
  private readonly clients = new Set<RoomClient>();

  private lastActive: number;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private lastBroadcastAt = 0;

  public constructor(options: RoomOptions) {
    this.id = options.id;
    this.channel = options.channel;
    this.ownerId = options.ownerId;
    this.createdAt = options.createdAt;
    this.lastActive = options.lastActiveAt;
    this.logger = options.logger.child({ room: options.id, channel: options.channel });
    this.now = options.now ?? Date.now;
    this.broadcastIntervalMs = options.broadcastIntervalMs ?? 250;
    this.onChange = options.onChange;
    this.engine = new GameEngine({
      channel: options.channel,
      now: this.now,
      ...(options.random ? { random: options.random } : {}),
      ...(options.snapshot ? { snapshot: options.snapshot } : {}),
    });
    // A deadline may have passed while the server was down.
    if (this.engine.expireIfDue()) {
      this.onChange(this);
    }
    this.armDeadline();
  }

  public get lastActiveAt(): number {
    return this.lastActive;
  }

  public get clientCount(): number {
    return this.clients.size;
  }

  public snapshot(): GameSnapshot {
    return this.engine.toSnapshot();
  }

  public attach(client: RoomClient): void {
    this.clients.add(client);
    this.touch();
    // Persist lastActiveAt, which drives ordering and retention pruning.
    this.onChange(this);
    this.sendState(client, this.now());
  }

  public detach(client: RoomClient): void {
    this.clients.delete(client);
  }

  /** Applies a host command. Throws {@link GameError} if it is not allowed now. */
  public execute(command: HostCommand): void {
    switch (command.type) {
      case 'drawCard':
        this.engine.drawCard();
        break;
      case 'selectTarget':
        this.engine.selectTarget(command.index);
        break;
      case 'giveClue':
        this.engine.giveClue(command.clue);
        break;
      case 'closeGuessing':
        this.engine.closeGuessing();
        break;
      case 'reveal':
        this.engine.reveal();
        break;
      case 'cancelRound':
        this.engine.cancelRound();
        break;
      case 'resetScores':
        this.engine.resetScores();
        break;
      case 'updateSettings':
        this.engine.updateSettings(stripUndefined(command.settings));
        break;
      case 'simulateGuess':
        this.recordGuess(
          this.engine.submitGuess({
            userId: `sim:${command.displayName.toLowerCase()}`,
            displayName: command.displayName,
            color: null,
            coord: command.coord,
          }),
        );
        return;
      default: {
        const exhaustive: never = command;
        throw new GameError('bad_request', `Unknown command ${JSON.stringify(exhaustive)}`);
      }
    }
    this.logger.info({ command: command.type, phase: this.engine.currentPhase }, 'Host command');
    this.commit();
  }

  /** Feeds a chat message from this room's channel into the game. */
  public handleChat(message: ChatMessage): void {
    if (this.engine.currentPhase !== 'guessing') return;
    // The broadcaster can see the target on the control page, so their guesses
    // don't count, unless the host turned that on for testing.
    if (
      !this.engine.currentSettings.allowBroadcasterGuesses &&
      message.login.toLowerCase() === this.channel.toLowerCase()
    ) {
      return;
    }
    const coord = parseChatGuess(message.text, this.engine.currentSettings.requireGuessCommand);
    if (coord === null) return;
    this.recordGuess(
      this.engine.submitGuess({
        userId: message.userId,
        displayName: message.displayName,
        color: message.color,
        coord,
      }),
    );
  }

  /** Disconnects every client (they then detach themselves). */
  public closeAll(code: number, reason: string): void {
    for (const client of [...this.clients]) client.close(code, reason);
  }

  public dispose(): void {
    if (this.deadlineTimer !== null) clearTimeout(this.deadlineTimer);
    if (this.broadcastTimer !== null) clearTimeout(this.broadcastTimer);
    this.deadlineTimer = null;
    this.broadcastTimer = null;
    this.clients.clear();
  }

  /** Pushes current state to everyone, e.g. after the chat connection status changes. */
  public broadcastNow(): void {
    if (this.broadcastTimer !== null) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    const now = this.now();
    this.lastBroadcastAt = now;
    // Build each role's message once, however many clients are attached.
    const messages = new Map<ClientRole, ServerMessage>();
    for (const client of this.clients) {
      let message = messages.get(client.role);
      if (!message) {
        message = this.stateMessage(client.role, now);
        messages.set(client.role, message);
      }
      client.send(message);
    }
  }

  public sendToAll(message: ServerMessage): void {
    for (const client of this.clients) client.send(message);
  }

  private recordGuess(outcome: GuessOutcome): void {
    if (outcome === 'accepted' || outcome === 'updated') {
      this.touch();
      this.onChange(this);
      this.scheduleBroadcast();
    }
  }

  private commit(): void {
    this.touch();
    this.armDeadline();
    this.onChange(this);
    this.broadcastNow();
  }

  private scheduleBroadcast(): void {
    if (this.broadcastTimer !== null) return;
    const wait = Math.max(0, this.lastBroadcastAt + this.broadcastIntervalMs - this.now());
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcastNow();
    }, wait);
  }

  private armDeadline(): void {
    if (this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
    const deadline = this.engine.deadline;
    if (deadline === null) return;
    this.deadlineTimer = setTimeout(
      () => {
        this.deadlineTimer = null;
        if (this.engine.expireIfDue()) {
          this.logger.info({ phase: this.engine.currentPhase }, 'Guessing window closed');
          this.commit();
        } else {
          this.armDeadline();
        }
      },
      Math.max(0, deadline - this.now()),
    );
  }

  /** Sends the current state to one client (e.g. after it skipped updates). */
  public resendState(client: RoomClient): void {
    if (this.clients.has(client)) this.sendState(client, this.now());
  }

  private sendState(client: RoomClient, now: number): void {
    client.send(this.stateMessage(client.role, now));
  }

  private stateMessage(role: ClientRole, serverTime: number): ServerMessage {
    return role === 'host'
      ? { type: 'state', role: 'host', state: this.engine.getHostState(), serverTime }
      : { type: 'state', role: 'overlay', state: this.engine.getPublicState(), serverTime };
  }

  private touch(): void {
    this.lastActive = this.now();
  }
}

function stripUndefined<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
