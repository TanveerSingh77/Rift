import { $, $$, markActiveNav, renderSetupStatus } from './common.js';

/**
 * Client-side navigation.
 *
 * A normal page load destroys the document, and with it the playing <audio>
 * element. To let music keep playing while the user browses the app, links
 * between app pages are followed here instead: the <main> content is swapped and
 * the target page's module is imported, but the document - and the player - stay
 * alive. A hard load still works normally if JavaScript or the fetch fails.
 */

const cleanups = [];
let currentPage = null;
let navigating = false;

/** Page modules register teardown so nothing leaks between navigations. */
export function onCleanup(fn) {
  cleanups.push(fn);
}

function runCleanups() {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try {
      fn();
    } catch (err) {
      console.error('[nav] cleanup failed', err);
    }
  }
}

// Exposed so hard-load paths can also tear down (e.g. bfcache restores).
window.__vgTeardown = runCleanups;

function samePage(href) {
  return new URL(href, location.href).pathname === location.pathname;
}

function pageModuleOf(doc) {
  // app.js is the shell itself and must never be re-imported, so the page's own
  // entry module is the first one that is not the shell.
  const scripts = [...doc.querySelectorAll('script[type="module"][src]')];
  const script = scripts.find((s) => !s.getAttribute('src').endsWith('/app.js')) || scripts[0];
  return script ? script.getAttribute('src') : null;
}

async function navigate(href, { push = true } = {}) {
  if (navigating) return;
  if (samePage(href)) return;
  navigating = true;
  try {
    const res = await fetch(href, { headers: { 'X-Requested-With': 'fetch' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const nextMain = doc.querySelector('main.main');
    const curMain = $('main.main');
    if (!nextMain || !curMain) throw new Error('page has no <main>');

    runCleanups();

    if (push) history.pushState({ page: href }, '', href);
    document.title = doc.title;
    curMain.className = nextMain.className;
    curMain.innerHTML = nextMain.innerHTML;

    currentPage = href;
    markActiveNav();
    refreshSidebarStatus();

    const src = pageModuleOf(doc);
    if (src) {
      // Cache-bust so the module body runs again for the new page.
      await import(/* @vite-ignore */ `${src}?t=${Date.now()}`);
    }
    window.scrollTo(0, 0);
  } catch (err) {
    console.warn('[nav] soft navigation failed, falling back to full load:', err);
    window.location.href = href;
  } finally {
    navigating = false;
  }
}

document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const link = e.target.closest('a');
  if (!link) return;
  const href = link.getAttribute('href');
  if (!href || link.target === '_blank' || link.hasAttribute('download')) return;
  if (!href.endsWith('.html') && href !== '/') return;
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) return;
  e.preventDefault();
  navigate(url.pathname);
});

window.addEventListener('popstate', () => {
  const href = location.pathname.endsWith('.html') ? location.pathname : '/index.html';
  if (href !== currentPage) navigate(href, { push: false });
});

// The sidebar is shared by every page, so its status line is refreshed after a
// swap as well.
function refreshSidebarStatus() {
  renderSetupStatus().catch(() => {});
}

currentPage = location.pathname.endsWith('.html') ? location.pathname : '/index.html';
markActiveNav();
refreshSidebarStatus();