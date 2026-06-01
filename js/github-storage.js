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
 *   getInterviewees()                      → {interviewees, menOrder, womenOrder}
 *   saveInterviewees(interviewees, menOrder, womenOrder) → void
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
        var token = getCmsToken() || '';
        return fetch('/api/save-json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
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
    function getCmsUser() {
        try { return sessionStorage.getItem('cmsUser'); } catch(e) { return null; }
    }
    function setCmsSession(token, mode, username, isMaster, permissions) {
        try {
            sessionStorage.setItem('cmsToken', token);
            sessionStorage.setItem('cmsMode', mode);
            if (username) sessionStorage.setItem('cmsUser', username);
            sessionStorage.setItem('cmsMaster', isMaster ? 'true' : 'false');
            sessionStorage.setItem('cmsPermissions', JSON.stringify(permissions || []));
        } catch(e) {}
    }
    function clearCmsToken() {
        try {
            sessionStorage.removeItem('cmsToken');
            sessionStorage.removeItem('cmsMode');
            sessionStorage.removeItem('cmsUser');
            sessionStorage.removeItem('cmsMaster');
            sessionStorage.removeItem('cmsPermissions');
        } catch(e) {}
    }

    function isMasterAdmin() {
        try { return sessionStorage.getItem('cmsMaster') === 'true'; } catch(e) { return false; }
    }
    function getPermissions() {
        try { return JSON.parse(sessionStorage.getItem('cmsPermissions') || '[]'); } catch(e) { return []; }
    }

    function isAuthenticated() {
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
            setCmsSession(pat, 'client', username, true, ['home', 'interviewees', 'blog', 'about']);
            return { mode: 'client' };
        });
    }

    // Save credentials to localStorage (first-time setup on GitHub Pages)
    // Validates the PAT against the GitHub API before saving — rejects fake tokens.
    function clientSetup(username, password, pat) {
        if (!username || !password || !pat) return Promise.reject(new Error('All fields are required.'));
        var cfg = global.GITHUB_CONFIG || {};
        var owner = cfg.owner || OWNER;
        var repo  = cfg.repo  || REPO;
        // Verify the token has real repo access before accepting it
        return fetch('https://api.github.com/repos/' + owner + '/' + repo, {
            headers: {
                'Authorization': 'Bearer ' + pat,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28'
            }
        }).then(function(res) {
            if (!res.ok) {
                var e = new Error('Invalid GitHub token — cannot access the repository. Please check your PAT and try again.');
                e.isServerError = true; throw e;
            }
            return hashString(password);
        }).then(function(hash) {
            localStorage.setItem('cmsSetupUser', username);
            localStorage.setItem('cmsSetupHash', hash);
            localStorage.setItem('cmsSetupPat',  pat);
            setCmsSession(pat, 'client', username, true, ['home', 'interviewees', 'blog', 'about']);
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
                setCmsSession(data.token, 'server', username, data.isMaster, data.permissions);
                return { mode: 'server' };
            });
        }).catch(function(err) {
            if (err.isServerError || err.isSetupNeeded) throw err; // don't retry client on explicit errors
            return clientLogin(username, password); // network error — try client auth
        });
    }

    function logout() { clearCmsToken(); }

    // ---- User management API (works in both server and client mode) ----
    function cmsRequest(method, endpoint, body) {
        var token = getCmsToken();
        var mode  = getCmsMode();
        if (mode === 'client') return cmsClientRequest(method, endpoint, body);
        var opts = {
            method: method,
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token || '') }
        };
        if (body && method !== 'GET') opts.body = JSON.stringify(body);
        return fetch(endpoint, opts).then(function(res) {
            return res.json().then(function(data) {
                if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
                return data;
            });
        });
    }

    function cmsClientRequest(method, endpoint, body) {
        var KEY = 'cmsUsers';
        function load()  { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch(e) { return []; } }
        function store(u){ localStorage.setItem(KEY, JSON.stringify(u)); }

        if (method === 'GET') {
            return Promise.resolve(load().map(function(u) { return { username: u.username, blocked: !!u.blocked, isMaster: !!u.isMaster, permissions: u.permissions || [] }; }));
        }
        if (method === 'POST') {
            var users = load();
            if (users.find(function(u) { return u.username === body.username; }))
                return Promise.reject(new Error('Username already exists.'));
            return hashString(body.password).then(function(h) {
                users.push({ username: body.username, passwordHash: h, blocked: false, isMaster: false, permissions: Array.isArray(body.permissions) ? body.permissions : [] });
                store(users); return { ok: true };
            });
        }
        var username = endpoint.split('/').pop();
        if (method === 'PUT') {
            var users = load(), idx = users.findIndex(function(u) { return u.username === username; });
            if (idx === -1) return Promise.reject(new Error('User not found.'));
            if (body.blocked !== undefined && !users[idx].isMaster) users[idx].blocked = !!body.blocked;
            if (Array.isArray(body.permissions) && !users[idx].isMaster) users[idx].permissions = body.permissions;
            if (body.password) {
                return hashString(body.password).then(function(h) {
                    users[idx].passwordHash = h; store(users); return { ok: true };
                });
            }
            store(users); return Promise.resolve({ ok: true });
        }
        if (method === 'DELETE') {
            var users = load();
            var target = users.find(function(u) { return u.username === username; });
            if (!target) return Promise.reject(new Error('User not found.'));
            if (target.isMaster) return Promise.reject(new Error('Cannot delete the master admin.'));
            var filtered = users.filter(function(u) { return u.username !== username; });
            store(filtered); return Promise.resolve({ ok: true });
        }
        return Promise.reject(new Error('Unknown operation'));
    }

    function getUsers()                                    { return cmsRequest('GET',    '/api/users',             null); }
    function createUser(username, password, permissions)   { return cmsRequest('POST',   '/api/users',             { username: username, password: password, permissions: permissions || [] }); }
    function updateUser(username, opts)                    { return cmsRequest('PUT',    '/api/users/' + username, opts); }
    function deleteUser(username)                          { return cmsRequest('DELETE', '/api/users/' + username, null); }

    // Unicode-safe base64 decode
    function b64decode(str) {
        return decodeURIComponent(escape(atob(str)));
    }

    var CACHE_TTL = 30 * 1000; // 30 seconds
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
        var rawUrl = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/' + filePath
            + '?_=' + Math.floor(Date.now() / 30000);

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
        var encodedContent = b64encode(JSON.stringify(value, null, 2));

        function fetchSha() {
            return fetch(url + '?ref=' + branch, { headers: hdrs, cache: 'no-store' })
                .then(function(res) {
                    if (!res.ok && res.status !== 404) throw new Error('SHA fetch failed: ' + res.status);
                    return res.status === 404 ? null : res.json();
                });
        }

        function doPut(sha) {
            var body = {
                message: commitMessage || 'Update ' + filePath,
                content: encodedContent,
                branch: branch
            };
            if (sha) body.sha = sha;
            return fetch(url, { method: 'PUT', headers: hdrs, body: JSON.stringify(body) });
        }

        return fetchSha()
            .then(function(data) { return doPut(data && data.sha); })
            .then(function(res) {
                if (res.status === 409) {
                    // Stale SHA (concurrent save or git push) — re-fetch and retry once
                    return fetchSha().then(function(data) { return doPut(data && data.sha); });
                }
                return res;
            })
            .then(function(res) {
                if (!res.ok) return res.text().then(function(t) { throw new Error('GitHub PUT failed: ' + res.status + ' — ' + t); });
                cacheSet(filePath, value); // seed cache with written value — next read bypasses stale CDN
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
                cacheSet(filePath, value); // seed cache with written value — next read bypasses stale CDN
                return data;
            });
        });
    }

    // -----------------------------------------------------------------
    //  Image file upload
    // -----------------------------------------------------------------

    /**
     * Upload a data:image/... URL to data/images/ in the repo.
     * Returns a Promise<string> resolving to the repo-relative URL, e.g. "/data/images/img-123.jpg".
     * If dataUrl is already a plain URL (not a data: URI) it is returned as-is.
     */
    function uploadImage(dataUrl, hint) {
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
            return Promise.resolve(dataUrl); // already a URL — nothing to do
        }
        var match = dataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
        if (!match) return Promise.resolve(dataUrl);
        var mime = match[1];
        var b64  = match[2];
        var ext  = mime.split('/')[1]
                       .replace('jpeg', 'jpg')
                       .replace('svg+xml', 'svg')
                       .split('+')[0].split(';')[0]; // normalise exotic types
        var ts   = Date.now();
        var rand = (Math.floor(Math.random() * 9000) + 1000).toString();
        var safeName = hint ? hint.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24) + '-' : '';
        var name     = 'img-' + safeName + ts + '-' + rand + '.' + ext;
        var filePath = 'data/images/' + name;
        var commit   = 'CMS: upload ' + name;
        var p;
        if (isLocal()) {
            p = _localPutImage(filePath, b64);
        } else {
            var token = getCmsToken();
            if (!token) return Promise.reject(new Error('Not authenticated.'));
            if (getCmsMode() === 'client') {
                p = _ghPutImageDirect(filePath, b64, commit, token);
            } else {
                p = fetch('/api/save-image', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ filePath: filePath, base64Content: b64, commitMessage: commit })
                }).then(function(res) {
                    return res.json().then(function(data) {
                        if (!res.ok) throw new Error(data.error || 'Image upload failed: ' + res.status);
                        return data;
                    });
                });
            }
        }
        return p.then(function() { return '/' + filePath; });
    }

    // Direct GitHub API image write (client mode — GitHub Pages)
    function _ghPutImageDirect(filePath, rawBase64, commitMessage, pat) {
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
            .then(function(res) { return res.ok ? res.json() : null; })
            .then(function(existing) {
                var body = { message: commitMessage, content: rawBase64, branch: branch };
                if (existing && existing.sha) body.sha = existing.sha;
                return fetch(url, { method: 'PUT', headers: hdrs, body: JSON.stringify(body) });
            })
            .then(function(res) {
                if (!res.ok) return res.text().then(function(t) { throw new Error('Image PUT failed: ' + res.status + ' — ' + t); });
                return res.json();
            });
    }

    // Local dev image write — server saves binary file to data/images/
    function _localPutImage(filePath, rawBase64) {
        var token = getCmsToken() || '';
        return fetch('/api/save-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ filePath: filePath, base64Content: rawBase64 })
        }).then(function(res) {
            if (!res.ok) return res.text().then(function(t) { throw new Error('Local image save failed: ' + t); });
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

    function getInterviewees() {
        return ghGet('data/interviewees.json').then(function(data) {
            if (data && Array.isArray(data.interviewees)) return data;
            return { interviewees: [], menOrder: [], womenOrder: [], heroConfig: { bgImage: '', title: 'Fitness influencer', description: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam,', overlayVisible: true } };
        });
    }

    function saveInterviewees(interviewees, menOrder, womenOrder, heroConfig) {
        return ghPut('data/interviewees.json', {
            interviewees: interviewees,
            menOrder:     menOrder,
            womenOrder:   womenOrder,
            heroConfig:   heroConfig || { bgImage: '', title: '', description: '', overlayVisible: true }
        }, 'CMS: update interviewees');
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
            return { videoUrl: '', videoCover: '', sec3Image: '', sec4Image: '', sec5Image: '', spotlightInterviewees: [] };
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

    function _ghAuthHeaders(pat, includeContentType) {
        var h = {
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Authorization': 'Bearer ' + pat
        };
        if (includeContentType) h['Content-Type'] = 'application/json';
        return h;
    }

    function _ghRepoContext() {
        var cfg = global.GITHUB_CONFIG || {};
        return {
            owner:  cfg.owner  || OWNER,
            repo:   cfg.repo   || REPO,
            branch: cfg.branch || BRANCH
        };
    }

    function _deleteImagesClientMode(pat) {
        var ctx = _ghRepoContext();
        var api = 'https://api.github.com/repos/' + ctx.owner + '/' + ctx.repo;
        var hdrs = _ghAuthHeaders(pat, false);

        return fetch(api + '/git/ref/heads/' + encodeURIComponent(ctx.branch), { headers: hdrs, cache: 'no-store' })
            .then(function(refRes) {
                if (!refRes.ok) {
                    return refRes.text().then(function(t) {
                        throw new Error('Reset failed to read branch ref: ' + refRes.status + ' - ' + t);
                    });
                }
                return refRes.json();
            })
            .then(function(refData) {
                var commitSha = refData && refData.object && refData.object.sha;
                if (!commitSha) throw new Error('Reset failed: branch commit SHA missing.');
                return fetch(api + '/git/commits/' + commitSha, { headers: hdrs, cache: 'no-store' });
            })
            .then(function(commitRes) {
                if (!commitRes.ok) {
                    return commitRes.text().then(function(t) {
                        throw new Error('Reset failed to read commit tree: ' + commitRes.status + ' - ' + t);
                    });
                }
                return commitRes.json();
            })
            .then(function(commitData) {
                var treeSha = commitData && commitData.tree && commitData.tree.sha;
                if (!treeSha) throw new Error('Reset failed: tree SHA missing.');
                return fetch(api + '/git/trees/' + treeSha + '?recursive=1', { headers: hdrs, cache: 'no-store' });
            })
            .then(function(treeRes) {
                if (!treeRes.ok) {
                    return treeRes.text().then(function(t) {
                        throw new Error('Reset failed to list media files: ' + treeRes.status + ' - ' + t);
                    });
                }
                return treeRes.json();
            })
            .then(function(treeData) {
                var items = Array.isArray(treeData && treeData.tree) ? treeData.tree : [];
                var blobs = items.filter(function(entry) {
                    return entry && entry.type === 'blob' && typeof entry.path === 'string' && entry.path.indexOf('data/images/') === 0;
                });

                if (!blobs.length) return { deletedMediaEntries: 0 };

                var delHdrs = _ghAuthHeaders(pat, true);
                var chain = Promise.resolve();

                blobs.forEach(function(entry) {
                    chain = chain.then(function() {
                        var encodedPath = entry.path.split('/').map(encodeURIComponent).join('/');
                        var body = {
                            message: 'CMS: reset remove ' + entry.path,
                            sha: entry.sha,
                            branch: ctx.branch
                        };
                        return fetch(api + '/contents/' + encodedPath, {
                            method: 'DELETE',
                            headers: delHdrs,
                            body: JSON.stringify(body)
                        }).then(function(delRes) {
                            if (!delRes.ok) {
                                return delRes.text().then(function(t) {
                                    throw new Error('Reset failed deleting media file ' + entry.path + ': ' + delRes.status + ' - ' + t);
                                });
                            }
                        });
                    });
                });

                return chain.then(function() {
                    return { deletedMediaEntries: blobs.length };
                });
            });
    }

    function _resetAllDataClientMode(payload, pat) {
        var body = payload || {};
        var articles = body.articles;
        var homeOrder = body.homeOrder;
        var intervieweesPayload = body.intervieweesPayload;

        if (body.confirm !== true) {
            return Promise.reject(new Error('Reset confirmation is required.'));
        }
        if (!Array.isArray(articles)) {
            return Promise.reject(new Error('Invalid payload: articles must be an array.'));
        }
        if (!homeOrder || !Array.isArray(homeOrder.popular) || !Array.isArray(homeOrder.men) || !Array.isArray(homeOrder.women)) {
            return Promise.reject(new Error('Invalid payload: homeOrder must include popular/men/women arrays.'));
        }
        if (!intervieweesPayload || !Array.isArray(intervieweesPayload.interviewees) || !Array.isArray(intervieweesPayload.menOrder) || !Array.isArray(intervieweesPayload.womenOrder)) {
            return Promise.reject(new Error('Invalid payload: intervieweesPayload is malformed.'));
        }

        return Promise.all([
            ghPutDirect('data/articles.json', articles, 'CMS: reset articles', pat),
            ghPutDirect('data/home-order.json', homeOrder, 'CMS: reset home order', pat),
            ghPutDirect('data/interviewees.json', intervieweesPayload, 'CMS: reset interviewees', pat)
        ]).then(function() {
            return _deleteImagesClientMode(pat);
        }).then(function(result) {
            cacheInvalidate('data/articles.json');
            cacheInvalidate('data/home-order.json');
            cacheInvalidate('data/interviewees.json');
            return {
                ok: true,
                deletedMediaEntries: result.deletedMediaEntries || 0,
                mode: 'client'
            };
        });
    }

    function resetAllData(payload) {
        var token = getCmsToken();
        if (!token) return Promise.reject(new Error('Not authenticated. Please log in.'));
        if (getCmsMode() === 'client') {
            return _resetAllDataClientMode(payload, token);
        }
        return fetch('/api/reset-all-data', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify(payload || {})
        }).then(function(res) {
            return res.json().then(function(data) {
                if (!res.ok) {
                    if (res.status === 401) clearCmsToken();
                    throw new Error(data.error || 'Reset failed: ' + res.status);
                }
                cacheInvalidate('data/articles.json');
                cacheInvalidate('data/home-order.json');
                cacheInvalidate('data/interviewees.json');
                return data;
            });
        });
    }

    // Expose on window
    global.ghStorage = {
        getArticles:      getArticles,
        saveArticles:     saveArticles,
        getHomeOrder:     getHomeOrder,
        saveHomeOrder:    saveHomeOrder,
        getInterviewees:  getInterviewees,
        saveInterviewees: saveInterviewees,
        getHomeLayout:    getHomeLayout,
        saveHomeLayout:   saveHomeLayout,
        getAboutConfig:   getAboutConfig,
        saveAboutConfig:  saveAboutConfig,
        getSiteStatus:    getSiteStatus,
        saveSiteStatus:   saveSiteStatus,
        resetAllData:     resetAllData,
        uploadImage:     uploadImage,
        login:           login,
        logout:          logout,
        isAuthenticated: isAuthenticated,
        isMasterAdmin:   isMasterAdmin,
        getPermissions:  getPermissions,
        clientSetup:     clientSetup,
        getUsers:        getUsers,
        createUser:      createUser,
        updateUser:      updateUser,
        deleteUser:      deleteUser
    };

})(window);
