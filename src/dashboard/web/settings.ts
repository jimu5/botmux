import { escapeHtml, t } from './ui.js';

interface DashboardSettings {
  publicReadOnly: boolean;
  openTerminalInFeishu: boolean;
}

let settings: DashboardSettings | null = null;
let loadError: string | null = null;
// 只读访客（无有效 token 进来的 public-read 连接）看得到设置值但不能改——
// 开关直接禁用并给提示，而不是点了 401 再回滚。
let canWrite = true;

function pageHtml(): string {
  return `<section class="page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">${t('nav.settings')}</p>
        <h1>${t('settings.title')}</h1>
        <p>${t('settings.subtitle')}</p>
      </div>
    </div>
    <div id="settings-body"></div>
  </section>`;
}

function renderSettingsBody(): string {
  if (loadError) {
    return `<p class="hint-warn">${t('settings.loadFailed')}: ${escapeHtml(loadError)}</p>`;
  }
  if (!settings) return `<p class="empty">${t('settings.loading')}</p>`;
  const dis = canWrite ? '' : 'disabled';
  return `<div class="settings-grid">
    <article class="bd-card settings-card">
      ${canWrite ? '' : `<p class="hint-warn">${t('settings.readOnlyVisitor')}</p>`}
      <section class="bd-section">
        <h3 class="bd-section-title">${t('settings.sectionAccess')}</h3>
        <label class="toggle-row">
          <input type="checkbox" data-setting="publicReadOnly" ${settings.publicReadOnly ? 'checked' : ''} ${dis}>
          <span class="switch" aria-hidden="true"></span>
          <span class="toggle-tx"><strong>${t('settings.publicReadOnly')}</strong>
          <small>${t('settings.publicReadOnlyHelp')}</small></span>
        </label>
      </section>
      <section class="bd-section">
        <h3 class="bd-section-title">${t('settings.sectionCards')}</h3>
        <label class="toggle-row">
          <input type="checkbox" data-setting="openTerminalInFeishu" ${settings.openTerminalInFeishu ? 'checked' : ''} ${dis}>
          <span class="switch" aria-hidden="true"></span>
          <span class="toggle-tx"><strong>${t('settings.openTerminalInFeishu')}</strong>
          <small>${t('settings.openTerminalInFeishuHelp')}</small></span>
        </label>
      </section>
      <div class="actions settings-actions">
        <span class="oncall-status" data-settings-status></span>
      </div>
    </article>
  </div>`;
}

async function fetchSettings(): Promise<void> {
  try {
    const r = await fetch('/api/settings');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      settings = null;
      loadError = body?.error ?? `HTTP ${r.status}`;
      return;
    }
    settings = {
      publicReadOnly: body.settings?.publicReadOnly === true,
      openTerminalInFeishu: body.settings?.openTerminalInFeishu === true,
    };
    canWrite = body.authed === true;
    loadError = null;
  } catch (e: any) {
    settings = null;
    loadError = e?.message ?? String(e);
  }
}

export async function renderSettingsPage(root: HTMLElement): Promise<void> {
  root.innerHTML = pageHtml();
  const bodyEl = root.querySelector<HTMLElement>('#settings-body')!;

  function rerender(): void {
    bodyEl.innerHTML = renderSettingsBody();
    wireSettings();
  }

  function statusEl(): HTMLElement | null {
    return bodyEl.querySelector<HTMLElement>('[data-settings-status]');
  }

  async function savePatch(patch: Partial<DashboardSettings>, input: HTMLInputElement): Promise<void> {
    if (!settings) return;
    const before = !input.checked;
    input.disabled = true;
    const st = statusEl();
    if (st) {
      st.textContent = t('settings.saving');
      st.className = 'oncall-status';
    }
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) throw new Error(body?.error ?? `HTTP ${r.status}`);
      settings = {
        publicReadOnly: body.settings?.publicReadOnly === true,
        openTerminalInFeishu: body.settings?.openTerminalInFeishu === true,
      };
      if (st) {
        st.textContent = t('settings.saved');
        st.classList.add('hint-ok');
      }
    } catch (e: any) {
      input.checked = before;
      if (st) {
        st.textContent = `${t('settings.saveFailed')}: ${e?.message ?? e}`;
        st.classList.add('hint-warn-inline');
      }
    } finally {
      input.disabled = false;
    }
  }

  function wireSettings(): void {
    bodyEl.querySelectorAll<HTMLInputElement>('input[data-setting]').forEach(input => {
      input.addEventListener('change', () => {
        const key = input.dataset.setting as keyof DashboardSettings;
        void savePatch({ [key]: input.checked }, input);
      });
    });
  }

  rerender();
  await fetchSettings();
  rerender();
}
