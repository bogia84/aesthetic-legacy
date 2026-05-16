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

    var BASE = 'https://api.github.com';
    // SHA cache so we don't need to fetch before every write
    var _shaCache = {};

    // Public repo info — not secret, safe to hardcode
    var OWNER     = 'bogia84';
    var REPO      = 'aesthetic-legacy';
    var BRANCH    = 'main';
    var TOKEN_KEY = 'aestheticLegacyGHToken';

    // Token: config.js (local dev) takes priority, else localStorage (GitHub Pages)
    function getToken() {
        if (global.GITHUB_CONFIG && global.GITHUB_CONFIG.token) {
            return global.GITHUB_CONFIG.token;
        }
        return localStorage.getItem(TOKEN_KEY) || '';
    }

    function apiUrl(path) {
        var cfg = global.GITHUB_CONFIG || {};
        return BASE + '/repos/' + (cfg.owner || OWNER) + '/' + (cfg.repo || REPO) + '/contents/' + path + '?ref=' + (cfg.branch || BRANCH);
    }

    function headers() {
        return {
            'Authorization': 'Bearer ' + getToken(),
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
    }

    // Unicode-safe base64 encode
    function b64encode(str) {
        return btoa(unescape(encodeURIComponent(str)));
    }

    // Unicode-safe base64 decode
    function b64decode(str) {
        return decodeURIComponent(escape(atob(str)));
    }

    /**
     * Fetch a JSON file from the repo.
     * Caches the SHA for subsequent writes.
     * Returns parsed JS value, or null on 404.
     */
    function ghGet(filePath) {
        return fetch(apiUrl(filePath), { headers: headers(), cache: 'no-store' })
            .then(function(res) {
                if (res.status === 404) return null;
                if (!res.ok) throw new Error('GitHub GET failed: ' + res.status + ' ' + filePath);
                return res.json();
            })
            .then(function(data) {
                if (!data) return null;
                _shaCache[filePath] = data.sha;
                // Files > 1 MB: GitHub returns encoding:'none' and empty content.
                // Fall back to the raw download URL in that case.
                if (data.encoding === 'none' || !data.content) {
                    return fetch(data.download_url, { cache: 'no-store' })
                        .then(function(r) {
                            if (!r.ok) throw new Error('Raw download failed: ' + r.status + ' ' + filePath);
                            return r.json();
                        });
                }
                try {
                    return JSON.parse(b64decode(data.content.replace(/\n/g, '')));
                } catch(e) {
                    return null;
                }
            });
    }

    /**
     * Write a JSON value to a file in the repo.
     * Uses the cached SHA if available, otherwise fetches it first.
     */
    function ghPut(filePath, value, commitMessage) {
        var content = b64encode(JSON.stringify(value, null, 2));
        var sha = _shaCache[filePath];

        function fetchFreshSha() {
            return fetch(apiUrl(filePath), { headers: headers(), cache: 'no-store' })
                .then(function(res) {
                    if (!res.ok && res.status !== 404) throw new Error('GitHub SHA fetch failed: ' + res.status);
                    return res.status === 404 ? null : res.json();
                })
                .then(function(data) {
                    _shaCache[filePath] = data ? data.sha : null;
                    return _shaCache[filePath];
                });
        }

        function doWrite(sha) {
            var body = {
                message: commitMessage || 'Update ' + filePath,
                content: content,
                branch: (global.GITHUB_CONFIG && global.GITHUB_CONFIG.branch) || BRANCH
            };
            if (sha) body.sha = sha;
            return fetch(apiUrl(filePath), {
                method: 'PUT',
                headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
                body: JSON.stringify(body)
            }).then(function(res) {
                if (res.status === 409) {
                    // SHA conflict — re-fetch the real current SHA and retry once
                    return fetchFreshSha().then(function(freshSha) {
                        return doWrite(freshSha);
                    });
                }
                if (!res.ok) return res.text().then(function(t) { throw new Error('GitHub PUT failed: ' + res.status + ' — ' + t); });
                return res.json();
            }).then(function(data) {
                if (data && data.content && data.content.sha) {
                    _shaCache[filePath] = data.content.sha;
                }
            });
        }

        // If we don't have the SHA yet, fetch it first
        if (sha !== undefined) {
            return doWrite(sha);
        }
        return fetch(apiUrl(filePath), { headers: headers(), cache: 'no-store' })
            .then(function(res) {
                if (res.status === 404) return null;
                if (!res.ok) throw new Error('GitHub SHA fetch failed: ' + res.status);
                return res.json();
            })
            .then(function(data) {
                _shaCache[filePath] = data ? data.sha : null;
                return doWrite(_shaCache[filePath]);
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
            return { womenImage: null, womenImagePos: { x: 0, y: 0 }, menImage: null, menImagePos: { x: 0, y: 0 } };
        });
    }

    function saveHomeLayout(layout) {
        return ghPut('data/home-layout.json', layout, 'CMS: update home layout');
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
        setToken:  function(t) { localStorage.setItem(TOKEN_KEY, t); _shaCache = {}; },
        hasToken:  function()  { return !!getToken(); }
    };

})(window);
