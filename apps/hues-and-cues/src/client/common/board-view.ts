import {
  BOARD_COLUMNS,
  BOARD_ROWS,
  type Coord,
  coordKey,
  formatCoord,
  ROW_LABELS,
} from '../../shared/board.js';
import { cellColor, contrastingTextColor } from '../../shared/color.js';
import { h } from './dom.js';

export interface BoardViewOptions {
  /** Called when a cell is clicked; makes cells focusable buttons. */
  readonly onCellClick?: (coord: Coord) => void;
}

export interface BoardRenderModel {
  readonly cellCounts: readonly (readonly [number, number])[];
  /** Cells to outline as card options (host only). */
  readonly card?: readonly Coord[] | null;
  /** The secret target (host) or the revealed target (everyone). */
  readonly target?: Coord | null;
  /** Draw the scoring frames around the target. */
  readonly showFrames?: boolean;
}

/**
 * Renders the 30×16 colour board. Cells are created once and updated in
 * place, so re-rendering on every state message is cheap.
 */
export class BoardView {
  public readonly element: HTMLElement;
  private readonly cells: HTMLElement[] = [];
  private readonly frameLayer: HTMLElement[] = [];

  public constructor(options: BoardViewOptions = {}) {
    this.element = h('div', {
      className: 'board',
      attrs: { role: 'grid', 'aria-label': 'Colour board' },
    });
    this.element.style.setProperty('--columns', String(BOARD_COLUMNS));
    this.element.style.setProperty('--rows', String(BOARD_ROWS));

    // Every item is placed explicitly: mixing auto-placed and row-pinned items
    // lets CSS grid shuffle the labels.
    for (let col = 0; col < BOARD_COLUMNS; col += 1) {
      const label = h('div', { className: 'board__label', text: String(col + 1) });
      label.style.gridRow = '1';
      label.style.gridColumn = String(col + 2);
      this.element.append(label);
    }
    for (let row = 0; row < BOARD_ROWS; row += 1) {
      const label = h('div', { className: 'board__label', text: ROW_LABELS.charAt(row) });
      label.style.gridRow = String(row + 2);
      label.style.gridColumn = '1';
      this.element.append(label);
      for (let col = 0; col < BOARD_COLUMNS; col += 1) {
        const coord = { row, col };
        const background = cellColor(coord);
        const clickable = options.onCellClick !== undefined;
        const cell = h(clickable ? 'button' : 'div', {
          className: 'board__cell',
          style: { background, color: contrastingTextColor(background) },
          attrs: {
            role: 'gridcell',
            'aria-label': formatCoord(coord),
            title: formatCoord(coord),
            ...(clickable ? { type: 'button' } : {}),
          },
          ...(options.onCellClick ? { on: { click: () => options.onCellClick?.(coord) } } : {}),
        });
        cell.style.gridRow = String(row + 2);
        cell.style.gridColumn = String(col + 2);
        this.cells.push(cell);
        this.element.append(cell);
      }
    }
  }

  public render(model: BoardRenderModel): void {
    const counts = new Map(model.cellCounts);
    const cardKeys = new Map((model.card ?? []).map((coord, index) => [coordKey(coord), index]));
    const targetKey = model.target ? coordKey(model.target) : null;

    this.cells.forEach((cell, key) => {
      const count = counts.get(key) ?? 0;
      cell.classList.toggle('board__cell--guessed', count > 0);
      cell.classList.toggle('board__cell--target', key === targetKey);
      const cardIndex = cardKeys.get(key);
      cell.classList.toggle('board__cell--card', cardIndex !== undefined);
      cell.textContent =
        count > 1 ? String(count) : cardIndex !== undefined ? String(cardIndex + 1) : '';
    });

    for (const frame of this.frameLayer) frame.remove();
    this.frameLayer.length = 0;
    if (model.target && model.showFrames === true) {
      for (const radius of [2, 1]) {
        this.frameLayer.push(this.createFrame(model.target, radius));
      }
    }
  }

  private createFrame(target: Coord, radius: number): HTMLElement {
    const rowStart = Math.max(0, target.row - radius);
    const rowEnd = Math.min(BOARD_ROWS - 1, target.row + radius);
    const colStart = Math.max(0, target.col - radius);
    const colEnd = Math.min(BOARD_COLUMNS - 1, target.col + radius);
    const frame = h('div', {
      className: `board__frame board__frame--r${radius}`,
      attrs: { 'aria-hidden': 'true' },
    });
    frame.style.gridRow = `${rowStart + 2} / ${rowEnd + 3}`;
    frame.style.gridColumn = `${colStart + 2} / ${colEnd + 3}`;
    this.element.append(frame);
    return frame;
  }
}
