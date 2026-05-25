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

function createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { expires: Date.now() + SESSION_TTL });
    // Prune expired sessions
    for (const [t, s] of sessions) { if (s.expires < Date.now()) sessions.delete(t); }
    return token;
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
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const expectedUser = process.env.CMS_USERNAME || '';
    const expectedPass = process.env.CMS_PASSWORD || '';
    if (!expectedUser || !expectedPass) {
        return res.status(500).json({ error: 'CMS_USERNAME and CMS_PASSWORD environment variables are not configured on the server.' });
    }
    if (!safeEqual(username || '', expectedUser) || !safeEqual(password || '', expectedPass)) {
        return res.status(401).json({ error: 'Invalid username or password.' });
    }
    res.json({ token: createSession() });
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
        console.warn('  ⚠  CMS_USERNAME / CMS_PASSWORD not set — /api/login will return 500 until configured.');
    }
    if (!process.env.GITHUB_PAT) {
        console.warn('  ⚠  GITHUB_PAT not set — /api/github-write will return 500 until configured.');
    }
});
