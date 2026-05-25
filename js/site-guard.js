/**
 * site-guard.js
 * Checks site publish status. On pages that include github-storage.js,
 * uses ghStorage.getSiteStatus() (which handles localhost vs. production).
 * Otherwise uses the GitHub Contents API directly (always fresh, no CDN cache).
 * Include on every public page AFTER github-storage.js (if present).
 */
(function() {
    var OWNER        = 'bogia84';
    var REPO         = 'aesthetic-legacy';
    var STATUS_PATH  = 'data/site-status.json';
    var CONTENTS_URL = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + STATUS_PATH + '?ref=main';

    // 30-second sessionStorage cache so status changes reach visitors within 30s
    var CACHE_KEY = 'sgStatus';
    var CACHE_TTL = 30 * 1000;

    function getCachedStatus() {
        try {
            var raw = sessionStorage.getItem(CACHE_KEY);
            if (!raw) return null;
            var entry = JSON.parse(raw);
            if (Date.now() - entry.ts > CACHE_TTL) return null;
            return entry.published;
        } catch(e) { return null; }
    }

    function setCachedStatus(published) {
        try {
            sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), published: published }));
        } catch(e) {}
    }

    function showMaintenance() {
        if (document.getElementById('site-maintenance')) return;
        var overlay = document.createElement('div');
        overlay.id = 'site-maintenance';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0a0a0a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;font-family:Manrope,sans-serif';
        overlay.innerHTML =
            '<svg width="64" height="60" viewBox="0 0 30 28" fill="none" xmlns="http://www.w3.org/2000/svg">' +
              '<path d="M13.4007 7.72751H18.9762V0H10.833L13.4007 7.72751Z" fill="#fff"/>' +
              '<path d="M5.6 27.9999L0 17.3379H18.9764V27.9999H5.6Z" fill="#fff"/>' +
              '<path d="M29.6386 22.3755L18.9766 28V0H29.6386V22.3755Z" fill="url(#sg_grad)"/>' +
              '<defs><linearGradient id="sg_grad" x1="23.6961" y1="28" x2="23.6961" y2="0" gradientUnits="userSpaceOnUse">' +
              '<stop stop-color="#EC262D"/><stop offset="1" stop-color="#F57B7F"/></linearGradient></defs></svg>' +
            '<div style="color:#fff;font-weight:900;font-size:0.95rem;letter-spacing:0.18em;text-transform:uppercase;">Aesthetic Legacy</div>' +
            '<div style="width:36px;height:1px;background:rgba(255,255,255,0.15);"></div>' +
            '<p style="color:rgba(255,255,255,0.5);font-size:0.85rem;text-align:center;max-width:300px;line-height:1.8;margin:0;">' +
              'Page is not available at the moment,<br>please come back later</p>';
        if (document.body) {
            document.body.appendChild(overlay);
        } else {
            document.addEventListener('DOMContentLoaded', function() { document.body.appendChild(overlay); });
        }
    }

    function applyStatus(published) {
        setCachedStatus(published);
        if (published === false) showMaintenance();
    }

    // Sync check from short-TTL cache (instant on repeated navigation)
    var cached = getCachedStatus();
    if (cached !== null) {
        if (cached === false) showMaintenance();
        return;
    }

    // Use ghStorage.getSiteStatus() when available (handles localhost vs. production)
    if (window.ghStorage && typeof window.ghStorage.getSiteStatus === 'function') {
        window.ghStorage.getSiteStatus()
            .then(function(s) { applyStatus(!s || s.published !== false); })
            .catch(function() { applyStatus(true); });
        return;
    }

    // Fallback: GitHub Contents API (no CDN cache, always fresh)
    fetch(CONTENTS_URL, {
        headers: {
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        },
        cache: 'no-store'
    })
    .then(function(res) { return res.ok ? res.json() : null; })
    .then(function(data) {
        if (!data || !data.content) { applyStatus(true); return; }
        try {
            var status = JSON.parse(atob(data.content.replace(/\n/g, '')));
            applyStatus(status.published !== false);
        } catch(e) { applyStatus(true); }
    })
    .catch(function() { applyStatus(true); }); // fail open
})();
