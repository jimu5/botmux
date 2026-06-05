// Dashboard SPA entry: hash router + bootstrap + online indicator.
import { bootstrap, store } from './store.js';
import { renderOverviewPage } from './overview.js';
import { renderSessionsPage } from './sessions.js';
import { renderSchedulesPage } from './schedules.js';
import { renderGroupsPage } from './groups.js';
import { renderBotDefaultsPage } from './bot-defaults.js';
import { renderRolesPage } from './roles.js';
import { renderTeamFederationPage, renderTeamManagePage } from './team-federation.js';
import { renderConnectorsPage } from './connectors.js';
import { renderSettingsPage } from './settings.js';
import { renderWorkflowsPage } from './workflows.js';
import { renderWorkflowCatalogPage } from './workflow-catalog.js';
import { wireBotOnboardingButton } from './bot-onboarding.js';
import { attentionReason, botDisplayName, escapeHtml, loadNameMaps, relTime, t, ui } from './ui.js';
import type { DashboardLocale } from './i18n.js';
import type { ThemeMode } from './preferences.js';

const root = document.getElementById('root')!;

// ── Auth-expiry overlay ──────────────────────────────────────────────────────
// Any 401 from an API call means the dashboard token was rotated (a new access
// link was generated). Show a blocking overlay so the user knows to switch tabs.
let _expiredShown = false;
export function showAuthExpiredOverlay(): void {
  if (_expiredShown) return;
  _expiredShown = true;
  const el = document.createElement('div');
  el.id = 'auth-expired-overlay';
  el.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;' +
    'align-items:center;justify-content:center;z-index:9999';
  el.innerHTML =
    '<div style="background:var(--card,#fff);color:var(--text,#1f2329);border-radius:12px;' +
    'padding:36px 40px;max-width:460px;width:90vw;text-align:center;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.35)">' +
    '<h2 style="margin:0 0 14px;font-size:19px">访问链接已失效</h2>' +
    '<p style="margin:0 0 24px;line-height:1.7;color:var(--muted,#8f959e);font-size:14px">' +
    '当前链接/访问已失效，请使用最新授权链接重新进入。<br>最好关闭当前页。</p>' +
    '<button onclick="window.close()" ' +
    'style="padding:8px 22px;background:var(--accent,#3370ff);color:#fff;border:none;' +
    'border-radius:8px;cursor:pointer;font-size:14px">关闭此页</button>' +
    '</div>';
  document.body.appendChild(el);
}

// ── Read-only toast (write attempt without a valid token) ───────────────────
// In public read-only mode browsing GETs never 401, but a write action
// (close session, cancel run, …) without the active token does. That's not
// "your link died" — it's "you're a read-only visitor", so show a transient
// toast instead of the blocking overlay.
let _roToastTimer: number | undefined;
export function showReadOnlyToast(): void {
  let el = document.getElementById('readonly-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'readonly-toast';
    el.style.cssText =
      'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;' +
      'background:var(--fg,#1f2329);color:var(--bg,#fff);padding:10px 18px;' +
      'border-radius:8px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.25)';
    document.body.appendChild(el);
  }
  el.textContent = '当前是只读访问，此操作需要授权链接（运行 botmux dashboard 获取）';
  el.style.display = 'block';
  if (_roToastTimer) window.clearTimeout(_roToastTimer);
  _roToastTimer = window.setTimeout(() => { el!.style.display = 'none'; }, 4000);
}

// Patch the global fetch to route 401s: a read (GET/HEAD) 401 means the token
// was rotated while this tab was open (only possible when public read-only
// mode is off) → blocking overlay; a write 401 means "read-only visitor" →
// transient toast.
const _origFetch = window.fetch.bind(window);
window.fetch = async function patchedFetch(
  ...args: Parameters<typeof fetch>
): ReturnType<typeof fetch> {
  const res = await _origFetch(...args);
  if (res.status === 401) {
    const method = (args[1]?.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') showAuthExpiredOverlay();
    else showReadOnlyToast();
  }
  return res;
};

// ── 全局 attention strip ─────────────────────────────────────────────────────
// 「需要你」是全局最高优先级：不管在哪个页面，待处理数和最久等待项都常驻
// 顶部一条琥珀色 strip，点「立即处理」跳到会话页（needs-you 列置顶）。
let lastStripHtml = '';
function paintAttentionStrip(): void {
  const el = document.getElementById('attention-strip');
  if (!el) return;
  const pending = [...store.sessions.values()]
    .map(s => ({ s, reason: attentionReason(s) }))
    .filter((x): x is { s: any; reason: string } => !!x.reason)
    .sort((a, b) => Number(a.s.lastMessageAt ?? 0) - Number(b.s.lastMessageAt ?? 0));
  if (pending.length === 0) {
    el.hidden = true;
    el.innerHTML = '';
    lastStripHtml = '';
    return;
  }
  const longest = pending[0];
  const html = `
    <span class="attention-strip-ic" aria-hidden="true">!</span>
    <b>${escapeHtml(t('strip.pending', { count: pending.length }))}</b>
    <span class="attention-strip-longest">${escapeHtml(t('strip.longest', {
      time: relTime(longest.s.lastMessageAt),
      bot: botDisplayName(longest.s),
      reason: longest.reason,
    }))}</span>
    <a class="attention-strip-go" href="#/sessions">${escapeHtml(t('strip.handle'))}</a>`;
  el.hidden = false;
  // 内容没变就不重写 — innerHTML 重建会把 strip-pulse 动画打回起点（视觉跳变）
  if (html === lastStripHtml) return;
  lastStripHtml = html;
  el.innerHTML = html;
}
store.on(paintAttentionStrip);
// bot 友好名异步解析回来后刷一次 strip（页面级重绘由各 mount 自己处理）
void loadNameMaps().then(paintAttentionStrip);

// Pages that own a polling loop / cleanup return a disposer; we run it
// on the next route switch so timers don't leak across navigations.
let pageDispose: (() => void) | null = null;

function route() {
  if (pageDispose) { pageDispose(); pageDispose = null; }
  const hash = location.hash || '#/';
  // Catalog is a sub-route under Workflows now (`#/workflows/catalog[/<id>]`)
  // so the top nav has a single "Workflows (beta)" entry.  Legacy
  // `#/workflows-catalog[*]` URLs are kept working for any external links
  // that may have been pasted before the move.
  if (
    hash.startsWith('#/workflows/catalog') ||
    hash.startsWith('#/workflows-catalog')
  ) {
    pageDispose = renderWorkflowCatalogPage(root);
  } else if (hash.startsWith('#/workflows')) pageDispose = renderWorkflowsPage(root);
  else if (hash.startsWith('#/groups')) renderGroupsPage(root);
  else if (hash.startsWith('#/settings')) void renderSettingsPage(root);
  else if (hash.startsWith('#/bot-defaults')) renderBotDefaultsPage(root);
  else if (hash.startsWith('#/connectors')) renderConnectorsPage(root);
  else if (hash.startsWith('#/team/manage')) renderTeamManagePage(root);
  else if (hash.startsWith('#/team')) renderTeamFederationPage(root);
  else if (hash.startsWith('#/roles')) renderRolesPage(root);
  else if (hash.startsWith('#/schedules')) renderSchedulesPage(root);
  else if (hash.startsWith('#/sessions')) renderSessionsPage(root);
  else void renderOverviewPage(root);

  // active nav highlighting
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.sidebar-nav a')) {
    const href = a.getAttribute('href') ?? '#/';
    a.classList.toggle('active', href === (hash || '#/'));
  }
}

const statusEl = document.getElementById('status');
function paintStatus() {
  if (!statusEl) return;
  statusEl.textContent = store.online ? t('status.live') : t('status.disconnected');
  statusEl.className = 'connection-status ' + (store.online ? 'online' : 'offline');
}
store.on(paintStatus);

function paintChrome() {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n ?? '');
  });
  document.querySelectorAll<HTMLButtonElement>('[data-locale]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.locale === ui.locale);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-theme-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeMode === ui.themeMode);
  });
  paintStatus();
}

function wireChromeControls() {
  document.querySelectorAll<HTMLButtonElement>('[data-locale]').forEach(btn => {
    btn.onclick = () => ui.setLocale(btn.dataset.locale as DashboardLocale);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-theme-mode]').forEach(btn => {
    btn.onclick = () => ui.setThemeMode(btn.dataset.themeMode as ThemeMode);
  });
}

// esbuild's IIFE bundle does not support top-level await — use an async IIFE.
void (async () => {
  ui.init();
  wireChromeControls();
  wireBotOnboardingButton();
  ui.on(() => {
    paintChrome();
    paintAttentionStrip();
    route();
  });
  paintChrome();
  paintAttentionStrip();
  try {
    await bootstrap();
  } catch (err) {
    console.error('botmux dashboard bootstrap failed', err);
    store.setOnline(false);
  }
  window.addEventListener('hashchange', route);
  route();
})();
