import { h, requireElement } from '../common/dom.js';

const TOAST_MS = 4000;

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const container = requireElement('#toasts', HTMLElement);
  const element = h('div', { className: `toast toast--${kind}`, text: message });
  container.append(element);
  window.setTimeout(() => {
    element.classList.add('toast--leaving');
    window.setTimeout(() => {
      element.remove();
    }, 300);
  }, TOAST_MS);
}
