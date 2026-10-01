/**
 * Tiny DOM helpers. Everything goes through `textContent` — chat-supplied
 * strings (display names, clues) are never interpreted as HTML.
 */

export type Child = Node | string | number | null | undefined | false;

export interface ElementProps {
  readonly className?: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly dataset?: Readonly<Record<string, string>>;
  readonly style?: Partial<Readonly<Record<'background' | 'color' | 'borderColor', string>>>;
  readonly on?: Partial<{
    readonly [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void;
  }>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.className !== undefined) element.className = props.className;
  if (props.text !== undefined) element.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) element.setAttribute(name, value);
  Object.assign(element.dataset, props.dataset ?? {});
  Object.assign(element.style, props.style ?? {});
  for (const [event, handler] of Object.entries(props.on ?? {})) {
    element.addEventListener(event, handler as EventListener);
  }
  append(element, ...children);
  return element;
}

export function append(parent: Element, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : String(child));
  }
}

/** Replaces all children of `parent`. */
export function replaceChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, ...children);
}

export function requireElement<T extends Element>(selector: string, type: new () => T): T {
  const element = document.querySelector(selector);
  if (!(element instanceof type)) {
    throw new Error(`Missing element ${selector}`);
  }
  return element;
}

export function formatSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}:${String(seconds % 60).padStart(2, '0')}` : String(seconds);
}
