const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'bloom-data.json');
const PUBLIC_ROOT = __dirname;

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function loadData() {
  return readJson(DATA_FILE, { users: {}, sessions: {} });
}

function saveData(data) {
  writeJson(DATA_FILE, data);
}

function createToken() {
  return crypto.randomBytes(24).toString('hex');
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function getTokenFromRequest(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

function getUserFromToken(token, data) {
  const userId = data.sessions[token];
  if (!userId) return null;
  return data.users[userId] || null;
}

function authenticate(req, res, next) {
  const token = getTokenFromRequest(req);
  if (!token) {
    sendJson(res, 401, { error: 'Authentication required' });
    return;
  }
  const data = loadData();
  const user = getUserFromToken(token, data);
  if (!user) {
    sendJson(res, 401, { error: 'Invalid session' });
    return;
  }
  req.user = user;
  req.data = data;
  req.token = token;
  next();
}

function serveStatic(res, filePath) {
  const safePath = path.normalize(filePath).replace(/^([a-zA-Z]:[\\/])?/, '');
  const absolutePath = path.join(PUBLIC_ROOT, safePath);
  if (!absolutePath.startsWith(PUBLIC_ROOT)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  fs.readFile(absolutePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    const ext = path.extname(absolutePath).toLowerCase();
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.json': 'application/json; charset=utf-8',
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(content);
  });
}

function createApp() {
  return function app(req, res) {
    const { method, url = '/' } = req;
    const pathname = url.split('?')[0];

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      });
      res.end();
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'GET' && pathname === '/') {
      serveStatic(res, 'index.html');
      return;
    }

    if (method === 'GET' && pathname === '/styles.css') {
      serveStatic(res, 'styles.css');
      return;
    }

    if (method === 'GET' && pathname === '/script.js') {
      serveStatic(res, 'script.js');
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/signup') {
      parseJsonBody(req)
        .then(({ name, email, password }) => {
          if (!name || !email || !password) {
            sendJson(res, 400, { error: 'Name, email, and password are required.' });
            return;
          }
          const data = loadData();
          const existing = Object.values(data.users).find((u) => u.email.toLowerCase() === String(email).toLowerCase());
          if (existing) {
            sendJson(res, 409, { error: 'An account with that email already exists.' });
            return;
          }
          const userId = crypto.randomUUID();
          const user = {
            id: userId,
            name: String(name).trim(),
            email: String(email).trim().toLowerCase(),
            password: String(password),
            createdAt: Date.now(),
            data: {
              notes: [],
              reminders: [],
              categories: ['Personal', 'School', 'Work', 'Ideas'],
              tags: [],
              settings: {},
            },
          };
          data.users[userId] = user;
          const token = createToken();
          data.sessions[token] = userId;
          saveData(data);
          sendJson(res, 200, {
            token,
            user: { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt },
            data: user.data,
          });
        })
        .catch((error) => sendJson(res, 400, { error: error.message }));
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      parseJsonBody(req)
        .then(({ email, password }) => {
          if (!email || !password) {
            sendJson(res, 400, { error: 'Email and password are required.' });
            return;
          }
          const data = loadData();
          const user = Object.values(data.users).find((u) => u.email.toLowerCase() === String(email).toLowerCase());
          if (!user || user.password !== String(password)) {
            sendJson(res, 401, { error: 'No account matches that email and password.' });
            return;
          }
          const token = createToken();
          data.sessions[token] = user.id;
          saveData(data);
          const userData = user.data || {};
          sendJson(res, 200, {
            token,
            user: { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt },
            data: {
              notes: userData.notes || [],
              reminders: userData.reminders || [],
              categories: userData.categories || ['Personal', 'School', 'Work', 'Ideas'],
              tags: userData.tags || [],
              settings: userData.settings || {},
            },
          });
        })
        .catch((error) => sendJson(res, 400, { error: error.message }));
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      authenticate(req, res, () => {
        const data = loadData();
        const token = getTokenFromRequest(req);
        delete data.sessions[token];
        saveData(data);
        sendJson(res, 200, { ok: true });
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/me') {
      authenticate(req, res, () => {
        const user = req.user;
        const userData = user.data || {};
        sendJson(res, 200, {
          user: { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt },
          data: {
            notes: userData.notes || [],
            reminders: userData.reminders || [],
            categories: userData.categories || ['Personal', 'School', 'Work', 'Ideas'],
            tags: userData.tags || [],
            settings: userData.settings || {},
          },
        });
      });
      return;
    }

    if (method === 'PUT' && pathname === '/api/me/data') {
      authenticate(req, res, () => {
        parseJsonBody(req)
          .then((body) => {
            const data = loadData();
            const user = req.user;
            user.data = {
              ...(user.data || {}),
              notes: body?.notes || [],
              reminders: body?.reminders || [],
              categories: body?.categories || ['Personal', 'School', 'Work', 'Ideas'],
              tags: body?.tags || [],
              settings: body?.settings || {},
            };
            data.users[user.id] = user;
            saveData(data);
            sendJson(res, 200, { ok: true });
          })
          .catch((error) => sendJson(res, 400, { error: error.message }));
      });
      return;
    }

    if (method === 'PUT' && pathname === '/api/me/profile') {
      authenticate(req, res, () => {
        parseJsonBody(req)
          .then(({ name, email }) => {
            const data = loadData();
            const user = req.user;
            if (!name || !email) {
              sendJson(res, 400, { error: 'Name and email are required.' });
              return;
            }
            const normalizedEmail = String(email).trim().toLowerCase();
            const existing = Object.values(data.users).find((u) => u.id !== user.id && u.email.toLowerCase() === normalizedEmail);
            if (existing) {
              sendJson(res, 409, { error: 'That email already belongs to another account.' });
              return;
            }
            user.name = String(name).trim();
            user.email = normalizedEmail;
            data.users[user.id] = user;
            saveData(data);
            sendJson(res, 200, { user: { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt } });
          })
          .catch((error) => sendJson(res, 400, { error: error.message }));
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  };
}

const app = createApp();
const server = http.createServer(app);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Bloom Notes cloud server running on port ${PORT}`);
  });
}

module.exports = { app, server };
