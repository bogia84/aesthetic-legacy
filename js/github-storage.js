/**
 * github-storage.js
 * Async read/write for the three data files stored in the GitHub repo.
 * Requires js/config.js to be loaded first (GITHUB_CONFIG global).
 *
 * Exported functions (all return Promises):
 *   getArticles()                          → Array
 *   saveArticles(arr)                      → void
 *   getHomeOrder()                         → {popular, men, women}
 *   saveHomeOrder(order)                   → void
 *   getContributors()                      → {contributors, menOrder, womenOrder}
 *   saveContributors(contributors, menOrder, womenOrder) → void
 */

(function(global) {
    'use strict';

    // When running on localhost, read/write local files instead of GitHub API
    function isLocal() {
        var h = global.location && global.location.hostname;
        return h === 'localhost' || h === '127.0.0.1';
    }

    function localGet(filePath) {
        return fetch('/' + filePath, { cache: 'no-store' })
            .then(function(res) {
                if (!res.ok) return null;
                return res.json();
            })
            .catch(function() { return null; });
    }

    function localPut(filePath, value) {
        return fetch('/api/save-json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: filePath, content: value })
        }).then(function(res) {
            if (!res.ok) return res.text().then(function(t) { throw new Error('Local save failed: ' + t); });
        });
    }

    // Public repo info — not secret, safe to hardcode
    var OWNER  = 'bogia84';
    var REPO   = 'aesthetic-legacy';
    var BRANCH = 'main';

    // Read-only headers for public GitHub API requests (no auth needed for public repo reads)
    function headers() {
        return {
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
    }

    // Unicode-safe base64 encode (needed for direct GitHub API writes)
    function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }

    // ---- CMS session management ----
    function getCmsToken() {
        try { return sessionStorage.getItem('cmsToken'); } catch(e) { return null; }
    }
    function getCmsMode() {
        try { return sessionStorage.getItem('cmsMode'); } catch(e) { return null; }
    }
    function setCmsSession(token, mode) {
        try { sessionStorage.setItem('cmsToken', token); sessionStorage.setItem('cmsMode', mode); } catch(e) {}
    }
    function clearCmsToken() {
        try { sessionStorage.removeItem('cmsToken'); sessionStorage.removeItem('cmsMode'); } catch(e) {}
    }

    function isAuthenticated() {
        if (isLocal()) return true;
        return !!getCmsToken();
    }

    // SHA-256 helper (Web Crypto API)
    function hashString(str) {
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function(buf) {
            return Array.from(new Uint8Array(buf)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
        });
    }

    // Client-side auth — used on GitHub Pages / static hosting (no server available)
    function clientLogin(username, password) {
        return hashString(password).then(function(hash) {
            var storedUser = localStorage.getItem('cmsSetupUser') || (global.GITHUB_CONFIG && global.GITHUB_CONFIG.cmsUser) || '';
            var storedHash = localStorage.getItem('cmsSetupHash') || (global.GITHUB_CONFIG && global.GITHUB_CONFIG.cmsPassHash) || '';
            var pat        = localStorage.getItem('cmsSetupPat')  || (global.GITHUB_CONFIG && global.GITHUB_CONFIG.token) || '';
            if (!storedHash) {
                var e = new Error('__SETUP_NEEDED__'); e.isSetupNeeded = true; throw e;
            }
            if (username !== storedUser || hash !== storedHash) {
                var e = new Error('Invalid username or password.'); e.isServerError = true; throw e;
            }
            if (!pat) {
                var e = new Error('GitHub PAT not found. Please set up your credentials.'); e.isSetupNeeded = true; throw e;
            }
            setCmsSession(pat, 'client');
            return { mode: 'client' };
        });
    }

    // Save credentials to localStorage (first-time setup on GitHub Pages)
    function clientSetup(username, password, pat) {
        if (!username || !password || !pat) return Promise.reject(new Error('All fields are required.'));
        return hashString(password).then(function(hash) {
            localStorage.setItem('cmsSetupUser', username);
            localStorage.setItem('cmsSetupHash', hash);
            localStorage.setItem('cmsSetupPat',  pat);
            setCmsSession(pat, 'client');
            return { mode: 'client' };
        });
    }

    function login(username, password) {
        return fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, password: password })
        }).then(function(res) {
            var ct = res.headers.get('Content-Type') || '';
            if (!ct.includes('application/json')) {
                // Static host returned HTML — no server available, use client auth
                return clientLogin(username, password);
            }
            return res.json().then(function(data) {
                if (!res.ok) {
                    var e = new Error(data.error || 'Invalid username or password.');
                    e.isServerError = true; throw e;
                }
                setCmsSession(data.token, 'server');
                return { mode: 'server' };
            });
        }).catch(function(err) {
            if (err.isServerError || err.isSetupNeeded) throw err; // don't retry client on explicit errors
            return clientLogin(username, password); // network error — try client auth
        });
    }

    function logout() { clearCmsToken(); }

    // Unicode-safe base64 decode
    function b64decode(str) {
        return decodeURIComponent(escape(atob(str)));
    }

    var CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    var CACHE_PREFIX = 'alCache_';

    function cacheGet(filePath) {
        try {
            var raw = sessionStorage.getItem(CACHE_PREFIX + filePath);
            if (!raw) return null;
            var entry = JSON.parse(raw);
            if (Date.now() - entry.ts < CACHE_TTL) return entry.data;
        } catch(e) {}
        return null;
    }

    function cacheSet(filePath, data) {
        try {
            sessionStorage.setItem(CACHE_PREFIX + filePath, JSON.stringify({ ts: Date.now(), data: data }));
        } catch(e) {}
    }

    function cacheInvalidate(filePath) {
        try { sessionStorage.removeItem(CACHE_PREFIX + filePath); } catch(e) {}
    }

    /**
     * Fetch a JSON file from the repo.
     * Uses raw.githubusercontent.com (CDN, no base64 overhead) + sessionStorage cache.
     * Returns parsed JS value, or null on 404.
     */
    function ghGet(filePath) {
        if (isLocal()) return localGet(filePath);

        var cached = cacheGet(filePath);
        if (cached !== null) return Promise.resolve(cached);

        var cfg = global.GITHUB_CONFIG || {};
        var owner  = cfg.owner  || OWNER;
        var repo   = cfg.repo   || REPO;
        var branch = cfg.branch || BRANCH;
        var rawUrl = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/' + filePath;

        return fetch(rawUrl)
            .then(function(res) {
                if (res.status === 404) return null;
                if (!res.ok) throw new Error('GitHub GET failed: ' + res.status + ' ' + filePath);
                return res.json();
            })
            .then(function(data) {
                cacheSet(filePath, data);
                return data;
            });
    }

    /**
     * Write a JSON value to a file in the repo.
     * Uses the cached SHA if available, otherwise fetches it first.
     */
    // Direct GitHub API write — used in client mode (GitHub Pages, no server proxy)
    function ghPutDirect(filePath, value, commitMessage, pat) {
        var cfg    = global.GITHUB_CONFIG || {};
        var owner  = cfg.owner  || OWNER;
        var repo   = cfg.repo   || REPO;
        var branch = cfg.branch || BRANCH;
        var url    = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + filePath;
        var hdrs   = {
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Authorization': 'Bearer ' + pat,
            'Content-Type': 'application/json'
        };
        return fetch(url + '?ref=' + branch, { headers: hdrs, cache: 'no-store' })
            .then(function(res) {
                if (!res.ok && res.status !== 404) throw new Error('SHA fetch failed: ' + res.status);
                return res.status === 404 ? null : res.json();
            })
            .then(function(data) {
                var body = {
                    message: commitMessage || 'Update ' + filePath,
                    content: b64encode(JSON.stringify(value, null, 2)),
                    branch: branch
                };
                if (data && data.sha) body.sha = data.sha;
                return fetch(url, { method: 'PUT', headers: hdrs, body: JSON.stringify(body) });
            })
            .then(function(res) {
                if (!res.ok) return res.text().then(function(t) { throw new Error('GitHub PUT failed: ' + res.status + ' — ' + t); });
                cacheInvalidate(filePath);
                return res.json();
            });
    }

    function ghPut(filePath, value, commitMessage) {
        if (isLocal()) return localPut(filePath, value);
        var token = getCmsToken();
        if (!token) return Promise.reject(new Error('Not authenticated. Please log in.'));
        if (getCmsMode() === 'client') {
            return ghPutDirect(filePath, value, commitMessage, token);
        }
        return fetch('/api/github-write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: token,
                filePath: filePath,
                content: value,
                commitMessage: commitMessage || 'Update ' + filePath
            })
        }).then(function(res) {
            return res.json().then(function(data) {
                if (!res.ok) {
                    if (res.status === 401) clearCmsToken();
                    throw new Error(data.error || 'Write failed: ' + res.status);
                }
                cacheInvalidate(filePath);
                return data;
            });
        });
    }

    // -----------------------------------------------------------------
    //  Public API
    // -----------------------------------------------------------------

    function getArticles() {
        return ghGet('data/articles.json').then(function(data) {
            return Array.isArray(data) ? data : [];
        });
    }

    function saveArticles(arr) {
        return ghPut('data/articles.json', arr, 'CMS: update articles');
    }

    function getHomeOrder() {
        return ghGet('data/home-order.json').then(function(data) {
            if (data && Array.isArray(data.popular)) return data;
            return { popular: [], men: [], women: [] };
        });
    }

    function saveHomeOrder(order) {
        return ghPut('data/home-order.json', order, 'CMS: update home order');
    }

    function getContributors() {
        return ghGet('data/contributors.json').then(function(data) {
            if (data && Array.isArray(data.contributors)) return data;
            return { contributors: [], menOrder: [], womenOrder: [] };
        });
    }

    function saveContributors(contributors, menOrder, womenOrder) {
        return ghPut('data/contributors.json', {
            contributors: contributors,
            menOrder:     menOrder,
            womenOrder:   womenOrder
        }, 'CMS: update contributors');
    }

    function getHomeLayout() {
        return ghGet('data/home-layout.json').then(function(data) {
            if (data && typeof data === 'object') return data;
            return { womenImage: null, womenImagePos: { x: 0, y: 0 }, menImage: null, menImagePos: { x: 0, y: 0 }, sitePublished: true };
        });
    }

    function saveHomeLayout(layout) {
        return ghPut('data/home-layout.json', layout, 'CMS: update home layout');
    }

    function getAboutConfig() {
        return ghGet('data/about-config.json').then(function(data) {
            if (data && typeof data === 'object') return data;
            return { videoUrl: '', videoCover: '', sec3Image: '', sec4Image: '', sec5Image: '', spotlightContribs: [] };
        });
    }

    function saveAboutConfig(cfg) {
        return ghPut('data/about-config.json', cfg, 'CMS: update about config');
    }

    function getSiteStatus() {
        // Always fetch fresh via Contents API (bypass CDN)
        if (isLocal()) {
            return localGet('data/site-status.json').then(function(data) {
                return (data && typeof data.published === 'boolean') ? data : { published: true };
            });
        }
        return fetch('https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/data/site-status.json?ref=' + BRANCH, {
            headers: headers(),
            cache: 'no-store'
        }).then(function(res) { return res.ok ? res.json() : null; })
          .then(function(data) {
              if (!data || !data.content) return { published: true };
              try { return JSON.parse(b64decode(data.content.replace(/\n/g, ''))); } catch(e) { return { published: true }; }
          }).catch(function() { return { published: true }; });
    }

    function saveSiteStatus(published, bypassPassword) {
        return ghPut('data/site-status.json', { published: published, bypassPassword: bypassPassword || '' }, 'CMS: update site status');
    }

    // Expose on window
    global.ghStorage = {
        getArticles:      getArticles,
        saveArticles:     saveArticles,
        getHomeOrder:     getHomeOrder,
        saveHomeOrder:    saveHomeOrder,
        getContributors:  getContributors,
        saveContributors: saveContributors,
        getHomeLayout:    getHomeLayout,
        saveHomeLayout:   saveHomeLayout,
        getAboutConfig:   getAboutConfig,
        saveAboutConfig:  saveAboutConfig,
        getSiteStatus:    getSiteStatus,
        saveSiteStatus:   saveSiteStatus,
        login:           login,
        logout:          logout,
        isAuthenticated: isAuthenticated,
        clientSetup:     clientSetup
    };

})(window);
