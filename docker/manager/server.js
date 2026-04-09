import http from "node:http";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import fssync from "node:fs";
import { spawn } from "node:child_process";

import express from "express";
import multer from "multer";
import httpProxy from "http-proxy";

const app = express();
const server = http.createServer(app);
const upload = multer({ storage: multer.memoryStorage() });

app.set("trust proxy", true);

const ROOT = path.resolve(process.env.APP_ROOT || "/app");
const PORT = Number(process.env.PORT || 7860);
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 3003);
const API_PORT = Number(process.env.API_SERVER_PORT || 3004);
const ADMIN_BASE = normalizeBase(process.env.ADMIN_BASE_PATH || "/admin");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const AUTO_START = process.env.AUTO_START !== "0";
const START_CMD = process.env.APP_START_CMD || "pnpm start:direct";
const ADMIN_ENABLE_SHELL = process.env.ADMIN_ENABLE_SHELL === "1";
const MAX_LOG_LINES = Number(process.env.MAX_LOG_LINES || 5000);

let mainProc = null;
const logBuffer = [];
const logClients = new Set();

const probeState = {
  lastRunAt: null,
  frontendTcp: null,
  apiTcp: null,
  frontendHttp: null,
  apiHttp: null
};

const PRESET_COMMANDS = {
  build: "pnpm build",
  test: "pnpm test",
  status: "pnpm start:status || true",
  stopDaemon: "pnpm stop || true",
  runtimeStatus: "pnpm runtime:status || true",
  redisStatus: "pnpm redis:user:status || true"
};

const apiProxy = httpProxy.createProxyServer({
  target: `http://0.0.0.0:${API_PORT}`,
  changeOrigin: true,
  ws: true,
  xfwd: true,
  prependPath: false,
  ignorePath: true
});

const webProxy = httpProxy.createProxyServer({
  target: `http://0.0.0.0:${FRONTEND_PORT}`,
  changeOrigin: true,
  ws: true,
  xfwd: true,
  prependPath: false,
  ignorePath: true
});

function normalizeBase(base) {
  if (!base.startsWith("/")) base = `/${base}`;
  return base.replace(/\/+$/, "");
}

function addLog(line) {
  const item = {
    ts: new Date().toISOString(),
    line: String(line).replace(/\r/g, "")
  };

  logBuffer.push(item);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();

  const payload = `data: ${JSON.stringify(item)}\n\n`;
  for (const res of logClients) {
    try {
      res.write(payload);
    } catch {}
  }

  console.log(item.line);
}

function isInsideRoot(target) {
  return target === ROOT || target.startsWith(ROOT + path.sep);
}

function safeResolve(rel = "") {
  const target = path.resolve(ROOT, rel || ".");
  if (!isInsideRoot(target)) {
    throw new Error(`Path out of root: ${rel}`);
  }
  return target;
}

function safeJoin(relDir = "", name = "") {
  const cleanName = path.basename(String(name || "").trim());
  if (!cleanName) throw new Error("Invalid name");
  return safeResolve(path.join(relDir || "", cleanName));
}

function requireAuth(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const token = req.headers["x-admin-token"] || req.query.token || "";
  if (token === ADMIN_TOKEN) return next();
  addLog(`[auth] deny ${req.method} ${req.originalUrl}`);
  res.status(401).json({ ok: false, error: "Unauthorized" });
}

function formatSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function tcpProbe(port, tag) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host: "0.0.0.0", port });

    const done = (data) => {
      try { socket.destroy(); } catch {}
      addLog(`[probe:tcp] ${tag} ${JSON.stringify(data)}`);
      resolve(data);
    };

    socket.setTimeout(1500);

    socket.on("connect", () => {
      done({ ok: true, port, ms: Date.now() - started });
    });

    socket.on("timeout", () => {
      done({ ok: false, port, error: "timeout", ms: Date.now() - started });
    });

    socket.on("error", (e) => {
      done({ ok: false, port, error: e.message, ms: Date.now() - started });
    });
  });
}

async function httpProbe(tag, url, headers = {}) {
  try {
    addLog(`[probe:http] ${tag} -> ${url}`);
    const res = await fetch(url, { method: "GET", headers, redirect: "manual" });
    const text = await res.text().catch(() => "");
    const data = {
      ok: true,
      status: res.status,
      statusText: res.statusText,
      bodyPreview: text.slice(0, 160)
    };
    addLog(`[probe:http] ${tag} <- ${JSON.stringify(data)}`);
    return data;
  } catch (e) {
    const data = { ok: false, error: e.message };
    addLog(`[probe:http] ${tag} ERROR ${e.message}`);
    return data;
  }
}

async function runProbes() {
  probeState.lastRunAt = new Date().toISOString();
  probeState.frontendTcp = await tcpProbe(FRONTEND_PORT, "frontend");
  probeState.apiTcp = await tcpProbe(API_PORT, "api");
  probeState.frontendHttp = await httpProbe("frontend", `http://0.0.0.0:${FRONTEND_PORT}/`);
  probeState.apiHttp = await httpProbe(
    "api",
    `http://0.0.0.0:${API_PORT}/api/audit/thread/default?userId=default`,
    { "X-Cat-Cafe-User": "default" }
  );
}

function spawnCommand(cmd, tag = "task", onExit) {
  addLog(`[spawn] tag=${tag} cmd=${cmd}`);

  const child = spawn(
    "bash",
    ["-lc", `cd ${JSON.stringify(ROOT)} && ${cmd}`],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        FORCE_COLOR: "1"
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  addLog(`[spawn] tag=${tag} pid=${child.pid}`);

  child.stdout?.on("data", (d) => addLog(`[${tag}] ${d.toString()}`));
  child.stderr?.on("data", (d) => addLog(`[${tag}:err] ${d.toString()}`));
  child.on("exit", (code, signal) => {
    addLog(`[spawn] tag=${tag} exit code=${code} signal=${signal}`);
    if (onExit) onExit(code, signal);
  });

  return child;
}

function startMain() {
  if (mainProc) {
    addLog("[main] start skipped: already running");
    return false;
  }

  addLog(`[main] start command=${START_CMD}`);
  mainProc = spawnCommand(START_CMD, "main", async () => {
    addLog("[main] process ended");
    mainProc = null;
    await runProbes();
  });

  setTimeout(() => {
    runProbes().catch((e) => addLog(`[probe] startup error ${e.message}`));
  }, 6000);

  return true;
}

function stopMain() {
  if (!mainProc) {
    addLog("[main] stop skipped: no process");
    return false;
  }

  const pid = mainProc.pid;
  addLog(`[main] stopping process group pid=${pid}`);

  try {
    process.kill(-pid, "SIGTERM");
    addLog(`[main] SIGTERM sent pid=${pid}`);
  } catch (e) {
    addLog(`[main] SIGTERM failed pid=${pid} err=${e.message}`);
  }

  setTimeout(() => {
    if (!mainProc) return;
    try {
      process.kill(-pid, "SIGKILL");
      addLog(`[main] SIGKILL sent pid=${pid}`);
    } catch (e) {
      addLog(`[main] SIGKILL failed pid=${pid} err=${e.message}`);
    }
  }, 5000);

  mainProc = null;
  return true;
}

async function listDir(rel = "") {
  const target = safeResolve(rel);
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error("Not a directory");

  const dirents = await fs.readdir(target, { withFileTypes: true });
  const items = await Promise.all(
    dirents.map(async (d) => {
      const full = path.join(target, d.name);
      let st = null;
      try {
        st = await fs.stat(full);
      } catch {}

      return {
        name: d.name,
        path: path.relative(ROOT, full),
        type: d.isDirectory() ? "dir" : "file",
        size: st?.size || 0,
        sizeText: st ? formatSize(st.size || 0) : "",
        mtime: st?.mtime || null
      };
    })
  );

  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    ok: true,
    root: ROOT,
    cwd: path.relative(ROOT, target) || "",
    parent: target === ROOT ? null : path.relative(ROOT, path.dirname(target)),
    items
  };
}

function proxyHttp(proxy, req, res, name) {
  const originalUrl = req.originalUrl || req.url;
  addLog(`[proxy:${name}] HTTP ${req.method} originalUrl=${originalUrl} url(before)=${req.url}`);

  req.url = originalUrl;

  proxy.web(req, res, {}, (err) => {
    addLog(`[proxy:${name}] HTTP ERROR ${req.method} ${originalUrl} ${err.message}`);
    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({
        ok: false,
        error: `${name} proxy error`,
        detail: err.message,
        originalUrl
      }));
    }
  });
}

function proxyWs(proxy, req, socket, head, name) {
  const originalUrl = req.url;
  addLog(`[proxy:${name}] WS upgrade url=${originalUrl}`);

  proxy.ws(req, socket, head, {}, (err) => {
    addLog(`[proxy:${name}] WS ERROR ${originalUrl} ${err.message}`);
    try { socket.destroy(); } catch {}
  });
}

apiProxy.on("proxyReq", (proxyReq, req) => {
  addLog(`[proxy:api] -> ${req.method} ${req.url}`);
});

apiProxy.on("proxyRes", (proxyRes, req) => {
  addLog(`[proxy:api] <- ${req.method} ${req.url} status=${proxyRes.statusCode}`);
});

apiProxy.on("error", (err, req) => {
  addLog(`[proxy:api] event error req=${req?.url || ""} err=${err.message}`);
});

webProxy.on("proxyReq", (proxyReq, req) => {
  addLog(`[proxy:web] -> ${req.method} ${req.url}`);
});

webProxy.on("proxyRes", (proxyRes, req) => {
  addLog(`[proxy:web] <- ${req.method} ${req.url} status=${proxyRes.statusCode}`);
});

webProxy.on("error", (err, req) => {
  addLog(`[proxy:web] event error req=${req?.url || ""} err=${err.message}`);
});

/* ---------------- 先挂全局日志 ---------------- */

app.use((req, res, next) => {
  const start = Date.now();
  const skip = (req.originalUrl || "").includes(`${ADMIN_BASE}/api/logs`);
  if (!skip) {
    addLog(`[http] -> ${req.method} ${req.originalUrl} host=${req.headers.host} url=${req.url}`);
  }
  res.on("finish", () => {
    if (!skip) {
      addLog(`[http] <- ${req.method} ${req.originalUrl} status=${res.statusCode} dur=${Date.now() - start}ms`);
    }
  });
  next();
});

/* ---------------- admin html，不重定向 ---------------- */

const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Clowder Admin</title>
  <style>
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, sans-serif; background:#0b1020; color:#e5e7eb; }
    header { padding:16px 20px; background:#111827; border-bottom:1px solid #1f2937; }
    .wrap { padding:16px; }
    .card { background:#111827; border:1px solid #1f2937; border-radius:12px; padding:16px; margin-bottom:16px; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .toolbar { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; align-items:center; }
    button,.btn-label { background:#2563eb; color:#fff; border:0; padding:10px 14px; border-radius:8px; cursor:pointer; display:inline-block; }
    button.secondary,.btn-label.secondary { background:#374151; }
    button.danger { background:#dc2626; }
    button.success,.btn-label.success { background:#16a34a; }
    button.warn { background:#d97706; }
    input,textarea { width:100%; padding:10px; border-radius:8px; border:1px solid #374151; background:#0f172a; color:#fff; }
    textarea { min-height:260px; font-family:monospace; }
    pre { margin:0; background:#020617; color:#d1fae5; border-radius:8px; padding:12px; min-height:280px; max-height:600px; overflow:auto; white-space:pre-wrap; }
    ul { list-style:none; padding:0; margin:8px 0 0 0; }
    li { padding:10px; border-bottom:1px solid #1f2937; }
    li:hover { background:#0f172a; }
    .muted { color:#94a3b8; font-size:14px; }
    .row { display:flex; gap:12px; align-items:center; }
    .row > * { flex:1; }
    .status { margin-top:8px; color:#93c5fd; line-height:1.6; }
    .path { margin:8px 0 12px 0; word-break:break-all; }
    .files .name { font-weight:bold; cursor:pointer; }
    .files .meta { color:#94a3b8; font-size:12px; margin-top:4px; }
    .files .actions { margin-top:8px; display:flex; flex-wrap:wrap; gap:6px; }
    .badge { display:inline-block; padding:3px 8px; border-radius:999px; background:#1f2937; color:#cbd5e1; font-size:12px; }
    code { background:#0f172a; padding:2px 6px; border-radius:6px; }
    a { color:#60a5fa; }
    @media (max-width:960px){ .grid { grid-template-columns:1fr; } .row { flex-direction:column; align-items:stretch; } }
  </style>
</head>
<body>
  <header>
    <h2 style="margin:0">Clowder AI 管理面板</h2>
    <div class="muted" style="margin-top:8px">主应用：<a href="/" target="_blank">打开 /</a></div>
  </header>

  <div class="wrap">
    <div class="card">
      <div class="row">
        <div>
          <label class="muted">ADMIN_TOKEN（如果你设置了）</label>
          <input id="token" type="password" placeholder="没设置可留空" />
        </div>
        <div style="flex:0 0 160px; align-self:end">
          <button onclick="saveToken()">保存 Token</button>
        </div>
      </div>

      <div id="status" class="status">状态加载中...</div>

      <div class="toolbar">
        <button onclick="startApp()">启动应用</button>
        <button class="secondary" onclick="stopApp()">停止应用</button>
        <button onclick="runPreset('build')">pnpm build</button>
        <button onclick="runPreset('status')">pnpm start:status</button>
        <button onclick="runPreset('test')">pnpm test</button>
        <button onclick="runPreset('runtimeStatus')">pnpm runtime:status</button>
        <button onclick="runPreset('redisStatus')">pnpm redis:user:status</button>
        <button class="secondary" onclick="probeNow()">刷新探测</button>
      </div>

      <div style="margin-top:12px">
        <label class="muted">自定义命令（需 ADMIN_ENABLE_SHELL=1）</label>
        <div class="row">
          <input id="customCmd" placeholder="例如：pnpm check" />
          <div style="flex:0 0 180px">
            <button onclick="runCustom()">执行自定义命令</button>
          </div>
        </div>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h3 style="margin-top:0">实时日志</h3>
        <pre id="logs"></pre>
      </div>

      <div class="card">
        <h3 style="margin-top:0">文件管理器 <span class="badge">根目录 /app</span></h3>
        <div class="path" id="cwd">当前目录：/</div>

        <div class="toolbar">
          <button class="secondary" onclick="goParent()">上一级</button>
          <button onclick="mkdirNow()">新建文件夹</button>
          <button onclick="newFileNow()">新建文件</button>
          <label class="btn-label success">
            上传文件
            <input id="uploadInput" type="file" multiple style="display:none" onchange="uploadFiles(this.files)" />
          </label>
          <button class="secondary" onclick="refreshDir()">刷新</button>
        </div>

        <ul id="files" class="files"></ul>

        <div style="margin-top:16px">
          <h4>文件编辑器</h4>
          <div class="muted" id="editingPath">未打开文件</div>
          <textarea id="editor" placeholder="点击文件后在这里编辑"></textarea>
          <div class="toolbar">
            <button onclick="saveCurrentFile()">保存文件</button>
            <button class="secondary" onclick="clearEditor()">清空编辑器</button>
          </div>
        </div>
      </div>
    </div>
  </div>

<script>
(function () {
  var ADMIN_BASE = "${ADMIN_BASE}";
  var API_BASE = ADMIN_BASE + "/api";
  var currentPath = "";
  var currentFilePath = "";
  var eventSource = null;

  function getToken() {
    return localStorage.getItem("adminToken") || "";
  }

  function saveToken() {
    var v = document.getElementById("token").value.trim();
    localStorage.setItem("adminToken", v);
    connectLogs();
    refreshStatus();
    loadDir(currentPath);
    alert("Token 已保存");
  }

  function authHeaders(json) {
    var h = {};
    var token = getToken();
    if (token) h["x-admin-token"] = token;
    if (json !== false) h["Content-Type"] = "application/json";
    return h;
  }

  async function api(path, options) {
    options = options || {};
    var res = await fetch(API_BASE + path, {
      method: options.method || "GET",
      body: options.body,
      headers: Object.assign({}, authHeaders(!(options.body instanceof FormData)), options.headers || {})
    });
    var text = await res.text();
    var data = text;
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error((data && data.error) || text || ("HTTP " + res.status));
    return data;
  }

  async function refreshStatus() {
    try {
      var data = await api("/status");
      document.getElementById("status").innerHTML =
        "运行状态：<b>" + (data.running ? "运行中" : "未运行") + "</b> " +
        (data.pid ? "(PID " + data.pid + ")" : "") + "<br>" +
        "启动命令：<code>" + data.startCmd + "</code><br>" +
        "自定义 shell：<b>" + (data.adminEnableShell ? "已开启" : "未开启") + "</b><br>" +
        "frontendTcp：<code>" + JSON.stringify(data.probe.frontendTcp || null) + "</code><br>" +
        "apiTcp：<code>" + JSON.stringify(data.probe.apiTcp || null) + "</code><br>" +
        "frontendHttp：<code>" + JSON.stringify(data.probe.frontendHttp || null) + "</code><br>" +
        "apiHttp：<code>" + JSON.stringify(data.probe.apiHttp || null) + "</code>";
    } catch (e) {
      document.getElementById("status").textContent = "状态获取失败：" + e.message;
    }
  }

  async function startApp() {
    await api("/start", { method: "POST", body: "{}" });
    refreshStatus();
  }

  async function stopApp() {
    await api("/stop", { method: "POST", body: "{}" });
    refreshStatus();
  }

  async function runPreset(key) {
    await api("/run", { method: "POST", body: JSON.stringify({ key: key }) });
  }

  async function runCustom() {
    var cmd = document.getElementById("customCmd").value.trim();
    if (!cmd) return;
    await api("/run", { method: "POST", body: JSON.stringify({ cmd: cmd }) });
  }

  async function probeNow() {
    await api("/probe", { method: "POST", body: "{}" });
    refreshStatus();
  }

  function connectLogs() {
    if (eventSource) eventSource.close();
    var token = getToken();
    var url = API_BASE + "/logs" + (token ? ("?token=" + encodeURIComponent(token)) : "");
    eventSource = new EventSource(url);
    eventSource.onmessage = function (ev) {
      try {
        var item = JSON.parse(ev.data);
        var box = document.getElementById("logs");
        box.textContent += "[" + item.ts + "] " + item.line + "\\n";
        box.scrollTop = box.scrollHeight;
      } catch {}
    };
  }

  function mkBtn(text, cls, fn) {
    var b = document.createElement("button");
    if (cls) b.className = cls;
    b.textContent = text;
    b.onclick = fn;
    return b;
  }

  async function loadDir(p) {
    currentPath = p || "";
    var data = await api("/fs?path=" + encodeURIComponent(currentPath));
    document.getElementById("cwd").innerHTML = "当前目录：<code>/" + (data.cwd || "") + "</code>";
    var box = document.getElementById("files");
    box.innerHTML = "";

    if (data.parent !== null) {
      var up = document.createElement("li");
      up.innerHTML = '<div class="name">📁 ..</div>';
      up.onclick = function () { loadDir(data.parent); };
      box.appendChild(up);
    }

    if (!data.items || !data.items.length) {
      var empty = document.createElement("li");
      empty.textContent = "目录为空";
      box.appendChild(empty);
      return;
    }

    data.items.forEach(function (item) {
      var li = document.createElement("li");

      var name = document.createElement("div");
      name.className = "name";
      name.textContent = (item.type === "dir" ? "📁 " : "📄 ") + item.name;
      name.onclick = function () {
        if (item.type === "dir") loadDir(item.path);
        else openFile(item.path);
      };

      var meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = (item.type === "dir" ? "dir" : item.sizeText) + " | " + (item.mtime || "");

      var actions = document.createElement("div");
      actions.className = "actions";

      if (item.type === "dir") {
        actions.appendChild(mkBtn("进入", "", function () { loadDir(item.path); }));
      } else {
        actions.appendChild(mkBtn("打开", "", function () { openFile(item.path); }));
        actions.appendChild(mkBtn("下载", "success", function () { downloadFile(item.path); }));
      }

      actions.appendChild(mkBtn("重命名", "warn", function () { renameItem(item.path, item.name); }));
      actions.appendChild(mkBtn("删除", "danger", function () { deleteItem(item.path, item.type); }));

      li.appendChild(name);
      li.appendChild(meta);
      li.appendChild(actions);
      box.appendChild(li);
    });
  }

  function refreshDir() { loadDir(currentPath); }

  function goParent() {
    if (!currentPath) return;
    var parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    loadDir(parts.join("/"));
  }

  async function mkdirNow() {
    var name = prompt("请输入新文件夹名称");
    if (!name) return;
    await api("/fs/mkdir", {
      method: "POST",
      body: JSON.stringify({ path: currentPath, name: name })
    });
    refreshDir();
  }

  async function newFileNow() {
    var name = prompt("请输入新文件名");
    if (!name) return;
    var data = await api("/fs/newfile", {
      method: "POST",
      body: JSON.stringify({ path: currentPath, name: name })
    });
    refreshDir();
    if (data.path) openFile(data.path);
  }

  async function renameItem(pathValue, oldName) {
    var newName = prompt("请输入新名称", oldName);
    if (!newName || newName === oldName) return;
    await api("/fs/rename", {
      method: "POST",
      body: JSON.stringify({ path: pathValue, newName: newName })
    });
    refreshDir();
  }

  async function deleteItem(pathValue, type) {
    if (!confirm("确认删除这个" + (type === "dir" ? "文件夹" : "文件") + "？\\n" + pathValue)) return;
    await api("/fs/delete", {
      method: "POST",
      body: JSON.stringify({ path: pathValue })
    });
    if (currentFilePath === pathValue) clearEditor();
    refreshDir();
  }

  async function openFile(pathValue) {
    var data = await api("/file?path=" + encodeURIComponent(pathValue));
    currentFilePath = pathValue;
    document.getElementById("editingPath").innerHTML = "当前文件：<code>" + pathValue + "</code>";
    document.getElementById("editor").value = data.content || "";
  }

  async function saveCurrentFile() {
    if (!currentFilePath) return alert("请先打开文件");
    var content = document.getElementById("editor").value;
    await api("/file", {
      method: "POST",
      body: JSON.stringify({ path: currentFilePath, content: content })
    });
    alert("保存成功");
    refreshDir();
  }

  function clearEditor() {
    currentFilePath = "";
    document.getElementById("editingPath").textContent = "未打开文件";
    document.getElementById("editor").value = "";
  }

  function downloadFile(pathValue) {
    var token = getToken();
    var qs = "?path=" + encodeURIComponent(pathValue) + (token ? ("&token=" + encodeURIComponent(token)) : "");
    window.open(API_BASE + "/fs/download" + qs, "_blank");
  }

  async function uploadFiles(fileList) {
    if (!fileList || !fileList.length) return;
    var fd = new FormData();
    fd.append("path", currentPath);
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      fd.append("files", f, f.webkitRelativePath || f.name);
    }

    var headers = {};
    var token = getToken();
    if (token) headers["x-admin-token"] = token;

    var res = await fetch(API_BASE + "/fs/upload", {
      method: "POST",
      body: fd,
      headers: headers
    });

    var text = await res.text();
    var data = text;
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error((data && data.error) || text || ("HTTP " + res.status));

    document.getElementById("uploadInput").value = "";
    alert("上传完成：" + (data.saved || 0) + " 个文件");
    refreshDir();
  }

  window.startApp = startApp;
  window.stopApp = stopApp;
  window.runPreset = runPreset;
  window.runCustom = runCustom;
  window.probeNow = probeNow;
  window.saveToken = saveToken;
  window.refreshDir = refreshDir;
  window.goParent = goParent;
  window.mkdirNow = mkdirNow;
  window.newFileNow = newFileNow;
  window.saveCurrentFile = saveCurrentFile;
  window.clearEditor = clearEditor;
  window.uploadFiles = uploadFiles;

  document.getElementById("token").value = getToken();
  connectLogs();
  refreshStatus();
  loadDir("");
  setInterval(refreshStatus, 10000);
})();
</script>
</body>
</html>`;

function serveAdminHtml(req, res) {
  addLog(`[admin] serve html path=${req.path} originalUrl=${req.originalUrl}`);
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.status(200).send(ADMIN_HTML);
}

app.get(ADMIN_BASE, serveAdminHtml);
app.get(`${ADMIN_BASE}/`, serveAdminHtml);
app.get(`${ADMIN_BASE}/*`, (req, res, next) => {
  if (req.path.startsWith(`${ADMIN_BASE}/api/`)) return next();
  serveAdminHtml(req, res);
});

/* ---------------- /api 和 /socket.io 提前 raw 代理 ---------------- */

app.use("/api", (req, res) => {
  addLog(`[route] API matched method=${req.method} originalUrl=${req.originalUrl} url=${req.url}`);
  proxyHttp(apiProxy, req, res, "api");
});

app.use("/socket.io", (req, res) => {
  addLog(`[route] SOCKET matched method=${req.method} originalUrl=${req.originalUrl} url=${req.url}`);
  proxyHttp(apiProxy, req, res, "socket");
});

/* ---------------- admin api 解析器放在 proxy 后面 ---------------- */

const adminApi = express.Router();
adminApi.use(express.json({ limit: "10mb" }));
adminApi.use(express.urlencoded({ extended: true }));

adminApi.get("/status", requireAuth, async (_req, res) => {
  res.json({
    ok: true,
    root: ROOT,
    running: !!mainProc,
    pid: mainProc?.pid || null,
    startCmd: START_CMD,
    adminEnableShell: ADMIN_ENABLE_SHELL,
    presets: Object.keys(PRESET_COMMANDS),
    probe: probeState
  });
});

adminApi.post("/probe", requireAuth, async (_req, res) => {
  await runProbes();
  res.json({ ok: true, probe: probeState });
});

adminApi.post("/start", requireAuth, async (_req, res) => {
  const started = startMain();
  await runProbes();
  res.json({ ok: true, started, running: !!mainProc });
});

adminApi.post("/stop", requireAuth, async (_req, res) => {
  const stopped = stopMain();
  await runProbes();
  res.json({ ok: true, stopped, running: !!mainProc });
});

adminApi.post("/run", requireAuth, (req, res) => {
  const { key, cmd } = req.body || {};

  if (key && PRESET_COMMANDS[key]) {
    addLog(`[admin] run preset key=${key}`);
    spawnCommand(PRESET_COMMANDS[key], key);
    return res.json({ ok: true, mode: "preset", key });
  }

  if (cmd && ADMIN_ENABLE_SHELL) {
    addLog(`[admin] run shell cmd=${cmd}`);
    spawnCommand(String(cmd), "shell");
    return res.json({ ok: true, mode: "shell" });
  }

  addLog(`[admin] run rejected key=${key} cmd=${cmd}`);
  return res.status(400).json({ ok: false, error: "Unknown command or shell disabled" });
});

adminApi.get("/logs", requireAuth, (req, res) => {
  addLog("[admin] open logs sse");
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  for (const item of logBuffer) {
    res.write(`data: ${JSON.stringify(item)}\n\n`);
  }

  logClients.add(res);
  req.on("close", () => {
    logClients.delete(res);
  });
});

adminApi.get("/fs", requireAuth, async (req, res) => {
  try {
    const rel = String(req.query.path || "");
    addLog(`[fs] list path=${rel}`);
    const data = await listDir(rel);
    res.json(data);
  } catch (e) {
    addLog(`[fs] list error ${e.message}`);
    res.status(400).json({ ok: false, error: e.message });
  }
});

adminApi.get("/file", requireAuth, async (req, res) => {
  try {
    const rel = String(req.query.path || "");
    addLog(`[fs] read file path=${rel}`);
    const target = safeResolve(rel);
    const stat = await fs.stat(target);
    if (!stat.isFile()) return res.status(400).json({ ok: false, error: "Not a file" });
    if (stat.size > 2 * 1024 * 1024) return res.status(413).json({ ok: false, error: "File too large (>2MB)" });
    const content = await fs.readFile(target, "utf8");
    res.json({ ok: true, path: path.relative(ROOT, target), content });
  } catch (e) {
    addLog(`[fs] read file error ${e.message}`);
    res.status(400).json({ ok: false, error: e.message });
  }
});

adminApi.post("/file", requireAuth, async (req, res) => {
  try {
    const rel = String(req.body?.path || "");
    const content = String(req.body?.content ?? "");
    addLog(`[fs] write file path=${rel} bytes=${Buffer.byteLength(content)}`);
    const target = safeResolve(rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    res.json({ ok: true, path: rel });
  } catch (e) {
    addLog(`[fs] write file error ${e.message}`);
    res.status(400).json({ ok: false, error: e.message });
  }
});

adminApi.post("/fs/mkdir", requireAuth, async (req, res) => {
  try {
    const dir = String(req.body?.path || "");
    const name = String(req.body?.name || "");
    addLog(`[fs] mkdir dir=${dir} name=${name}`);
    const target = safeJoin(dir, name);
    await fs.mkdir(target, { recursive: true });
    res.json({ ok: true });
  } catch (e) {
    addLog(`[fs] mkdir error ${e.message}`);
    res.status(400).json({ ok: false, error: e.message });
  }
});

adminApi.post("/fs/newfile", requireAuth, async (req, res) => {
  try {
    const dir = String(req.body?.path || "");
    const name = String(req.body?.name || "");
    addLog(`[fs] newfile dir=${dir} name=${name}`);
    const target = safeJoin(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (!fssync.existsSync(target)) await fs.writeFile(target, "", "utf8");
    res.json({ ok: true, path: path.relative(ROOT, target) });
  } catch (e) {
    addLog(`[fs] newfile error ${e.message}`);
    res.status(400).json({ ok: false, error: e.message });
  }
});

adminApi.post("/fs/delete", requireAuth, async (req, res) => {
  try {
    const rel = String(req.body?.path || "");
    addLog(`[fs] delete path=${rel}`);
    const target = safeResolve(rel);
    if (target === ROOT) return res.status(403).json({ ok: false, error: "Cannot delete root" });
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      await fs.rm(target, { recursive: true, force: true });
    } else {
      await fs.unlink(target);
    }
    res.json({ ok: true });
  } catch (e) {
    addLog(`[fs] delete error ${e.message}`);
    res.status(400).json({ ok: false, error: e.message });
  }
});

adminApi.post("/fs/rename", requireAuth, async (req, res) => {
  try {
    const rel = String(req.body?.path || "");
    const newName = String(req.body?.newName || "");
    addLog(`[fs] rename path=${rel} newName=${newName}`);
    const oldTarget = safeResolve(rel);
    const parentRel = path.dirname(rel) === "." ? "" : path.dirname(rel);
    const newTarget = safeJoin(parentRel, newName);
    await fs.rename(oldTarget, newTarget);
    res.json({ ok: true, oldPath: rel, newPath: path.relative(ROOT, newTarget) });
  } catch (e) {
    addLog(`[fs] rename error ${e.message}`);
    res.status(400).json({ ok: false, error: e.message });
  }
});

adminApi.get("/fs/download", requireAuth, async (req, res) => {
  try {
    const rel = String(req.query.path || "");
    addLog(`[fs] download path=${rel}`);
    const target = safeResolve(rel);
    const stat = await fs.stat(target);
    if (!stat.isFile()) return res.status(400).json({ ok: false, error: "Not a file" });
    res.download(target, path.basename(target));
  } catch (e) {
    addLog(`[fs] download error ${e.message}`);
    res.status(400).json({ ok: false, error: e.message });
  }
});

adminApi.post("/fs/upload", requireAuth, upload.any(), async (req, res) => {
  try {
    const dirRel = String(req.body?.path || "");
    addLog(`[fs] upload dir=${dirRel} count=${(req.files || []).length}`);
    const baseDir = safeResolve(dirRel);
    const st = await fs.stat(baseDir);
    if (!st.isDirectory()) return res.status(400).json({ ok: false, error: "Target is not a directory" });

    let saved = 0;
    for (const file of req.files || []) {
      let relName = String(file.originalname || "").replace(/\\/g, "/").replace(/^\/+/, "");
      if (!relName || relName.includes("..")) continue;
      const dest = safeResolve(path.join(dirRel, relName));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, file.buffer);
      saved++;
      addLog(`[fs] upload saved ${relName} -> ${dest}`);
    }

    res.json({ ok: true, saved });
  } catch (e) {
    addLog(`[fs] upload error ${e.message}`);
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.use(`${ADMIN_BASE}/api`, adminApi);

/* ---------------- health ---------------- */

app.get("/healthz", async (_req, res) => {
  res.json({
    ok: true,
    running: !!mainProc,
    ports: {
      public: PORT,
      frontend: FRONTEND_PORT,
      api: API_PORT
    },
    probe: probeState
  });
});

/* ---------------- 其他全部给前端 ---------------- */

app.use((req, res) => {
  addLog(`[route] WEB fallback method=${req.method} originalUrl=${req.originalUrl} url=${req.url}`);
  proxyHttp(webProxy, req, res, "web");
});

/* ---------------- upgrade ---------------- */

server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  addLog(`[upgrade] url=${url}`);

  if (url.startsWith("/socket.io")) {
    proxyWs(apiProxy, req, socket, head, "api");
    return;
  }

  proxyWs(webProxy, req, socket, head, "web");
});

/* ---------------- boot ---------------- */

server.listen(PORT, "0.0.0.0", async () => {
  addLog(`[boot] manager listen 0.0.0.0:${PORT}`);
  addLog(`[boot] ADMIN_BASE=${ADMIN_BASE}`);
  addLog(`[boot] ROOT=${ROOT}`);
  addLog(`[boot] FRONTEND_PORT=${FRONTEND_PORT}`);
  addLog(`[boot] API_PORT=${API_PORT}`);
  addLog(`[boot] START_CMD=${START_CMD}`);
  addLog(`[boot] AUTO_START=${AUTO_START}`);
  addLog(`[boot] ADMIN_ENABLE_SHELL=${ADMIN_ENABLE_SHELL}`);
  addLog(`[boot] exists .env=${fssync.existsSync(path.join(ROOT, ".env"))}`);
  addLog(`[boot] exists .mcp.json=${fssync.existsSync(path.join(ROOT, ".mcp.json"))}`);

  await runProbes();

  if (AUTO_START) {
    setTimeout(() => {
      addLog("[boot] AUTO_START -> startMain()");
      startMain();
    }, 800);
  }

  setInterval(() => {
    runProbes().catch((e) => addLog(`[probe] interval error ${e.message}`));
  }, 20000);
});

process.on("SIGTERM", () => {
  addLog("[signal] SIGTERM");
  stopMain();
  process.exit(0);
});

process.on("SIGINT", () => {
  addLog("[signal] SIGINT");
  stopMain();
  process.exit(0);
});
