import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import crypto from 'crypto';

// Load .env manually
const envPath = new URL('.env', import.meta.url).pathname;
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.trim().split('=');
    if (key && !key.startsWith('#') && val.length) {
      process.env[key.trim()] = val.join('=').trim();
    }
  });
}

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 4000;
const WEBSITE_SECRET = process.env.WEBSITE_SECRET || 'dev-website-secret';
const ADMIN_SECRET   = process.env.ADMIN_SECRET   || 'dev-admin-secret';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',').map(s => s.trim());

// ── In-memory store ───────────────────────────────────────────────────────────
// agents: Map<email, AgentRecord>
const agents = new Map();
// activity: rolling buffer of last 500 events
const activity = [];

function recordActivity(email, text, level = 'info') {
  const entry = { ts: Date.now(), email, text, level };
  activity.unshift(entry);
  if (activity.length > 500) activity.pop();
  // broadcast to any open admin SSE connections
  adminClients.forEach(res => sendSSE(res, 'activity', entry));
}

// Admin SSE clients (for real-time push to admin panel)
const adminClients = new Set();
function sendSSE(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.static(join(__dir, 'public')));

// ── Auth helpers ──────────────────────────────────────────────────────────────
function requireWebsite(req, res, next) {
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${WEBSITE_SECRET}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${ADMIN_SECRET}`) return next();
  // also allow query param for browser SSE
  if (req.query.secret === ADMIN_SECRET) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Admin API ─────────────────────────────────────────────────────────────────

// GET /api/admin/agents — list all known agents
app.get('/api/admin/agents', requireAdmin, (req, res) => {
  const list = [...agents.values()].map(a => ({
    email:        a.email,
    version:      a.version || '?',
    online:       a.ws?.readyState === WebSocket.OPEN,
    connectedAt:  a.connectedAt,
    lastPing:     a.lastPing,
    integrations: a.integrations || [],
    agentId:      a.agentId,
  }));
  res.json({ agents: list, total: list.length, online: list.filter(a => a.online).length });
});

// GET /api/admin/activity — recent activity log
app.get('/api/admin/activity', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100'), 500);
  res.json({ activity: activity.slice(0, limit) });
});

// GET /api/admin/stream — SSE stream for real-time updates
app.get('/api/admin/stream', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current state immediately
  sendSSE(res, 'agents', [...agents.values()].map(a => ({
    email: a.email, online: a.ws?.readyState === WebSocket.OPEN,
    integrations: a.integrations || [], version: a.version,
  })));

  adminClients.add(res);
  req.on('close', () => adminClients.delete(res));
});

// POST /api/admin/command — send a command to a specific agent
app.post('/api/admin/command', requireAdmin, (req, res) => {
  const { email, action, payload } = req.body;
  if (!email || !action) return res.status(400).json({ error: 'email and action required' });

  const agent = agents.get(email.toLowerCase());
  if (!agent || agent.ws?.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: 'Agent not connected' });
  }

  wsSend(agent.ws, { type: 'command', action, payload });
  recordActivity(email, `Admin sent command: ${action}`, 'warn');
  res.json({ ok: true });
});

// ── Setup codes ───────────────────────────────────────────────────────────────
// setupCodes: Map<code, { email, config, createdAt, used }>
const setupCodes = new Map();
// chatTokens: Map<chatCode, email>  — permanent, used for mobile web chat
const chatTokens = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'TW-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// POST /api/setup/generate — website calls this after user completes setup
app.post('/api/setup/generate', requireWebsite, (req, res) => {
  const { email, llmBaseUrl, llmApiKey, llmModel, botToken, chatId } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  const normalEmail = email.toLowerCase();

  // Expire old setup codes for this email
  for (const [k, v] of setupCodes.entries()) {
    if (v.email === normalEmail) setupCodes.delete(k);
  }

  const code = generateCode();
  setupCodes.set(code, {
    email:      normalEmail,
    llmBaseUrl: llmBaseUrl || 'https://api.groq.com/openai/v1',
    llmApiKey:  llmApiKey  || '',
    llmModel:   llmModel   || 'meta-llama/llama-4-scout-17b-16e-instruct',
    botToken:   botToken   || '',
    chatId:     chatId     || '',
    createdAt:  Date.now(),
    used:       false,
  });

  // Setup code expires after 24 hours (user may need time to install the app)
  setTimeout(() => setupCodes.delete(code), 24 * 60 * 60 * 1000);

  // Also issue a persistent chat token for this email (overwrite old one)
  let chatCode = null;
  for (const [k, v] of chatTokens.entries()) {
    if (v === normalEmail) { chatCode = k; break; }
  }
  if (!chatCode) {
    chatCode = generateCode();
    chatTokens.set(chatCode, normalEmail);
  }

  recordActivity(normalEmail, `Setup code generated: ${code}`, 'info');
  res.json({ ok: true, code, chatCode });
});

// POST /api/setup/redeem — app calls this with the code
app.post('/api/setup/redeem', (req, res) => {
  const code = (req.body.code || '').toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: 'code required' });

  const entry = setupCodes.get(code);
  if (!entry)       return res.status(404).json({ ok: false, error: 'Code not found or expired' });
  if (entry.used)   return res.status(410).json({ ok: false, error: 'Code already used' });

  entry.used = true;
  recordActivity(entry.email, `Setup code redeemed by app`, 'success');

  res.json({
    ok:         true,
    email:      entry.email,
    llmBaseUrl: entry.llmBaseUrl,
    llmApiKey:  entry.llmApiKey,
    llmModel:   entry.llmModel,
    botToken:   entry.botToken,
    chatId:     entry.chatId,
  });
});

// POST /api/admin/setup-code — admin generates a test code manually
app.post('/api/admin/setup-code', requireAdmin, (req, res) => {
  const { email, llmBaseUrl, llmApiKey, llmModel, botToken, chatId } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  for (const [k, v] of setupCodes.entries()) {
    if (v.email === email.toLowerCase()) setupCodes.delete(k);
  }

  const code = generateCode();
  setupCodes.set(code, {
    email:      email.toLowerCase(),
    llmBaseUrl: llmBaseUrl || 'https://api.groq.com/openai/v1',
    llmApiKey:  llmApiKey  || '',
    llmModel:   llmModel   || 'meta-llama/llama-4-scout-17b-16e-instruct',
    botToken:   botToken   || '',
    chatId:     chatId     || '',
    createdAt:  Date.now(),
    used:       false,
  });

  setTimeout(() => setupCodes.delete(code), 24 * 60 * 60 * 1000);
  recordActivity(email, `Admin generated test code: ${code}`, 'warn');
  res.json({ ok: true, code });
});

// ── Website relay API ─────────────────────────────────────────────────────────

// Pending chat requests: requestId → { resolve, reject, timer }
const pendingChats = new Map();

// POST /api/relay/chat — website sends a message, hub forwards to agent and waits for reply
app.post('/api/relay/chat', requireWebsite, async (req, res) => {
  const { email, message, sessionId } = req.body;
  if (!email || !message) return res.status(400).json({ error: 'email and message required' });

  const agent = agents.get(email.toLowerCase());
  if (!agent?.ws || agent.ws.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ error: 'Agent offline', offline: true });
  }

  const requestId = crypto.randomUUID();

  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingChats.delete(requestId);
        reject(new Error('timeout'));
      }, 90_000);

      pendingChats.set(requestId, { resolve, reject, timer });
      wsSend(agent.ws, { type: 'chat_request', requestId, message, sessionId: sessionId || null });
    });
    res.json(result);
  } catch (err) {
    res.status(504).json({ error: err.message });
  }
});

// POST /api/relay/token — website pushes a new token, we relay to agent
app.post('/api/relay/token', requireWebsite, (req, res) => {
  const { email, integrationId, token } = req.body;
  if (!email || !integrationId) return res.status(400).json({ error: 'email and integrationId required' });

  const normalEmail = email.toLowerCase();
  const agent = agents.get(normalEmail);

  // Push to agent if online
  if (agent?.ws?.readyState === WebSocket.OPEN) {
    wsSend(agent.ws, { type: 'token', integrationId, token: token || '' });
    recordActivity(normalEmail, `Token pushed: ${integrationId}`, 'success');
  } else {
    recordActivity(normalEmail, `Token saved (agent offline): ${integrationId}`, 'info');
  }

  res.json({ ok: true, delivered: agent?.ws?.readyState === WebSocket.OPEN });
});

// POST /api/relay/activity — website or agent POSTs an activity event
app.post('/api/relay/activity', requireWebsite, (req, res) => {
  const { email, text, level } = req.body;
  if (email && text) recordActivity(email, text, level || 'info');
  res.json({ ok: true });
});

// POST /api/relay/chat-by-code — mobile website chats using persistent chat code (no account login needed)
app.post('/api/relay/chat-by-code', async (req, res) => {
  const { code, message, sessionId } = req.body;
  if (!code || !message) return res.status(400).json({ error: 'code and message required' });

  const email = chatTokens.get(code.toUpperCase().trim());
  if (!email) return res.status(404).json({ error: 'Invalid code', invalid: true });

  const agent = agents.get(email);
  if (!agent?.ws || agent.ws.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ error: 'Agent offline', offline: true });
  }

  const requestId = crypto.randomUUID();
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingChats.delete(requestId);
        reject(new Error('timeout'));
      }, 90_000);
      pendingChats.set(requestId, { resolve, reject, timer });
      wsSend(agent.ws, { type: 'chat_request', requestId, message, sessionId: sessionId || null });
    });
    res.json(result);
  } catch (err) {
    res.status(504).json({ error: err.message });
  }
});

// GET /api/relay/agent-status — website checks if a user's agent is online
app.get('/api/relay/agent-status', requireWebsite, (req, res) => {
  const email = (req.query.email || '').toLowerCase();
  const agent = agents.get(email);
  res.json({
    online: agent?.ws?.readyState === WebSocket.OPEN || false,
    lastPing: agent?.lastPing || null,
    version: agent?.version || null,
    integrations: agent?.integrations || [],
  });
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, agents: agents.size }));

// ── Admin panel (served from public/admin.html) ───────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(join(__dir, 'public', 'admin.html'));
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function wsSend(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

wss.on('connection', (ws, req) => {
  let agentEmail = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'register': {
        const email = (msg.email || '').toLowerCase().trim();
        if (!email) return;
        agentEmail = email;

        const existing = agents.get(email) || {};
        agents.set(email, {
          ...existing,
          email,
          ws,
          agentId:      msg.agentId || crypto.randomUUID(),
          version:      msg.version || '?',
          os:           msg.os || existing.os || 'unknown',
          connectedAt:  Date.now(),
          lastPing:     Date.now(),
          integrations: msg.integrations || existing.integrations || [],
        });

        wsSend(ws, { type: 'registered', agentId: agents.get(email).agentId });
        recordActivity(email, `Agent connected (v${msg.version || '?'})`, 'success');

        // Notify admin panel
        adminClients.forEach(res => sendSSE(res, 'agent_online', {
          email, version: msg.version, online: true, integrations: msg.integrations || [],
        }));
        break;
      }

      case 'ping': {
        if (agentEmail && agents.has(agentEmail)) {
          agents.get(agentEmail).lastPing = Date.now();
        }
        wsSend(ws, { type: 'pong' });
        break;
      }

      case 'activity': {
        if (agentEmail) {
          recordActivity(agentEmail, msg.text || '', msg.level || 'info');
        }
        break;
      }

      case 'integrations_update': {
        if (agentEmail && agents.has(agentEmail)) {
          agents.get(agentEmail).integrations = msg.integrations || [];
          adminClients.forEach(res => sendSSE(res, 'agent_update', {
            email: agentEmail, integrations: msg.integrations,
          }));
        }
        break;
      }

      case 'chat_response': {
        const pending = pendingChats.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingChats.delete(msg.requestId);
          pending.resolve({ reply: msg.text, sessionId: msg.sessionId });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (agentEmail && agents.has(agentEmail)) {
      agents.get(agentEmail).ws = null;
      recordActivity(agentEmail, 'Agent disconnected', 'warn');
      adminClients.forEach(res => sendSSE(res, 'agent_offline', { email: agentEmail }));
    }
  });

  ws.on('error', () => {});
});

// Clean up dead connections every 60s
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.readyState !== WebSocket.OPEN) ws.terminate();
  });
}, 60_000);

server.listen(PORT, () => {
  console.log(`Twain server running on port ${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
});
