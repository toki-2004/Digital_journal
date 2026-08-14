#!/usr/bin/env node
/**
 * ============================================================================
 *  自托管实时协同电子手账 - 后端服务 (server.js)
 * ============================================================================
 *
 * 【依赖安装】
 *   在项目目录执行：  npm install express socket.io
 *
 * 【启动方式】
 *   node server.js
 *   服务默认监听 0.0.0.0:3000，浏览器访问  http://localhost:3000
 *   如需修改端口：  PORT=8080 node server.js   (Windows PowerShell:  $env:PORT=8080; node server.js)
 *
 * 【数据存储】
 *   - ./data/rooms.json        ：房间元信息索引（名称 / 密码哈希 / 权限 / 封面等）
 *   - ./data/<房间ID>.json     ：每个房间的画布全量数据（图片、标注、操作历史）
 *   - 所有写入都经过串行队列，避免并发写坏文件；删除房间前请确认。
 *
 * 【对外分享（内网穿透）】
 *   ngrok：   ngrok http 3000
 *   frp：     客户端配置 local_port = 3000，服务端 remote_port 任意，例如 80/8080
 *   然后把生成的公网地址发给协作者即可；房间访问密码可防止陌生人进入。
 *
 * 【安全说明】
 *   本项目面向家庭 / 小团队内网使用。房间密码以 SHA-256 哈希保存，且不会下发给
 *   浏览器；但服务本身未做 HTTPS、限流与账号体系，请勿直接暴露到公网不设防使用。
 *
 * 【通信协议】
 *   - REST：首次加载房间数据、房间列表、新建/重命名/删除/设置房间
 *   - Socket.io：实时广播画布操作、光标位置、在线成员、元素锁定
 * ============================================================================
 */
'use strict';

// 控制台窗口标题（Windows）：提示用户关闭窗口即可停止服务
process.title = 'Digital Journal Server (close this window to stop)';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const INDEX_FILE = path.join(DATA_DIR, 'rooms.json');
const MAX_BODY = 100 * 1024 * 1024; // 100MB，容纳压缩后的图片 Base64
const MAX_HISTORY = 1000;           // 每个房间最多保留的操作历史条数

/* ---------------------------------------------------------------------------
 * 工具函数：JSON 读写（原子写入 + 每把钥匙一条串行队列）
 * ------------------------------------------------------------------------- */
const writeQueues = new Map();

function enqueue(key, fn) {
  const prev = writeQueues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn); // 上一条失败也不阻塞后续
  writeQueues.set(key, next.catch(() => {}));
  return next;
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSONAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* ---------------------------------------------------------------------------
 * 房间索引（rooms.json）
 * ------------------------------------------------------------------------- */
function loadIndex() {
  ensureDataDir();
  const index = readJSON(INDEX_FILE, null);
  if (index && typeof index.rooms === 'object') return index;
  // 索引缺失 / 损坏时，尝试从 data 目录里的房间文件重建
  const rooms = {};
  for (const name of fs.readdirSync(DATA_DIR)) {
    if (!name.endsWith('.json') || name === 'rooms.json') continue;
    const room = readJSON(path.join(DATA_DIR, name), null);
    if (room && room.id) {
      rooms[room.id] = {
        id: room.id,
        name: room.name || '未命名手账',
        password: room.password || '',
        editPermission: room.editPermission || 'editable',
        createdBy: room.createdBy || '',
        createdAt: room.createdAt || Date.now(),
        lastModified: room.lastModified || Date.now(),
        cover: room.cover || null,
      };
    }
  }
  const rebuilt = { rooms, rebuilt: true };
  writeJSONAtomic(INDEX_FILE, rebuilt);
  return rebuilt;
}

function saveIndex(index) {
  enqueue('index', () => writeJSONAtomic(INDEX_FILE, index));
}

function getIndex() {
  // 内存缓存一份，避免每次请求都读盘
  if (!getIndex._cache) getIndex._cache = loadIndex();
  return getIndex._cache;
}

function persistIndex() {
  enqueue('index', () => writeJSONAtomic(INDEX_FILE, getIndex()));
}

function touchRoomMeta(roomId, patch) {
  const index = getIndex();
  const meta = index.rooms[roomId];
  if (!meta) return;
  Object.assign(meta, patch, { lastModified: new Date().toISOString() });
  persistIndex();
}

/* ---------------------------------------------------------------------------
 * 房间数据文件（data/<房间ID>.json）
 * ------------------------------------------------------------------------- */
function roomFile(id) {
  return path.join(DATA_DIR, String(id) + '.json');
}

function loadRoom(id) {
  return readJSON(roomFile(id), null);
}

// 内存缓存：同一进程内所有实时操作共享同一份房间对象，避免并发读写互相覆盖
const roomCache = new Map();

function getRoom(id) {
  if (roomCache.has(id)) return roomCache.get(id);
  const room = loadRoom(id);
  if (room) {
    migrateRoom(room);
    roomCache.set(id, room);
  }
  return room;
}

/** 兼容旧版单页数据：把顶层 images/annotations 迁移为 pages[0] */
function migrateRoom(room) {
  if (!Array.isArray(room.pages) || !room.pages.length) {
    room.pages = [{
      id: 'page_1',
      name: '第 1 页',
      images: room.images || [],
      annotations: room.annotations || [],
    }];
    delete room.images;
    delete room.annotations;
  }
  return room;
}

function saveRoom(id, room) {
  roomCache.set(id, room);
  enqueue('room:' + id, () => writeJSONAtomic(roomFile(id), room));
}

function deleteRoomFile(id) {
  roomCache.delete(id);
  const file = roomFile(id);
  enqueue('room:' + id, () => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
}

function hashPassword(pw, roomId) {
  return crypto.createHash('sha256').update(String(pw) + '::' + roomId).digest('hex');
}

function newRoomId() {
  return 'room_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

/** 下发给浏览器的房间数据（轻量版）：只含页面元信息，不含页面内容，避免大房间一次性推流 */
function sanitizeRoom(room, locks) {
  const lockMap = {};
  if (locks) {
    for (const [key, lock] of locks) {
      const sep = String(key).indexOf('::');
      if (sep > 0) lockMap[key.slice(sep + 2)] = lock;
    }
  }
  return {
    id: room.id,
    name: room.name,
    editPermission: room.editPermission,
    createdBy: room.createdBy,
    createdAt: room.createdAt,
    lastModified: room.lastModified,
    revision: room.revision || 0,
    hasPassword: !!room.password,
    pages: (room.pages || []).map((p) => ({
      id: p.id,
      name: p.name,
      imageCount: (p.images || []).length,
      annotationCount: (p.annotations || []).length,
    })),
    history: room.history || [],
    locks: lockMap,
  };
}

/* ---------------------------------------------------------------------------
 * REST API
 * ------------------------------------------------------------------------- */
const app = express();
app.use(express.json({ limit: MAX_BODY }));

// 只提供首页一个文件，绝不把 data 目录暴露出去
app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// 房间列表
app.get('/api/rooms', (req, res) => {
  const index = getIndex();
  const list = Object.values(index.rooms)
    .map((r) => ({
      id: r.id,
      name: r.name,
      lastModified: r.lastModified,
      createdAt: r.createdAt,
      createdBy: r.createdBy,
      editPermission: r.editPermission,
      hasPassword: !!r.password,
      cover: r.cover || null,
    }))
    .sort((a, b) => String(b.lastModified).localeCompare(String(a.lastModified)));
  res.json(list);
});

// 新建房间
app.post('/api/rooms', (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ error: '手账本名称不能为空' });
  const id = newRoomId();
  const now = new Date().toISOString();
  const room = {
    id,
    name,
    password: body.password ? hashPassword(String(body.password), id) : '',
    editPermission: body.editPermission === 'readonly' ? 'readonly' : 'editable',
    createdBy: (body.user && body.user.id) || '',
    createdAt: now,
    lastModified: now,
    cover: body.cover || null,
    revision: 0,
    pages: [{ id: 'page_1', name: '第 1 页', images: [], annotations: [] }],
    history: [],
  };
  getIndex().rooms[id] = {
    id,
    name,
    password: room.password,
    editPermission: room.editPermission,
    createdBy: room.createdBy,
    createdAt: now,
    lastModified: now,
    cover: room.cover || null,
  };
  persistIndex();
  saveRoom(id, room);
  res.status(201).json({ id, name: room.name });
});

// 修改房间设置（仅创建者 / 管理员）
app.patch('/api/rooms/:id', (req, res) => {
  const index = getIndex();
  const meta = index.rooms[req.params.id];
  if (!meta) return res.status(404).json({ error: '房间不存在' });
  const body = req.body || {};
  if (body.userId && meta.createdBy && body.userId !== meta.createdBy) {
    return res.status(403).json({ error: '只有创建者可以修改房间设置' });
  }
  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return res.status(400).json({ error: '名称不能为空' });
    meta.name = name;
  }
  if (body.editPermission === 'readonly' || body.editPermission === 'editable') {
    meta.editPermission = body.editPermission;
  }
  if (typeof body.password === 'string') {
    meta.password = body.password ? hashPassword(body.password, meta.id) : '';
  }
  if (typeof body.cover === 'string') meta.cover = body.cover || null;
  meta.lastModified = new Date().toISOString();
  persistIndex();

  // 通知房间内成员刷新权限与设置
  io.to(meta.id).emit('room-settings', {
    name: meta.name,
    editPermission: meta.editPermission,
    hasPassword: !!meta.password,
  });
  res.json({ ok: true, name: meta.name, editPermission: meta.editPermission });
});

// 删除房间（仅创建者 / 管理员）
app.delete('/api/rooms/:id', (req, res) => {
  const index = getIndex();
  const meta = index.rooms[req.params.id];
  if (!meta) return res.status(404).json({ error: '房间不存在' });
  const body = req.body || {};
  if (meta.createdBy && body.userId && body.userId !== meta.createdBy) {
    return res.status(403).json({ error: '只有创建者可以删除手账本' });
  }
  delete index.rooms[meta.id];
  persistIndex();
  deleteRoomFile(meta.id);
  io.to(meta.id).emit('room-deleted', { id: meta.id });
  res.json({ ok: true });
});

// 首次加载：拉取房间全量数据
app.get('/api/rooms/:id/data', (req, res) => {
  const index = getIndex();
  const meta = index.rooms[req.params.id];
  const room = getRoom(req.params.id);
  if (!meta || !room) return res.status(404).json({ error: '房间不存在' });
  room.name = meta.name;
  room.editPermission = meta.editPermission;
  room.createdBy = meta.createdBy;
  room.createdAt = meta.createdAt;
  room.password = meta.password;
  res.json(sanitizeRoom(room, roomLocks.get(req.params.id)));
});

// 按需加载单个页面的完整内容（图片 + 标注），避免一次性推流全部页面
app.get('/api/rooms/:id/page/:pageId', (req, res) => {
  const index = getIndex();
  const meta = index.rooms[req.params.id];
  const room = getRoom(req.params.id);
  if (!meta || !room) return res.status(404).json({ error: '房间不存在' });
  const page = (room.pages || []).find((p) => p.id === req.params.pageId);
  if (!page) return res.status(404).json({ error: '页面不存在' });
  res.json({
    id: page.id,
    name: page.name,
    images: page.images || [],
    annotations: page.annotations || [],
  });
});

/* ---------------------------------------------------------------------------
 * Socket.io 实时协同
 * ------------------------------------------------------------------------- */
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: MAX_BODY, // 允许较大的图片 Base64 消息
});

// roomId -> Map<socketId, member>
const roomMembers = new Map();
// roomId::elementId -> { userId, userName, color, ts }
const roomLocks = new Map();

function memberList(roomId) {
  const map = roomMembers.get(roomId);
  if (!map) return [];
  return Array.from(map.values()).map((m) => ({
    socketId: m.socketId,
    userId: m.userId,
    name: m.name,
    color: m.color,
    joinedAt: m.joinedAt,
    cursor: m.cursor || null,
  }));
}

function broadcastMembers(roomId) {
  io.to(roomId).emit('members', memberList(roomId));
}

function releaseUserLocks(roomId, userId) {
  let changed = false;
  for (const [key, lock] of roomLocks) {
    if (key.startsWith(roomId + '::') && lock.userId === userId) {
      roomLocks.delete(key);
      changed = true;
      io.to(roomId).emit('element-unlocked', { elementId: lock.elementId });
    }
  }
  return changed;
}

function canEdit(room, user) {
  if (room.editPermission === 'editable') return true;
  return room.createdBy === user.id; // 只读房间：仅创建者可编辑
}

/** 颜色 -> 中文名，用于操作历史描述 */
const COLOR_NAMES = {
  '#000000': '黑色', '#333333': '深灰', '#888888': '灰色', '#ffffff': '白色',
  '#ff0000': '红色', '#ff4d4f': '红色', '#ff5722': '橙色', '#ff9800': '橙色',
  '#ffc107': '琥珀色', '#ffff00': '黄色', '#ffeb3b': '黄色', '#8bc34a': '浅绿',
  '#4caf50': '绿色', '#008000': '绿色', '#00bcd4': '青色', '#2196f3': '蓝色',
  '#0000ff': '蓝色', '#3f51b5': '靛蓝', '#673ab7': '紫色', '#9c27b0': '紫色',
  '#e91e63': '粉色', '#f06292': '粉色', '#795548': '棕色',
  '#e34f4f': '红色', '#f08a24': '橙色', '#e0a800': '黄色', '#58a63f': '绿色',
  '#2f9e9e': '青色', '#3a7bd5': '蓝色', '#7a5cd6': '紫色', '#d6548f': '粉色',
  '#37352f': '深灰',
};

function colorName(hex) {
  const key = String(hex || '').toLowerCase();
  return COLOR_NAMES[key] || key || '默认色';
}

/** 由操作类型生成历史记录文本 */
function describeOp(op, user, pageName) {
  const who = user.name || '匿名用户';
  const loc = pageName ? '在' + pageName + ' ' : '';
  switch (op.type) {
    case 'add-image':
      return `${who} ${loc}上传了图片`;
    case 'add-annotation': {
      const el = op.element || {};
      const c = colorName(el.color);
      if (el.kind === 'pen') return `${who} ${loc}绘制了${c}笔迹`;
      if (el.kind === 'line') return `${who} ${loc}(${Math.round(el.x1)}, ${Math.round(el.y1)}) 绘制了${c}直线`;
      if (el.kind === 'arrow') return `${who} ${loc}(${Math.round(el.x1)}, ${Math.round(el.y1)}) 绘制了${c}箭头线段`;
      if (el.kind === 'rect') return `${who} ${loc}(${Math.round(el.x1)}, ${Math.round(el.y1)}) 绘制了${c}矩形`;
      if (el.kind === 'circle') return `${who} ${loc}(${Math.round(el.cx)}, ${Math.round(el.cy)}) 绘制了${c}圆形`;
      if (el.kind === 'text') return `${who} ${loc}添加了文字“${String(el.text || '').slice(0, 20)}”`;
      return `${who} ${loc}添加了标注`;
    }
    case 'transform-image':
      return `${who} ${loc}移动/旋转了图片`;
    case 'update-annotation':
      return `${who} ${loc}移动了标注`;
    case 'erase': {
      const n = (op.deletedIds || []).length + (op.modifiedStrokes || []).length;
      return `${who} ${loc}使用橡皮擦修改了 ${n} 个元素`;
    }
    case 'delete-elements':
      return `${who} ${loc}删除了 ${(op.ids || []).length} 个元素`;
    case 'duplicate':
      return `${who} ${loc}复制了 ${(op.elements || []).length} 个元素`;
    case 'reorder':
      return `${who} ${loc}调整了元素层级`;
    case 'clear-annotations':
      return `${who} ${loc}清空了标注层`;
    case 'add-page':
      return `${who} 新增了页面「${op.page ? op.page.name : ''}」`;
    case 'rename-page':
      return `${who} 将页面重命名为「${op.name || ''}」`;
    case 'delete-page':
      return `${who} 删除了页面「${op.name || ''}」`;
    default:
      return `${who} 执行了操作`;
  }
}

const ELEMENT_OPS = new Set([
  'add-image', 'add-annotation', 'update-annotation', 'transform-image',
  'erase', 'delete-elements', 'duplicate', 'reorder', 'clear-annotations',
]);

/** 元素创建信息由服务端盖章，保证创建人与创建时间可信 */
function stampElement(el, user) {
  if (!el || !user) return el;
  if (!el.createdBy) el.createdBy = { id: user.id, name: user.name };
  if (el.createdAt == null) el.createdAt = Date.now();
  return el;
}

/** 定位操作目标页面：op.pageId 优先，缺省回退到第一页 */
function pageOf(room, op) {
  if (!Array.isArray(room.pages) || !room.pages.length) return null;
  if (op.pageId) {
    const p = room.pages.find((x) => x.id === op.pageId);
    if (p) return p;
  }
  return room.pages[0];
}

/** 元素层级值：新元素无 z 时，图片默认在 0..n，标注默认在 100000..（保持原“图片在下”语义） */
function elementZ(el, images, annotations) {
  if (typeof el.z === 'number') return el.z;
  if (el.layer === 'image') return images.indexOf(el);
  return 100000 + annotations.indexOf(el);
}

function pushHistory(room, op, user) {
  let pageName = '';
  if (ELEMENT_OPS.has(op.type)) {
    const page = pageOf(room, op);
    if (page) pageName = page.name;
  }
  const entry = {
    ts: Date.now(),
    time: new Date().toTimeString().slice(0, 8),
    userId: user.id,
    userName: user.name,
    text: describeOp(op, user, pageName),
  };
  room.history.push(entry);
  if (room.history.length > MAX_HISTORY) room.history.splice(0, room.history.length - MAX_HISTORY);
  return entry;
}

/** 把持久化操作应用到房间状态；返回错误信息或 null */
function applyOp(room, op, user) {
  if (!op || typeof op.type !== 'string') return '非法操作';
  if (op.type === 'add-page') {
    if (!op.page || !op.page.id) return '缺少页面数据';
    if (room.pages.some((p) => p.id === op.page.id)) return null; // 幂等
    room.pages.push({
      id: op.page.id,
      name: op.page.name || ('第 ' + (room.pages.length + 1) + ' 页'),
      images: [],
      annotations: [],
    });
    return null;
  }
  if (op.type === 'rename-page') {
    const p = room.pages.find((x) => x.id === op.pageId);
    if (!p) return null;
    const name = String(op.name || '').trim();
    if (name) p.name = name;
    return null;
  }
  if (op.type === 'delete-page') {
    if (room.pages.length <= 1) return '至少需要保留一个页面';
    const idx = room.pages.findIndex((x) => x.id === op.pageId);
    if (idx < 0) return null;
    room.pages.splice(idx, 1);
    return null;
  }
  const page = pageOf(room, op);
  if (!page) return '页面不存在';
  const images = page.images;
  const annotations = page.annotations;
  switch (op.type) {
    case 'add-image': {
      if (!op.element || !op.element.id) return '缺少图片数据';
      if (images.some((e) => e.id === op.element.id)) return null; // 幂等
      images.push(stampElement(op.element, user));
      return null;
    }
    case 'add-annotation': {
      if (!op.element || !op.element.id) return '缺少标注数据';
      stampElement(op.element, user);
      const i = annotations.findIndex((e) => e.id === op.element.id);
      if (i >= 0) annotations[i] = op.element;
      else annotations.push(op.element);
      return null;
    }
    case 'update-annotation': {
      if (!op.element || !op.element.id) return '缺少标注数据';
      const i = annotations.findIndex((e) => e.id === op.element.id);
      if (i >= 0) annotations[i] = op.element;
      else annotations.push(op.element);
      return null;
    }
    case 'transform-image': {
      const img = images.find((e) => e.id === op.id);
      if (!img) return null;
      if (typeof op.x === 'number') img.x = op.x;
      if (typeof op.y === 'number') img.y = op.y;
      if (typeof op.rotation === 'number') img.rotation = op.rotation;
      if (typeof op.width === 'number') img.width = op.width;
      if (typeof op.height === 'number') img.height = op.height;
      return null;
    }
    case 'erase': {
      const deleted = new Set(op.deletedIds || []);
      page.annotations = annotations.filter((e) => !deleted.has(e.id));
      const mods = op.modifiedStrokes || [];
      for (const stroke of mods) {
        const i = page.annotations.findIndex((e) => e.id === stroke.id);
        if (i >= 0) page.annotations[i] = stroke;
      }
      return null;
    }
    case 'delete-elements': {
      const ids = new Set(op.ids || []);
      page.images = images.filter((e) => !ids.has(e.id));
      page.annotations = annotations.filter((e) => !ids.has(e.id));
      for (const id of ids) roomLocks.delete(room.id + '::' + id);
      return null;
    }
    case 'duplicate': {
      for (const el of op.elements || []) {
        stampElement(el, user);
        if (el.layer === 'image') images.push(el);
        else annotations.push(el);
      }
      return null;
    }
    case 'reorder': {
      const ids = new Set(op.ids || []);
      if (!ids.size) return null;
      const all = images.concat(annotations);
      const targets = all.filter((e) => ids.has(e.id));
      if (!targets.length) return null;
      let min = Infinity, max = -Infinity;
      for (const e of all) {
        const z = elementZ(e, images, annotations);
        min = Math.min(min, z);
        max = Math.max(max, z);
      }
      const z = op.mode === 'back' ? min - 1 : max + 1;
      for (const e of targets) e.z = z;
      return null;
    }
    case 'clear-annotations': {
      page.annotations = [];
      return null;
    }
    default:
      return '未知操作类型';
  }
}

io.on('connection', (socket) => {
  // 加入房间（校验密码）
  socket.on('join-room', (payload, ack) => {
    const doAck = typeof ack === 'function' ? ack : () => {};
    const roomId = String((payload && payload.roomId) || '');
    const room = getRoom(roomId);
    const meta = getIndex().rooms[roomId];
    if (!room || !meta) return doAck({ ok: false, reason: '房间不存在或已被删除' });
    const user = (payload && payload.user && payload.user.id) ? payload.user : null;
    if (!user) return doAck({ ok: false, reason: '缺少用户信息，请刷新页面重试' });
    if (meta.password && hashPassword(String(payload.password || ''), roomId) !== meta.password) {
      return doAck({ ok: false, reason: '访问密码错误' });
    }

    if (socket.data.roomId) socket.leave(socket.data.roomId);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.user = {
      id: String(user.id),
      name: String(user.name || '匿名用户').slice(0, 24),
      color: String(user.color || '#888888'),
    };
    if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Map());
    roomMembers.get(roomId).set(socket.id, {
      socketId: socket.id,
      userId: socket.data.user.id,
      name: socket.data.user.name,
      color: socket.data.user.color,
      joinedAt: Date.now(),
      cursor: null,
    });

    room.name = meta.name;
    room.editPermission = meta.editPermission;
    room.createdBy = meta.createdBy;
    room.createdAt = meta.createdAt;
    room.password = meta.password;
    doAck({ ok: true, data: sanitizeRoom(room, roomLocks.get(roomId)) });
    broadcastMembers(roomId);
  });

  socket.on('leave-room', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.leave(roomId);
    if (socket.data.user) releaseUserLocks(roomId, socket.data.user.id);
    const map = roomMembers.get(roomId);
    if (map) {
      map.delete(socket.id);
      if (!map.size) roomMembers.delete(roomId);
      broadcastMembers(roomId);
    }
    delete socket.data.roomId;
  });

  // 画布操作：持久化操作写盘并广播；瞬态操作（拖拽/绘制过程）只转发
  socket.on('op', (payload, ack) => {
    const doAck = typeof ack === 'function' ? ack : () => {};
    const roomId = socket.data.roomId;
    const user = socket.data.user;
    if (!roomId || !user) return doAck({ ok: false, reason: '尚未加入房间' });
    const op = (payload && payload.op) || {};
    if (payload && payload.roomId && payload.roomId !== roomId) {
      return doAck({ ok: false, reason: '房间不匹配' });
    }
    const transient = op.transient === true;
    const room = getRoom(roomId);
    if (!room) return doAck({ ok: false, reason: '房间不存在' });

    if (transient) {
      socket.to(roomId).emit('op', { op, transient: true, by: user });
      return doAck({ ok: true, transient: true });
    }
    if (!canEdit(room, user)) {
      return doAck({ ok: false, reason: '该房间为只读，您没有编辑权限' });
    }
    const err = applyOp(room, op, user);
    if (err) return doAck({ ok: false, reason: err });

    const historyEntry = pushHistory(room, op, user);
    room.lastModified = new Date().toISOString();
    room.revision = (room.revision || 0) + 1;
    saveRoom(roomId, room);
    touchRoomMeta(roomId, {});

    socket.to(roomId).emit('op', {
      op,
      historyEntry,
      revision: room.revision,
      lastModified: room.lastModified,
      by: user,
    });
    doAck({ ok: true, historyEntry, revision: room.revision, lastModified: room.lastModified });
  });

  // 光标位置（节流在客户端做）
  socket.on('cursor', (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const map = roomMembers.get(roomId);
    const member = map && map.get(socket.id);
    if (!member) return;
    member.cursor = { x: payload.x, y: payload.y };
    socket.to(roomId).emit('cursor', {
      userId: member.userId,
      x: payload.x,
      y: payload.y,
      name: member.name,
      color: member.color,
    });
  });

  // 修改用户显示名称（同步给房间内所有成员）
  socket.on('update-user', (payload) => {
    const roomId = socket.data.roomId;
    const user = socket.data.user;
    if (!roomId || !user || !payload) return;
    if (typeof payload.name === 'string' && payload.name.trim()) {
      user.name = payload.name.trim().slice(0, 24);
      const map = roomMembers.get(roomId);
      const member = map && map.get(socket.id);
      if (member) member.name = user.name;
      broadcastMembers(roomId);
    }
  });

  // 乐观锁：锁定元素
  socket.on('lock-element', (payload, ack) => {
    const doAck = typeof ack === 'function' ? ack : () => {};
    const roomId = socket.data.roomId;
    const user = socket.data.user;
    const elementId = payload && payload.elementId;
    if (!roomId || !user || !elementId) return doAck({ ok: false, reason: '参数不完整' });
    const key = roomId + '::' + elementId;
    const existing = roomLocks.get(key);
    if (existing && existing.userId !== user.id) {
      return doAck({ ok: false, reason: '该元素正被 ' + existing.userName + ' 编辑', lock: existing });
    }
    const lock = { userId: user.id, userName: user.name, color: user.color, elementId, ts: Date.now() };
    roomLocks.set(key, lock);
    socket.to(roomId).emit('element-locked', { elementId, lock });
    doAck({ ok: true, lock });
  });

  // 乐观锁：释放元素
  socket.on('unlock-element', (payload, ack) => {
    const doAck = typeof ack === 'function' ? ack : () => {};
    const roomId = socket.data.roomId;
    const user = socket.data.user;
    const elementId = payload && payload.elementId;
    const key = roomId + '::' + elementId;
    const lock = roomLocks.get(key);
    if (lock && (!user || lock.userId === user.id)) {
      roomLocks.delete(key);
      socket.to(roomId).emit('element-unlocked', { elementId });
    }
    doAck({ ok: true });
  });

  // 断线清理：成员下线 + 释放其持有的锁
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    if (socket.data.user) releaseUserLocks(roomId, socket.data.user.id);
    const map = roomMembers.get(roomId);
    if (map) {
      map.delete(socket.id);
      if (!map.size) roomMembers.delete(roomId);
      broadcastMembers(roomId);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 启动
 * ------------------------------------------------------------------------- */
getIndex(); // 启动时确保索引就绪
server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log('  Digital Journal server started');
  console.log('  Local:      http://localhost:' + PORT);
  console.log('  LAN:        http://<your-ip>:' + PORT);
  console.log('  Tunnel:     ngrok http ' + PORT + '  (or frp forward this port)');
  console.log('  Data dir:   ' + DATA_DIR);
  console.log('==============================================');
});
