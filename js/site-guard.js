/**
 * site-guard.js
 * Checks site publish status. Shows a maintenance overlay when unpublished.
 * Supports a bypass password so admins can preview while the site is offline.
 * Include on every public page AFTER github-storage.js (if present).
 */
(function() {
    var OWNER        = 'bogia84';
    var REPO         = 'aesthetic-legacy';
    var CONTENTS_URL = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/data/site-status.json?ref=main';
    var CACHE_KEY    = 'sgStatus';
    var CACHE_TTL    = 30 * 1000; // 30 seconds
    var BYPASS_KEY   = 'sgAdmin';

    /* ---- Cache: stores {published, bypassPassword} ---- */
    function getCachedStatus() {
        try {
            var raw = sessionStorage.getItem(CACHE_KEY);
            if (!raw) return null;
            var entry = JSON.parse(raw);
            if (Date.now() - entry.ts > CACHE_TTL) return null;
            return { published: entry.published, bypassPassword: entry.bypassPassword || '' };
        } catch(e) { return null; }
    }

    function setCachedStatus(status) {
        try {
            sessionStorage.setItem(CACHE_KEY, JSON.stringify({
                ts: Date.now(),
                published: status.published,
                bypassPassword: status.bypassPassword || ''
            }));
        } catch(e) {}
    }

    /* ---- Bypass (admin preview) ---- */
    function hasBypass(pw) {
        if (!pw) return false;
        try { return localStorage.getItem(BYPASS_KEY) === pw; } catch(e) { return false; }
    }

    function storeBypass(pw) {
        try { localStorage.setItem(BYPASS_KEY, pw); } catch(e) {}
    }

    /* ---- Maintenance overlay ---- */
    function showMaintenance(bypassPassword) {
        if (document.getElementById('site-maintenance')) return;

        // Inject shake keyframe once
        if (!document.getElementById('sg-style')) {
            var s = document.createElement('style');
            s.id = 'sg-style';
            s.textContent = '@keyframes sg-shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}';
            (document.head || document.documentElement).appendChild(s);
        }

        var overlay = document.createElement('div');
        overlay.id = 'site-maintenance';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0a0a0a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;font-family:Manrope,sans-serif';

        var bypassHTML = '';
        if (bypassPassword) {
            bypassHTML =
                '<div style="margin-top:8px;display:flex;flex-direction:column;align-items:center;gap:10px;">' +
                  '<button id="sg-bypass-btn" style="background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.18);font-size:0.68rem;letter-spacing:0.1em;font-family:Manrope,sans-serif;padding:4px 8px;transition:color 0.2s;text-transform:uppercase;" ' +
                    'onmouseover="this.style.color=\'rgba(255,255,255,0.45)\'" onmouseout="this.style.color=\'rgba(255,255,255,0.18)\'" ' +
                    'onclick="document.getElementById(\'sg-bypass-form\').style.display=\'flex\';this.style.display=\'none\';">' +
                    'Admin access' +
                  '</button>' +
                  '<form id="sg-bypass-form" style="display:none;flex-direction:column;align-items:center;gap:8px;" onsubmit="return false;">' +
                    '<input id="sg-bypass-input" type="password" placeholder="Enter password" autocomplete="current-password" ' +
                      'style="background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#fff;font-size:0.82rem;padding:8px 14px;width:200px;outline:none;font-family:Manrope,sans-serif;text-align:center;" />' +
                    '<button id="sg-bypass-submit" type="submit" ' +
                      'style="background:#EC262D;border:none;border-radius:8px;color:#fff;font-size:0.75rem;font-weight:800;letter-spacing:0.08em;padding:7px 22px;cursor:pointer;font-family:Manrope,sans-serif;">' +
                      'UNLOCK' +
                    '</button>' +
                  '</form>' +
                '</div>';
        }

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
              'Page is not available at the moment,<br>please come back later</p>' +
            bypassHTML;

        function attachBypassHandler() {
            var input  = document.getElementById('sg-bypass-input');
            var submit = document.getElementById('sg-bypass-submit');
            if (!input || !submit) return;
            function tryUnlock() {
                if (input.value === bypassPassword) {
                    storeBypass(bypassPassword);
                    overlay.style.transition = 'opacity 0.4s';
                    overlay.style.opacity = '0';
                    setTimeout(function() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 420);
                } else {
                    input.style.borderColor = '#EC262D';
                    input.style.animation = 'sg-shake 0.4s';
                    setTimeout(function() { input.style.borderColor = 'rgba(255,255,255,0.15)'; input.style.animation = ''; input.value = ''; }, 600);
                }
            }
            submit.addEventListener('click', tryUnlock);
            input.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); tryUnlock(); } });
        }

        if (document.body) {
            document.body.appendChild(overlay);
            attachBypassHandler();
        } else {
            document.addEventListener('DOMContentLoaded', function() {
                document.body.appendChild(overlay);
                attachBypassHandler();
            });
        }
    }

    /* ---- Apply fetched/cached status ---- */
    function applyStatus(status) {
        setCachedStatus(status);
        if (status.published === false) {
            if (hasBypass(status.bypassPassword)) return; // admin bypassed
            showMaintenance(status.bypassPassword || '');
        }
    }

    /* ---- Sync: check short-TTL cache first ---- */
    var cached = getCachedStatus();
    if (cached !== null) {
        if (cached.published === false && !hasBypass(cached.bypassPassword)) {
            showMaintenance(cached.bypassPassword || '');
        }
        return;
    }

    /* ---- Use ghStorage when available (handles localhost) ---- */
    if (window.ghStorage && typeof window.ghStorage.getSiteStatus === 'function') {
        window.ghStorage.getSiteStatus()
            .then(function(s) { applyStatus(s || { published: true, bypassPassword: '' }); })
            .catch(function() { /* fail open */ });
        return;
    }

    /* ---- Fallback: GitHub Contents API (no CDN cache) ---- */
    fetch(CONTENTS_URL, {
        headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        cache: 'no-store'
    })
    .then(function(res) { return res.ok ? res.json() : null; })
    .then(function(data) {
        if (!data || !data.content) { applyStatus({ published: true, bypassPassword: '' }); return; }
        try {
            var s = JSON.parse(atob(data.content.replace(/\n/g, '')));
            applyStatus({ published: s.published !== false, bypassPassword: s.bypassPassword || '' });
        } catch(e) { applyStatus({ published: true, bypassPassword: '' }); }
    })
    .catch(function() { applyStatus({ published: true, bypassPassword: '' }); });
})();
