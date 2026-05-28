const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// ---- Allowed data file paths ----
const ALLOWED_DATA_FILES = [
    'data/home-layout.json',
    'data/articles.json',
    'data/contributors.json',
    'data/home-order.json',
    'data/about-config.json',
    'data/site-status.json'
];

// ---- Session store (in-memory; cleared on server restart) ----
const sessions    = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours

function createSession(username, isMaster) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { expires: Date.now() + SESSION_TTL, username: username || '', isMaster: !!isMaster });
    // Prune expired sessions
    for (const [t, s] of sessions) { if (s.expires < Date.now()) sessions.delete(t); }
    return token;
}

function getSession(token) {
    if (!token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (s.expires < Date.now()) { sessions.delete(token); return null; }
    return s;
}

function validateSession(token) {
    if (!token) return false;
    const s = sessions.get(token);
    if (!s) return false;
    if (s.expires < Date.now()) { sessions.delete(token); return false; }
    return true;
}

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// ---- Users file management ----
const USERS_FILE = path.join(__dirname, 'data/users.json');

function hashPass(pw) {
    return crypto.createHash('sha256').update(pw || '', 'utf8').digest('hex');
}
function loadUsers() {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(e) { return null; }
}
function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Auth middleware — checks Authorization: Bearer <token> header
function requireSession(req, res, next) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!validateSession(token)) return res.status(401).json({ error: 'Session expired. Please log in again.' });
    next();
}

// Auth middleware — only the master admin session can manage users
// On localhost, also allow without token (consistent with frontend bypass)
function requireMaster(req, res, next) {
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || '';
    const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (isLocalhost) return next();
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const sess = getSession(token);
    if (!sess || !sess.isMaster) return res.status(403).json({ error: 'Master admin access required.' });
    next();
}

// ---- GitHub API proxy helper (uses built-in https module) ----
function githubFetch(method, apiPath, pat, bodyObj) {
    return new Promise((resolve, reject) => {
        const bodyStr = bodyObj ? JSON.stringify(bodyObj) : null;
        const reqHeaders = {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${pat}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'aesthetic-legacy-cms'
        };
        if (bodyStr) {
            reqHeaders['Content-Type'] = 'application/json';
            reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
        }
        const req = https.request(
            { hostname: 'api.github.com', path: apiPath, method, headers: reqHeaders },
            res => {
                let raw = '';
                res.on('data', c => raw += c);
                res.on('end', () => {
                    const ok = res.statusCode >= 200 && res.statusCode < 300;
                    try { resolve({ ok, status: res.statusCode, data: JSON.parse(raw) }); }
                    catch(e) { resolve({ ok, status: res.statusCode, data: raw }); }
                });
            }
        );
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

// ---- POST /api/login ----
// Initialise users.json with default admin on first run
(function initUsers() {
    if (!fs.existsSync(USERS_FILE)) {
        const u = process.env.CMS_USERNAME || 'admin';
        const p = process.env.CMS_PASSWORD || 'admin123';
        saveUsers([{ username: u, passwordHash: hashPass(p), blocked: false, isMaster: true, permissions: ['home', 'contributors', 'blog', 'about'] }]);
        console.log(`  ✓  Created data/users.json with user "${u}"`);
    }
})();

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const users = loadUsers();
    if (!users) {
        // Fallback to env vars if users.json is missing
        const eu = process.env.CMS_USERNAME || 'admin';
        const ep = process.env.CMS_PASSWORD || 'admin123';
        if (!safeEqual(username || '', eu) || !safeEqual(password || '', ep)) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }
        return res.json({ token: createSession(eu, true), isMaster: true, permissions: ['home', 'contributors', 'blog', 'about'] });
    }
    const hash = hashPass(password);
    const user = users.find(u => u.username === username && !u.blocked);
    if (!user || !safeEqual(hash, user.passwordHash)) {
        return res.status(401).json({ error: 'Invalid username or password.' });
    }
    res.json({ token: createSession(user.username, !!user.isMaster), isMaster: !!user.isMaster, permissions: user.permissions || [] });
});

// ---- POST /api/github-write ----
app.post('/api/github-write', async (req, res) => {
    const { token, filePath, content, commitMessage } = req.body;
    if (!validateSession(token)) {
        return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    if (!filePath || !ALLOWED_DATA_FILES.includes(filePath)) {
        return res.status(400).json({ error: 'Invalid file path.' });
    }
    const pat = process.env.GITHUB_PAT || '';
    if (!pat) {
        return res.status(500).json({ error: 'GITHUB_PAT environment variable is not configured on the server.' });
    }
    const owner  = process.env.GITHUB_OWNER  || 'bogia84';
    const repo   = process.env.GITHUB_REPO   || 'aesthetic-legacy';
    const branch = process.env.GITHUB_BRANCH || 'main';
    try {
        // 1. Fetch current SHA
        const shaRes = await githubFetch('GET', `/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`, pat, null);
        if (!shaRes.ok && shaRes.status !== 404) {
            return res.status(502).json({ error: `GitHub SHA fetch failed (${shaRes.status})` });
        }
        const sha = (shaRes.ok && shaRes.data && shaRes.data.sha) ? shaRes.data.sha : null;

        // 2. Write content
        const putBody = {
            message: commitMessage || `Update ${filePath}`,
            content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
            branch
        };
        if (sha) putBody.sha = sha;

        const putRes = await githubFetch('PUT', `/repos/${owner}/${repo}/contents/${filePath}`, pat, putBody);
        if (!putRes.ok) {
            const detail = typeof putRes.data === 'string' ? putRes.data : JSON.stringify(putRes.data);
            return res.status(502).json({ error: `GitHub write failed (${putRes.status}): ${detail}` });
        }
        res.json({ ok: true, sha: putRes.data.content && putRes.data.content.sha });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---- User management endpoints (master admin only) ----
app.get('/api/users', requireMaster, (req, res) => {
    const users = loadUsers() || [];
    res.json(users.map(u => ({ username: u.username, blocked: !!u.blocked, isMaster: !!u.isMaster, permissions: u.permissions || [] })));
});

app.post('/api/users', requireMaster, (req, res) => {
    const { username, password, permissions } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    const users = loadUsers() || [];
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Username already exists.' });
    users.push({ username, passwordHash: hashPass(password), blocked: false, isMaster: false, permissions: Array.isArray(permissions) ? permissions : [] });
    saveUsers(users);
    res.json({ ok: true });
});

app.put('/api/users/:username', requireMaster, (req, res) => {
    const { password, blocked, permissions } = req.body;
    const users = loadUsers() || [];
    const idx = users.findIndex(u => u.username === req.params.username);
    if (idx === -1) return res.status(404).json({ error: 'User not found.' });
    if (password) users[idx].passwordHash = hashPass(password);
    if (blocked !== undefined && !users[idx].isMaster) users[idx].blocked = !!blocked;
    if (Array.isArray(permissions) && !users[idx].isMaster) users[idx].permissions = permissions;
    saveUsers(users);
    res.json({ ok: true });
});

app.delete('/api/users/:username', requireMaster, (req, res) => {
    const users = loadUsers() || [];
    const target = users.find(u => u.username === req.params.username);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (target.isMaster) return res.status(400).json({ error: 'Cannot delete the master admin.' });
    const filtered = users.filter(u => u.username !== req.params.username);
    saveUsers(filtered);
    res.json({ ok: true });
});

// ---- POST /api/save-json (localhost only — direct file write) ----
app.post('/api/save-json', (req, res) => {
    const { filePath, content } = req.body;
    if (!filePath || !ALLOWED_DATA_FILES.includes(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
    }
    const absPath = path.join(__dirname, filePath);
    fs.writeFile(absPath, JSON.stringify(content, null, 2), 'utf8', (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true });
    });
});

// ---- Static files ----
app.use(express.static(path.join(__dirname)));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Aesthetic Legacy server running at http://localhost:${PORT}`);
    if (!process.env.CMS_USERNAME || !process.env.CMS_PASSWORD) {
        console.warn('  ⚠  CMS_USERNAME / CMS_PASSWORD not set — using defaults (admin / admin123). Set env vars in production.');
    }
    if (!process.env.GITHUB_PAT) {
        console.warn('  ⚠  GITHUB_PAT not set — /api/github-write will return 500 until configured.');
    }
});
