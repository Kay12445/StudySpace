require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

// ═══════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'studyspace-dev-secret-change-in-prod';
const DATABASE_URL = process.env.DATABASE_URL;

// ═══════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════
let pool = null;
let useDB = false;

if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  useDB = true;
}

// In-memory fallback when no DB
const memDB = {
  users: new Map(),
  sessions: new Map(),
  rooms: new Map(),
  messages: new Map(),
  streaks: new Map(),
};



async function dbQuery(sql, params = []) {
  if (!useDB) return null;
  try { return await pool.query(sql, params); }
  catch (e) { console.error('DB error:', e.message); return null; }
}

async function initDB() {
  if (!useDB) { console.log('⚠️  No DATABASE_URL — using in-memory storage'); return; }
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(50) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_color VARCHAR(20) DEFAULT '#c8a96e',
      city VARCHAR(50) DEFAULT 'Шымкент',
      role VARCHAR(20) DEFAULT 'student',
      total_minutes INT DEFAULT 0,
      total_sessions INT DEFAULT 0,
      streak_days INT DEFAULT 0,
      longest_streak INT DEFAULT 0,
      last_active DATE,
      weekly_goal_minutes INT DEFAULT 300,
      bio TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS focus_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      room_id TEXT,
      minutes INT NOT NULL,
      subject VARCHAR(50),
      completed_at TIMESTAMP DEFAULT NOW()
    )`);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS rooms (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      host_id UUID REFERENCES users(id),
      host_name VARCHAR(50),
      subject VARCHAR(50),
      max_participants INT DEFAULT 20,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS weekly_goals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      week_start DATE,
      goal_minutes INT DEFAULT 300,
      actual_minutes INT DEFAULT 0,
      UNIQUE(user_id, week_start)
    )`);
  console.log('✅ Database initialized');
}

// ═══════════════════════════════════════════
//  EXPRESS
// ═══════════════════════════════════════════
const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

// Auth middleware
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function adminAuth(req, res, next) {
  auth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// ─── AUTH ROUTES ───────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, city = 'Шымкент' } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  if (password.length < 6) return res.status(400).json({ error: 'Password too short' });

  const hash = await bcrypt.hash(password, 10);
  const color = ['#c8a96e','#60a5fa','#4ade80','#f87171','#a78bfa','#fb923c'][Math.floor(Math.random()*6)];

  if (useDB) {
    const r = await dbQuery(
      'INSERT INTO users (name,email,password_hash,avatar_color,city) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,avatar_color,city,role,total_minutes,total_sessions,streak_days,weekly_goal_minutes',
      [name, email, hash, color, city]
    );
    if (!r) return res.status(400).json({ error: 'Email already exists' });
    const user = r.rows[0];
    const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ token, user });
  } else {
    // mem fallback
    for (const u of memDB.users.values()) if (u.email === email) return res.status(400).json({ error: 'Email exists' });
    const id = uuid();
    const user = { id, name, email, password_hash: hash, avatar_color: color, city, role: 'student',
      total_minutes: 0, total_sessions: 0, streak_days: 0, longest_streak: 0,
      last_active: null, weekly_goal_minutes: 300, bio: '', created_at: new Date() };
    memDB.users.set(id, user);
    const token = jwt.sign({ id, name, role: 'student' }, JWT_SECRET, { expiresIn: '30d' });
    const { password_hash: _, ...safe } = user;
    return res.json({ token, user: safe });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  let user;

  if (useDB) {
    const r = await dbQuery('SELECT * FROM users WHERE email=$1', [email]);
    user = r?.rows[0];
  } else {
    for (const u of memDB.users.values()) if (u.email === email) { user = u; break; }
  }

  if (!user || !await bcrypt.compare(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid credentials' });

  // Update streak
  await updateStreak(user.id);

  const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  const { password_hash: _, ...safe } = user;
  res.json({ token, user: safe });
});

app.get('/api/auth/me', auth, async (req, res) => {
  let user;
  if (useDB) {
    const r = await dbQuery('SELECT id,name,email,avatar_color,city,role,total_minutes,total_sessions,streak_days,longest_streak,weekly_goal_minutes,bio,created_at FROM users WHERE id=$1', [req.user.id]);
    user = r?.rows[0];
  } else {
    const u = memDB.users.get(req.user.id);
    if (u) { const { password_hash: _, ...safe } = u; user = safe; }
  }
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// ─── STREAK ───────────────────────────────
async function updateStreak(userId) {
  const today = new Date().toISOString().slice(0,10);
  if (useDB) {
    const r = await dbQuery('SELECT last_active, streak_days, longest_streak FROM users WHERE id=$1', [userId]);
    if (!r?.rows[0]) return;
    const { last_active, streak_days, longest_streak } = r.rows[0];
    const last = last_active ? new Date(last_active).toISOString().slice(0,10) : null;
    let newStreak = streak_days;
    if (last === today) return;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
    newStreak = (last === yesterday) ? streak_days + 1 : 1;
    const newLongest = Math.max(newStreak, longest_streak || 0);
    await dbQuery('UPDATE users SET last_active=$1, streak_days=$2, longest_streak=$3 WHERE id=$4',
      [today, newStreak, newLongest, userId]);
  } else {
    const u = memDB.users.get(userId);
    if (!u) return;
    const last = u.last_active;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
    u.streak_days = (last === yesterday) ? u.streak_days + 1 : 1;
    u.longest_streak = Math.max(u.streak_days, u.longest_streak);
    u.last_active = today;
  }
}

// ─── PROFILE ───────────────────────────────
app.get('/api/profile/:id', async (req, res) => {
  let user;
  if (useDB) {
    const r = await dbQuery(
      'SELECT id,name,avatar_color,city,total_minutes,total_sessions,streak_days,longest_streak,weekly_goal_minutes,bio,created_at FROM users WHERE id=$1',
      [req.params.id]);
    user = r?.rows[0];
  } else {
    const u = memDB.users.get(req.params.id);
    if (u) { const { password_hash:_, email:__, ...safe } = u; user = safe; }
  }
  if (!user) return res.status(404).json({ error: 'Not found' });

  // Weekly progress
  const weekStart = getWeekStart();
  let weekMinutes = 0;
  if (useDB) {
    const w = await dbQuery(
      'SELECT COALESCE(SUM(minutes),0) as mins FROM focus_sessions WHERE user_id=$1 AND completed_at >= $2',
      [req.params.id, weekStart]);
    weekMinutes = parseInt(w?.rows[0]?.mins || 0);
  }

  res.json({ user: { ...user, weekMinutes } });
});

app.patch('/api/profile', auth, async (req, res) => {
  const { bio, city, weekly_goal_minutes, name } = req.body;
  if (useDB) {
    await dbQuery('UPDATE users SET bio=COALESCE($1,bio), city=COALESCE($2,city), weekly_goal_minutes=COALESCE($3,weekly_goal_minutes), name=COALESCE($4,name) WHERE id=$5',
      [bio, city, weekly_goal_minutes, name, req.user.id]);
  } else {
    const u = memDB.users.get(req.user.id);
    if (u) { if(bio!==undefined)u.bio=bio; if(city)u.city=city; if(weekly_goal_minutes)u.weekly_goal_minutes=weekly_goal_minutes; if(name)u.name=name; }
  }
  res.json({ ok: true });
});

// ─── FOCUS SESSIONS ───────────────────────
app.post('/api/focus/complete', auth, async (req, res) => {
  const { minutes, subject, room_id } = req.body;
  if (!minutes || minutes < 1) return res.status(400).json({ error: 'Invalid minutes' });

  if (useDB) {
    await dbQuery('INSERT INTO focus_sessions (user_id,room_id,minutes,subject) VALUES($1,$2,$3,$4)',
      [req.user.id, room_id, minutes, subject || 'Общий']);
    await dbQuery('UPDATE users SET total_minutes=total_minutes+$1, total_sessions=total_sessions+1 WHERE id=$2',
      [minutes, req.user.id]);
    await updateStreak(req.user.id);
  } else {
    const u = memDB.users.get(req.user.id);
    if (u) { u.total_minutes += minutes; u.total_sessions += 1; }
    await updateStreak(req.user.id);
    const sid = uuid();
    memDB.sessions.set(sid, { id: sid, user_id: req.user.id, room_id, minutes, subject, completed_at: new Date() });
  }

  // Broadcast leaderboard update via WS
  broadcastLeaderboard();
  res.json({ ok: true, xp: minutes * 2 });
});

app.get('/api/focus/history', auth, async (req, res) => {
  let sessions = [];
  if (useDB) {
    const r = await dbQuery(
      'SELECT minutes,subject,completed_at FROM focus_sessions WHERE user_id=$1 ORDER BY completed_at DESC LIMIT 50',
      [req.user.id]);
    sessions = r?.rows || [];
  } else {
    for (const s of memDB.sessions.values())
      if (s.user_id === req.user.id) sessions.push(s);
    sessions.sort((a,b) => new Date(b.completed_at) - new Date(a.completed_at));
  }
  res.json({ sessions });
});

// ─── LEADERBOARD ──────────────────────────
app.get('/api/leaderboard', async (req, res) => {
  const { period = 'week', limit = 20 } = req.query;
  let rows = [];

  if (useDB) {
    let sql;
    if (period === 'week') {
      sql = `SELECT u.id, u.name, u.avatar_color, u.city, u.streak_days,
             COALESCE(SUM(f.minutes),0) as minutes, COUNT(f.id) as sessions
             FROM users u LEFT JOIN focus_sessions f ON f.user_id=u.id
             AND f.completed_at >= $1
             GROUP BY u.id ORDER BY minutes DESC LIMIT $2`;
      rows = (await dbQuery(sql, [getWeekStart(), limit]))?.rows || [];
    } else if (period === 'month') {
      sql = `SELECT u.id, u.name, u.avatar_color, u.city, u.streak_days,
             COALESCE(SUM(f.minutes),0) as minutes, COUNT(f.id) as sessions
             FROM users u LEFT JOIN focus_sessions f ON f.user_id=u.id
             AND f.completed_at >= date_trunc('month', NOW())
             GROUP BY u.id ORDER BY minutes DESC LIMIT $1`;
      rows = (await dbQuery(sql, [limit]))?.rows || [];
    } else {
      sql = `SELECT id, name, avatar_color, city, streak_days, total_minutes as minutes, total_sessions as sessions
             FROM users ORDER BY total_minutes DESC LIMIT $1`;
      rows = (await dbQuery(sql, [limit]))?.rows || [];
    }
  } else {
    rows = [];
  }

  res.json({ period, rows: rows.map((r,i) => ({ ...r, rank: i+1 })) });
});

// ─── ROOMS ────────────────────────────────
app.get('/api/rooms', async (req, res) => {
  let rooms = [];
  if (useDB) {
    const r = await dbQuery(`SELECT r.*, COUNT(DISTINCT p.user_id) as online
      FROM rooms r LEFT JOIN room_participants p ON p.room_id=r.id
      WHERE r.is_active=true GROUP BY r.id ORDER BY r.created_at DESC`);
    rooms = r?.rows || [];
  } else {
    rooms = [...memDB.rooms.values()].filter(r => r.active);
  }
  res.json({ data: rooms });
});

app.post('/api/rooms', auth, async (req, res) => {
  const { name, subject = 'Общий', maxParticipants = 20 } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  let room;
  if (useDB) {
    const r = await dbQuery(
      'INSERT INTO rooms (name,host_id,host_name,subject,max_participants) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [name, req.user.id, req.user.name, subject, maxParticipants]);
    room = r?.rows[0];
  } else {
    const id = uuid();
    room = { id, name, host: req.user.name, host_id: req.user.id, subject, participants: 1, maxParticipants, focusCount: 0, active: true, createdAt: new Date() };
    memDB.rooms.set(id, room);
  }

  broadcast({ type: 'room_created', payload: { room } });
  res.json({ data: room });
});

// ─── ADMIN ────────────────────────────────
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  let stats = {};
  if (useDB) {
    const [users, sessions, todaySessions, activeRooms] = await Promise.all([
      dbQuery('SELECT COUNT(*) as c FROM users'),
      dbQuery('SELECT COALESCE(SUM(minutes),0) as m, COUNT(*) as c FROM focus_sessions'),
      dbQuery("SELECT COUNT(*) as c FROM focus_sessions WHERE completed_at::date = CURRENT_DATE"),
      dbQuery('SELECT COUNT(*) as c FROM rooms WHERE is_active=true'),
    ]);
    stats = {
      totalUsers: parseInt(users?.rows[0]?.c || 0),
      totalMinutes: parseInt(sessions?.rows[0]?.m || 0),
      totalSessions: parseInt(sessions?.rows[0]?.c || 0),
      todaySessions: parseInt(todaySessions?.rows[0]?.c || 0),
      activeRooms: parseInt(activeRooms?.rows[0]?.c || 0),
      onlineNow: wsClients.size,
    };
  } else {
    stats = {
      totalUsers: memDB.users.size,
      totalMinutes: [...memDB.users.values()].reduce((a,u) => a + (u.total_minutes||0), 0),
      totalSessions: memDB.sessions.size,
      todaySessions: 0,
      activeRooms: memDB.rooms.size,
      onlineNow: wsClients.size,
    };
  }
  res.json(stats);
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
  let users = [];
  if (useDB) {
    const r = await dbQuery('SELECT id,name,email,city,role,total_minutes,total_sessions,streak_days,created_at FROM users ORDER BY created_at DESC LIMIT 100');
    users = r?.rows || [];
  } else {
    users = [...memDB.users.values()].map(({ password_hash, ...u }) => u);
  }
  res.json({ users });
});

app.patch('/api/admin/users/:id', adminAuth, async (req, res) => {
  const { role } = req.body;
  if (useDB) await dbQuery('UPDATE users SET role=$1 WHERE id=$2', [role, req.params.id]);
  else { const u = memDB.users.get(req.params.id); if(u) u.role = role; }
  res.json({ ok: true });
});

app.delete('/api/admin/rooms/:id', adminAuth, async (req, res) => {
  if (useDB) await dbQuery('UPDATE rooms SET is_active=false WHERE id=$1', [req.params.id]);
  else { const r = memDB.rooms.get(req.params.id); if(r) r.active = false; }
  broadcast({ type: 'room_deleted', payload: { id: req.params.id } });
  res.json({ ok: true });
});

// ─── PLACES ───────────────────────────────
const PLACES = {
  'Шымкент': [
    { id:1, name:'Центральная библиотека', address:'пр. Республики, 37', lat:42.3417, lng:69.5901, type:'library', rating:4.8 },
    { id:2, name:'SmartHub Coworking', address:'ул. Байтурсынова, 12', lat:42.3380, lng:69.5950, type:'cowork', rating:4.9 },
    { id:3, name:'Кофейня «Атмосфера»', address:'ул. Казыбек би, 45', lat:42.3401, lng:69.5870, type:'cafe', rating:4.7 },
    { id:4, name:'Библиотека ЮКГУ', address:'пр. Аль-Фараби, 5', lat:42.3450, lng:69.5920, type:'library', rating:4.6 },
    { id:5, name:'WorkSpace', address:'ул. Дулати, 7', lat:42.3360, lng:69.5980, type:'cowork', rating:4.8 },
  ],
  'Алматы': [
    { id:10, name:'Coworking Space Almaty', address:'ул. Панфилова, 98', lat:43.2566, lng:76.9286, type:'cowork', rating:4.9 },
    { id:11, name:'Дворец студентов', address:'пр. Абая, 1', lat:43.2401, lng:76.9128, type:'library', rating:4.7 },
  ],
  'Астана': [
    { id:20, name:'НУБиП Библиотека', address:'пр. Кабанбай батыра, 53', lat:51.1745, lng:71.4492, type:'library', rating:4.8 },
  ]
};

app.get('/api/places', (req, res) => {
  const city = req.query.city || 'Шымкент';
  res.json({ data: PLACES[city] || [] });
});

// ─── HEALTH ───────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, db: useDB, ws: wsClients.size, ts: new Date().toISOString() }));

// ═══════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });
const wsClients = new Set();
const wsUsers = new Map(); // ws -> user info
const roomOccupants = new Map(); // roomId -> Set of ws

function broadcast(msg, exclude = null) {
  const str = JSON.stringify(msg);
  for (const c of wsClients) {
    if (c !== exclude && c.readyState === 1) c.send(str);
  }
}

function broadcastToRoom(roomId, msg, exclude = null) {
  const occupants = roomOccupants.get(roomId);
  if (!occupants) return;
  const str = JSON.stringify(msg);
  for (const c of occupants) {
    if (c !== exclude && c.readyState === 1) c.send(str);
  }
}

async function broadcastLeaderboard() {
  try {
    const r = await fetch(`http://localhost:${PORT}/api/leaderboard?limit=10`);
    const data = await r.json();
    broadcast({ type: 'leaderboard_update', payload: data });
  } catch {}
}

wss.on('connection', (ws, req) => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'online_count', payload: { count: wsClients.size } }));
  broadcast({ type: 'online_count', payload: { count: wsClients.size } });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'auth' && msg.token) {
        try {
          const user = jwt.verify(msg.token, JWT_SECRET);
          wsUsers.set(ws, user);
          ws.send(JSON.stringify({ type: 'auth_ok', payload: { name: user.name } }));
        } catch { ws.send(JSON.stringify({ type: 'auth_error' })); }
      }

      if (msg.type === 'join_room') {
        const user = wsUsers.get(ws);
        if (!user) return;
        const rid = msg.roomId;
        // Leave previous rooms
        for (const [roomId, occupants] of roomOccupants) {
          if (occupants.has(ws)) {
            occupants.delete(ws);
            broadcastToRoom(roomId, { type: 'user_left', payload: { name: user.name, roomId } });
          }
        }
        if (!roomOccupants.has(rid)) roomOccupants.set(rid, new Set());
        roomOccupants.get(rid).add(ws);
        broadcastToRoom(rid, { type: 'user_joined', payload: { name: user.name, color: user.color || '#c8a96e', roomId: rid } }, ws);
        ws.send(JSON.stringify({ type: 'room_joined', payload: { roomId: rid, occupants: roomOccupants.get(rid).size } }));
      }

      if (msg.type === 'chat_message') {
        const user = wsUsers.get(ws);
        if (!user || !msg.roomId || !msg.text) return;
        const text = String(msg.text).slice(0, 500);
        broadcastToRoom(msg.roomId, {
          type: 'chat_message',
          payload: { id: uuid(), name: user.name, color: user.color || '#c8a96e', text, time: new Date().toISOString(), roomId: msg.roomId }
        });
      }

      if (msg.type === 'focus_start') {
        const user = wsUsers.get(ws);
        if (!user || !msg.roomId) return;
        broadcastToRoom(msg.roomId, { type: 'focus_start', payload: { name: user.name, roomId: msg.roomId } }, ws);
      }

      if (msg.type === 'focus_done') {
        const user = wsUsers.get(ws);
        if (!user || !msg.roomId) return;
        broadcastToRoom(msg.roomId, { type: 'focus_done', payload: { name: user.name, minutes: msg.minutes, roomId: msg.roomId } }, ws);
      }

    } catch (e) { /* ignore malformed */ }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    const user = wsUsers.get(ws);
    if (user) {
      for (const [roomId, occupants] of roomOccupants) {
        if (occupants.has(ws)) {
          occupants.delete(ws);
          broadcastToRoom(roomId, { type: 'user_left', payload: { name: user.name, roomId } });
        }
      }
    }
    wsUsers.delete(ws);
    broadcast({ type: 'online_count', payload: { count: wsClients.size } });
  });
});

// ═══════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════
function getWeekStart() {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() + 1);
  return d.toISOString().slice(0,10);
}

// ═══════════════════════════════════════════
//  START
// ═══════════════════════════════════════════
initDB().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`\n🟢 StudySpace v2.0 — http://localhost:${PORT}`);
    console.log(`📡 WebSocket ready`);
    console.log(`🗄️  Database: ${useDB ? 'PostgreSQL' : 'In-memory'}`);
    console.log(`\n📋 Routes:`);
    console.log(`   POST /api/auth/register`);
    console.log(`   POST /api/auth/login`);
    console.log(`   GET  /api/leaderboard`);
    console.log(`   GET  /api/rooms`);
    console.log(`   GET  /api/admin/stats  (admin only)`);
  });
});