const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Local data persistence endpoint (used by github-storage.js when running on localhost)
const ALLOWED_DATA_FILES = [
    'data/home-layout.json',
    'data/articles.json',
    'data/contributors.json',
    'data/home-order.json'
];

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

// Serve static files from the project root
app.use(express.static(path.join(__dirname)));

// Fallback: serve index.html for unknown routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Aesthetic Legacy server running at http://localhost:${PORT}`);
});
