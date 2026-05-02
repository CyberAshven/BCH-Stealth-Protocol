// @ts-nocheck
import { navigate } from '../router.js';

export const id = 'elon';
export const title = 'Elon';
export const icon = 'E';

let _container: HTMLElement | null = null;

export function mount(container: HTMLElement) {
  _container = container;
  _container.innerHTML = `
  <div style="padding:32px 40px">
    <div style="background:var(--dt-surface,#fff);border:1px solid var(--dt-border,#e2e8f0);border-radius:14px;padding:20px">
      <div style="font-size:18px;font-weight:700;color:var(--dt-text,#1a1a2e);margin-bottom:6px">Elon</div>
      <div style="font-size:13px;color:var(--dt-text-secondary,#64748b);margin-bottom:14px">This module is currently unavailable in this build.</div>
      <button id="elon-back-dashboard" style="padding:8px 12px;border:1px solid #0AC18E33;border-radius:8px;background:transparent;color:#0AC18E;cursor:pointer;font-weight:600;font-size:13px">Back to Dashboard</button>
    </div>
  </div>`;
  document.getElementById('elon-back-dashboard')?.addEventListener('click', () => navigate('dashboard'));
}

export function unmount() {
  if (_container) _container.innerHTML = '';
  _container = null;
}
