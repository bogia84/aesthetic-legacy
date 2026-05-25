/**
 * site-guard.js
 * Checks sitePublished status from home-layout.json and shows a
 * maintenance overlay if the site is set to unpublished by the CMS.
 * Include on every public page after github-storage.js (if present).
 */
(function() {
    var CACHE_KEY = 'alCache_data/home-layout.json';
    var CACHE_TTL = 5 * 60 * 1000;
    var RAW_URL   = 'https://raw.githubusercontent.com/bogia84/aesthetic-legacy/main/data/home-layout.json';

    /* ---- Shared sessionStorage cache (same format as github-storage.js) ---- */
    function getCachedLayout() {
        try {
            var raw = sessionStorage.getItem(CACHE_KEY);
            if (!raw) return null;
            var entry = JSON.parse(raw);
            if (Date.now() - entry.ts > CACHE_TTL) return null;
            return entry.data;
        } catch(e) { return null; }
    }

    function setCachedLayout(data) {
        try {
            sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data }));
        } catch(e) {}
    }

    /* ---- Maintenance overlay ---- */
    function showMaintenance() {
        if (document.getElementById('site-maintenance')) return;
        var overlay = document.createElement('div');
        overlay.id = 'site-maintenance';
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:99999',
            'background:#0a0a0a',
            'display:flex', 'flex-direction:column',
            'align-items:center', 'justify-content:center',
            'gap:20px',
            'font-family:Manrope,sans-serif'
        ].join(';');
        overlay.innerHTML =
            '<svg width="64" height="60" viewBox="0 0 30 28" fill="none" xmlns="http://www.w3.org/2000/svg">' +
              '<path d="M13.4007 7.72751H18.9762V0H10.833L13.4007 7.72751Z" fill="#fff"/>' +
              '<path d="M5.6 27.9999L0 17.3379H18.9764V27.9999H5.6Z" fill="#fff"/>' +
              '<path d="M29.6386 22.3755L18.9766 28V0H29.6386V22.3755Z" fill="url(#sg_grad)"/>' +
              '<defs><linearGradient id="sg_grad" x1="23.6961" y1="28" x2="23.6961" y2="0" gradientUnits="userSpaceOnUse">' +
              '<stop stop-color="#EC262D"/><stop offset="1" stop-color="#F57B7F"/>' +
              '</linearGradient></defs>' +
            '</svg>' +
            '<div style="color:#fff;font-weight:900;font-size:0.95rem;letter-spacing:0.18em;text-transform:uppercase;">Aesthetic Legacy</div>' +
            '<div style="width:36px;height:1px;background:rgba(255,255,255,0.15);"></div>' +
            '<p style="color:rgba(255,255,255,0.5);font-size:0.85rem;text-align:center;max-width:300px;line-height:1.8;margin:0;">' +
              'Page is not available at the moment,<br>please come back later' +
            '</p>';
        if (document.body) {
            document.body.appendChild(overlay);
        } else {
            document.addEventListener('DOMContentLoaded', function() {
                document.body.appendChild(overlay);
            });
        }
    }

    function checkLayout(layout) {
        if (layout && layout.sitePublished === false) {
            showMaintenance();
        }
    }

    /* ---- Sync check from cache (instant for repeated navigations) ---- */
    var cached = getCachedLayout();
    if (cached !== null) {
        checkLayout(cached);
        return; // cache hit — no fetch needed
    }

    /* ---- Async fetch (first load or cache expired) ---- */
    // If ghStorage is already loaded and has the data, use it
    if (window.ghStorage) {
        window.ghStorage.getHomeLayout().then(checkLayout).catch(function() {});
        return;
    }

    // Standalone fetch (for pages that don't include github-storage.js)
    fetch(RAW_URL)
        .then(function(res) { return res.ok ? res.json() : null; })
        .then(function(data) {
            if (data) setCachedLayout(data);
            checkLayout(data);
        })
        .catch(function() {}); // fail open — never block the page on error
})();
