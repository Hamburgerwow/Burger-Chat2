'use strict';
/* Burger Chat 发布端：给客户端提供「最新版本 + 公告」，页面上传 APK / exe 并发布。
   纯 Node 内置模块，零依赖；数据落在 exe 同目录 data/ 下。 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const ARGS = process.argv.slice(2);
const PORT_ARG = ARGS.find(a => /^\d{2,5}$/.test(a));
const HERE = process.env.PUB_DIR || (global.__PUB_HTML__ ? path.dirname(process.execPath) : __dirname);
const DATA = path.join(HERE, 'data');
const FILES = path.join(DATA, 'files');
fs.mkdirSync(FILES, { recursive: true });

const CFG_PATH = path.join(DATA, 'config.json');
const VER_PATH = path.join(DATA, 'versions.json');
const ANN_PATH = path.join(DATA, 'anns.json');

function loadJson(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; }
}
function saveJson(p, o) {
  fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8');
}
function newId() { return 'p' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }

let CFG = loadJson(CFG_PATH, null);
if (!CFG) {
  CFG = { port: Number(PORT_ARG || 54970), pin: String(Math.floor(100000 + Math.random() * 900000)), token: crypto.randomBytes(16).toString('hex') };
  saveJson(CFG_PATH, CFG);
  try {
    fs.writeFileSync(path.join(HERE, '发布端口令.txt'),
      'Burger Chat 发布端\r\n\r\n后台地址： http://127.0.0.1:' + CFG.port + '/\r\n发布口令： ' + CFG.pin + '\r\n\r\n（这个文件别删，口令也写在 data\\config.json 里）\r\n',
      'utf8');
  } catch (e) {}
}
if (PORT_ARG) CFG.port = Number(PORT_ARG);
if (!CFG.token) { CFG.token = crypto.randomBytes(16).toString('hex'); saveJson(CFG_PATH, CFG); }

let VERS = loadJson(VER_PATH, []);
let ANNS = loadJson(ANN_PATH, []);
if (!Array.isArray(VERS)) VERS = [];
if (!Array.isArray(ANNS)) ANNS = [];

let _html = global.__PUB_HTML__ || '';
const HTML = () => {
  if (!_html) {
    try { _html = fs.readFileSync(path.join(path.dirname(__filename), 'pub.html'), 'utf8'); } catch (e) { _html = ''; }
  }
  return _html;
};

function json(res, o, code) {
  const b = JSON.stringify(o);
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(b);
}
function readJson(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function auth(req) {
  const h = req.headers['authorization'] || '';
  const t = h.replace(/^Bearer\s+/i, '').trim();
  return !!t && t === CFG.token;
}
function safeName(n) {
  return String(n || 'file').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120) || 'file';
}
function sizeText(n) {
  n = Number(n || 0);
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function publicVersion(v, canDownload) {
  const dl = canDownload !== false;
  return {
    id: v.id, ver: v.ver, notes: v.notes || '', ts: v.ts, force: !!v.force, dl: dl,
    apk: v.apk ? { url: '/f/' + v.apk.id, name: v.apk.name, size: v.apk.size } : null,
    exe: v.exe ? { url: '/f/' + v.exe.id, name: v.exe.name, size: v.exe.size } : null
  };
}

function latestPayload() {
  return {
    ok: true, app: 'burger-pub', ver: CFG.ver || '1.0',
    proto: 'http+tcp', port: CFG.port,
    latest: VERS.length ? publicVersion(VERS[0], true) : null,
    versions: VERS.slice(0, 6).map((v, i) => publicVersion(v, i === 0)),
    anns: ANNS.slice(0, 12).map(a => ({ id: a.id, title: a.title, body: a.body, ts: a.ts, pinned: !!a.pinned })),
    count: { versions: VERS.length, anns: ANNS.length },
    updated: Date.now()
  };
}
function findFile(id) {
  /* 只开放当前最新版本的安装包；旧版本只保留版本记录，下载通道关闭。 */
  const v = VERS[0];
  const all = v ? [v.apk, v.exe].filter(Boolean) : [];
  const f = all.find(x => x.id === id);
  if (!f) return null;
  let cand = null;
  try { cand = fs.readdirSync(FILES).find(n => n.startsWith(id + '_')); } catch (e) {}
  if (!cand) return null;
  const file = path.join(FILES, cand);
  const stat = fs.statSync(file);
  return { id, name: f.name, file, stat };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,DELETE' });
      return res.end();
    }

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(HTML());
    }


    /* 客户端拉取：免鉴权，节点只需要知道地址 */
    if (p === '/api/latest' || p === '/api/pub/hello') {
      return json(res, latestPayload());
    }

    if (p === '/api/auth' && req.method === 'POST') {
      const b = await readJson(req);
      if (String(b.pin || '').trim() === String(CFG.pin)) return json(res, { ok: true, token: CFG.token, port: CFG.port });
      return json(res, { ok: false, error: '口令不对' }, 401);
    }

    if (p === '/api/state') {
      if (!auth(req)) return json(res, { ok: false, error: '没登录' }, 401);
      return json(res, {
        ok: true, port: CFG.port, pin: CFG.pin,
        versions: VERS.map((v, i) => publicVersion(v, i === 0)), anns: ANNS
      });
    }

    /* 传安装包：原始流，?kind=apk|exe&name= */
    if (p === '/api/upload' && req.method === 'POST') {
      if (!auth(req)) return json(res, { ok: false, error: '没登录' }, 401);
      const kind = u.searchParams.get('kind') || 'file';
      let name = u.searchParams.get('name') || 'file';
      try { name = decodeURIComponent(name); } catch (e) {}
      name = safeName(name);
      const id = newId();
      const dest = path.join(FILES, id + '_' + name);
      const ws = fs.createWriteStream(dest);
      let size = 0;
      req.on('data', d => { size += d.length; });
      req.pipe(ws);
      ws.on('finish', () => json(res, { ok: true, file: { id, kind, name, size, sizeText: sizeText(size) } }));
      ws.on('error', e => json(res, { ok: false, error: '写入失败：' + e.message }, 500));
      return;
    }

    if (p === '/api/version' && req.method === 'POST') {
      if (!auth(req)) return json(res, { ok: false, error: '没登录' }, 401);
      const b = await readJson(req);
      const ver = String(b.ver || '').trim();
      if (!ver) return json(res, { ok: false, error: '版本号不能空' }, 400);
      const v = {
        id: newId(), ver: ver.slice(0, 30), notes: String(b.notes || '').slice(0, 4000),
        ts: Date.now(), force: !!b.force,
        apk: b.apk ? { id: b.apk.id, name: b.apk.name, size: b.apk.size } : null,
        exe: b.exe ? { id: b.exe.id, name: b.exe.name, size: b.exe.size } : null
      };
      VERS.unshift(v);
      saveJson(VER_PATH, VERS);
      return json(res, { ok: true, version: publicVersion(v) });
    }

    if (p === '/api/ann' && req.method === 'POST') {
      if (!auth(req)) return json(res, { ok: false, error: '没登录' }, 401);
      const b = await readJson(req);
      const title = String(b.title || '').trim();
      if (!title) return json(res, { ok: false, error: '公告标题不能空' }, 400);
      const a = { id: newId(), title: title.slice(0, 80), body: String(b.body || '').slice(0, 3000), ts: Date.now(), pinned: !!b.pinned };
      ANNS.unshift(a);
      saveJson(ANN_PATH, ANNS);
      return json(res, { ok: true, ann: a });
    }

    if (p === '/api/del' && req.method === 'POST') {
      if (!auth(req)) return json(res, { ok: false, error: '没登录' }, 401);
      const b = await readJson(req);
      if (b.type === 'ver') {
        const i = VERS.findIndex(x => x.id === b.id);
        if (i >= 0) { VERS.splice(i, 1); saveJson(VER_PATH, VERS); }
        return json(res, { ok: true });
      }
      if (b.type === 'ann') {
        const i = ANNS.findIndex(x => x.id === b.id);
        if (i >= 0) { ANNS.splice(i, 1); saveJson(ANN_PATH, ANNS); }
        return json(res, { ok: true });
      }
      return json(res, { ok: false, error: '类型不对' }, 400);
    }

    /* 下载安装包（免鉴权，方便手机直接拉）；只允许最新版本的 APK / exe */
    if (p.startsWith('/f/')) {
      const id = p.slice(3);
      const latest = VERS[0];
      const all = latest ? [latest.apk, latest.exe].filter(Boolean) : [];
      const f = all.find(x => x.id === id);
      if (!f) return json(res, { ok: false, error: '旧版本下载通道已关闭，请下载最新版' }, 404);
      const cand = fs.readdirSync(FILES).find(n => n.startsWith(id + '_'));
      if (!cand) return json(res, { ok: false, error: '文件不在了' }, 404);
      const fname = path.join(FILES, cand);
      const stat = fs.statSync(fname);
      const name = f.name;
      const mime = /\.apk$/i.test(name) ? 'application/vnd.android.package-archive'
        : /\.exe$/i.test(name) ? 'application/octet-stream' : 'application/octet-stream';
      const range = req.headers['range'];
      const disp = "attachment; filename*=UTF-8''" + encodeURIComponent(name);
      if (range) {
        const mm = /^bytes=(\d*)-(\d*)$/.exec(String(range));
        if (mm) {
          let s = mm[1] === '' ? null : parseInt(mm[1], 10);
          let e = mm[2] === '' ? null : parseInt(mm[2], 10);
          if (s === null) { s = Math.max(0, stat.size - (e || 0)); e = stat.size - 1; }
          if (e === null || e >= stat.size) e = stat.size - 1;
          if (s >= 0 && s < stat.size && e >= s) {
            res.writeHead(206, { 'Content-Type': mime, 'Content-Length': e - s + 1, 'Content-Range': 'bytes ' + s + '-' + e + '/' + stat.size, 'Accept-Ranges': 'bytes', 'Content-Disposition': disp, 'Access-Control-Allow-Origin': '*' });
            return fs.createReadStream(fname, { start: s, end: e }).pipe(res);
          }
          res.writeHead(416); return res.end();
        }
      }
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Content-Disposition': disp, 'Access-Control-Allow-Origin': '*' });
      return fs.createReadStream(fname).pipe(res);
    }

    json(res, { ok: false, error: '没有这个接口' }, 404);
  } catch (e) {
    try { json(res, { ok: false, error: String(e && e.message || e) }, 500); } catch (e2) {}
  }
});

/* ========== 纯 TCP 协议（和 HTTP 共用同一个端口，按首包分流） ==========
   客户端发一行命令、服务端回一行 JSON：
     HELLO                  → 握手信息
     LATEST                 → 最新版本 + 公告（等同 /api/latest）
     FILE <文件id>          → 先回一行 {"ok":true,"file":{...}}，紧接着裸字节流，传完断开
   不是以 HTTP 动词开头的连接都走这里，HTTP 连接原样交给 http 服务。 */
function tcpLine(obj) { return JSON.stringify(obj) + '\n'; }

function handleTcp(sock, firstChunk) {
  let buf = firstChunk.toString('utf8');
  let replied = false;
  const run = () => {
    if (replied) return;
    const nl = buf.indexOf('\n');
    if (nl < 0) { if (buf.length > 512) { replied = true; sock.end(tcpLine({ ok: false, error: '命令太长' })); } return; }
    replied = true;
    const line = buf.slice(0, nl).trim();
    const parts = line.split(/\s+/);
    const cmd = (parts[0] || '').toUpperCase();
    if (cmd === 'HELLO') return sock.end(tcpLine({ ok: true, app: 'burger-pub', proto: 'tcp', ver: CFG.ver || '1.0', port: CFG.port }));
    if (cmd === 'LATEST') return sock.end(tcpLine(latestPayload()));
    if (cmd === 'VERSION' || cmd === 'PING') return sock.end(tcpLine({ ok: true, ver: CFG.ver || '1.0', tcp: true }));
    if (cmd === 'FILE') {
      const f = findFile(parts[1] || '');
      if (!f) return sock.end(tcpLine({ ok: false, error: '文件不在了' }));
      sock.write(tcpLine({ ok: true, file: { id: f.id, name: f.name, size: f.stat.size } }));
      const rs = fs.createReadStream(f.file);
      rs.on('error', () => { try { sock.destroy(); } catch (e) {} });
      rs.pipe(sock);
      return;
    }
    return sock.end(tcpLine({ ok: false, error: '未知命令', cmd: cmd }));
  };
  sock.on('data', d => { buf += d.toString('utf8'); run(); });
  run();
}

const front = net.createServer(sock => {
  sock.on('error', () => {});
  sock.setTimeout(20000, () => { try { sock.destroy(); } catch (e) {} });
  sock.once('data', chunk => {
    const head = chunk.toString('utf8', 0, Math.min(chunk.length, 10)).toUpperCase();
    if (/^(GET |POST |HEAD |PUT |OPTIONS |DELETE |PATCH )/.test(head)) {
      sock.unshift(chunk);
      sock.setTimeout(0);
      server.emit('connection', sock);
    } else {
      handleTcp(sock, chunk);
    }
  });
});

server.on('error', e => {
  console.error('发布端启动失败：' + (e && e.message));
});
front.on('error', e => {
  console.error('发布端端口占用：' + (e && e.message));
});
front.listen(CFG.port, '0.0.0.0', () => {
  console.log('Burger Chat 发布端已启动');
  console.log('  本机地址： http://127.0.0.1:' + CFG.port + '/');
  console.log('  纯 TCP：  ' + CFG.port + ' 端口，发一行 LATEST 即回 JSON');
  console.log('  发布口令： ' + CFG.pin);
  console.log('  数据目录： ' + DATA);
});
