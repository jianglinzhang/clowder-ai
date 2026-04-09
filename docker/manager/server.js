import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const ROOT = path.resolve(process.env.APP_ROOT || "/app");
const PORT = Number(process.env.PORT || 7860);
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 3003);
const API_PORT = Number(process.env.API_SERVER_PORT || 3004);

const ADMIN_BASE = normalizeBase(process.env.ADMIN_BASE_PATH || "/admin");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const AUTO_START = process.env.AUTO_START !== "0";
const START_CMD = process.env.APP_START_CMD || "pnpm start:direct";
const ADMIN_ENABLE_SHELL = process.env.ADMIN_ENABLE_SHELL === "1";
const MAX_LOG_LINES = Number(process.env.MAX_LOG_LINES || 3000);

const PUBLIC_DIR = "/opt/manager/public";
const INDEX_FILE = path.join(PUBLIC_DIR, "index.html");

let mainProc = null;
const logBuffer = [];
const logClients = new Set();

const PRESET_COMMANDS = {
  build: "pnpm build",
  test: "pnpm test",
  status: "pnpm start:status || true",
  stopDaemon: "pnpm stop || true",
  runtimeStatus: "pnpm runtime:status || true",
  redisStatus: "pnpm redis:user:status || true"
};

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
  if (!isInsideRoot(target)) throw new Error("Path out of root");
  return target;
}

function safeJoin(relDir = "", name = "") {
  const cleanName = path.basename(String(name || "").trim());
  if (!cleanName) throw new Error("Invalid name");
  return safeResolve(path.join(relDir || "", cleanName));
}

function requireAuth(req, res, next) {
  if (!ADMIN_TOKEN) return next();

  const token =
    req.headers["x-admin-token"] ||
    req.query.token ||
    "";

  if (token === ADMIN_TOKEN) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

function spawnCommand(cmd, tag = "task", onExit) {
  addLog(`[${tag}] $ ${cmd}`);

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

  child.stdout?.on("data", (d) => addLog(`[${tag}] ${d.toString()}`));
  child.stderr?.on("data", (d) => addLog(`[${tag}] ${d.toString()}`));
  child.on("exit", (code, signal) => {
    addLog(`[${tag}] exited code=${code} signal=${signal}`);
    if (onExit) onExit(code, signal);
  });

  return child;
}

function startMain() {
  if (mainProc) return false;
  mainProc = spawnCommand(START_CMD, "main", () => {
    mainProc = null;
  });
  return true;
}

function stopMain() {
  if (!mainProc) return false;

  const pid = mainProc.pid;
  try {
    process.kill(-pid, "SIGTERM");
    addLog(`[main] SIGTERM sent to process group ${pid}`);
  } catch (e) {
    addLog(`[main] stop failed: ${e.message}`);
  }

  setTimeout(() => {
    if (!mainProc) return;
    try {
      process.kill(-pid, "SIGKILL");
      addLog(`[main] SIGKILL sent to process group ${pid}`);
    } catch {}
  }, 5000);

  mainProc = null;
  return true;
}

function formatSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
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

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, running: !!mainProc });
});

/* ---------------- Admin Page ---------------- */

app.get(ADMIN_BASE, (_req, res) => {
  res.redirect(`${ADMIN_BASE}/`);
});

app.get(`${ADMIN_BASE}/`, (_req, res) => {
  res.sendFile(INDEX_FILE);
});

/* ---------------- Admin APIs ---------------- */

app.get(`${ADMIN_BASE}/api/config`, (_req, res) => {
  res.json({
    ok: true,
    adminBase: ADMIN_BASE,
    root: ROOT,
    shellEnabled: ADMIN_ENABLE_SHELL
  });
});

app.get(`${ADMIN_BASE}/api/status`, requireAuth, (_req, res) => {
  res.json({
    ok: true,
    root: ROOT,
    running: !!mainProc,
    pid: mainProc?.pid || null,
    startCmd: START_CMD,
    adminEnableShell: ADMIN_ENABLE_SHELL,
    presets: Object.keys(PRESET_COMMANDS)
  });
});

app.post(`${ADMIN_BASE}/api/start`, requireAuth, (_req, res) => {
  const started = startMain();
  res.json({ ok: true, started, running: !!mainProc });
});

app.post(`${ADMIN_BASE}/api/stop`, requireAuth, (_req, res) => {
  const stopped = stopMain();
  res.json({ ok: true, stopped, running: !!mainProc });
});

app.post(`${ADMIN_BASE}/api/run`, requireAuth, (req, res) => {
  const { key, cmd } = req.body || {};

  if (key && PRESET_COMMANDS[key]) {
    spawnCommand(PRESET_COMMANDS[key], key);
    return res.json({ ok: true, mode: "preset", key });
  }

  if (cmd && ADMIN_ENABLE_SHELL) {
    spawnCommand(String(cmd), "shell");
    return res.json({ ok: true, mode: "shell" });
  }

  return res.status(400).json({
    ok: false,
    error: "Unknown command or shell disabled"
  });
});

app.get(`${ADMIN_BASE}/api/logs`, requireAuth, (req, res) => {
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

/* ---------------- File Manager APIs ---------------- */

app.get(`${ADMIN_BASE}/api/fs`, requireAuth, async (req, res) => {
  try {
    const rel = String(req.query.path || "");
    const data = await listDir(rel);
    res.json(data);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get(`${ADMIN_BASE}/api/file`, requireAuth, async (req, res) => {
  try {
    const rel = String(req.query.path || "");
    const target = safeResolve(rel);
    const stat = await fs.stat(target);

    if (!stat.isFile()) {
      return res.status(400).json({ ok: false, error: "Not a file" });
    }

    if (stat.size > 2 * 1024 * 1024) {
      return res.status(413).json({
        ok: false,
        error: "File too large (>2MB), please download instead"
      });
    }

    const content = await fs.readFile(target, "utf8");
    res.json({
      ok: true,
      path: path.relative(ROOT, target),
      content
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post(`${ADMIN_BASE}/api/file`, requireAuth, async (req, res) => {
  try {
    const rel = String(req.body?.path || "");
    const content = String(req.body?.content ?? "");
    const target = safeResolve(rel);

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");

    res.json({ ok: true, path: rel });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post(`${ADMIN_BASE}/api/fs/mkdir`, requireAuth, async (req, res) => {
  try {
    const dir = String(req.body?.path || "");
    const name = String(req.body?.name || "");
    const target = safeJoin(dir, name);

    await fs.mkdir(target, { recursive: true });

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post(`${ADMIN_BASE}/api/fs/newfile`, requireAuth, async (req, res) => {
  try {
    const dir = String(req.body?.path || "");
    const name = String(req.body?.name || "");
    const target = safeJoin(dir, name);

    await fs.mkdir(path.dirname(target), { recursive: true });

    if (!fssync.existsSync(target)) {
      await fs.writeFile(target, "", "utf8");
    }

    res.json({ ok: true, path: path.relative(ROOT, target) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post(`${ADMIN_BASE}/api/fs/delete`, requireAuth, async (req, res) => {
  try {
    const rel = String(req.body?.path || "");
    const target = safeResolve(rel);

    if (target === ROOT) {
      return res.status(403).json({ ok: false, error: "Cannot delete root" });
    }

    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      await fs.rm(target, { recursive: true, force: true });
    } else {
      await fs.unlink(target);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post(`${ADMIN_BASE}/api/fs/rename`, requireAuth, async (req, res) => {
  try {
    const rel = String(req.body?.path || "");
    const newName = String(req.body?.newName || "");
    const oldTarget = safeResolve(rel);

    const parentRel = path.dirname(rel) === "." ? "" : path.dirname(rel);
    const newTarget = safeJoin(parentRel, newName);

    await fs.rename(oldTarget, newTarget);

    res.json({
      ok: true,
      oldPath: rel,
      newPath: path.relative(ROOT, newTarget)
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get(`${ADMIN_BASE}/api/fs/download`, requireAuth, async (req, res) => {
  try {
    const rel = String(req.query.path || "");
    const target = safeResolve(rel);
    const stat = await fs.stat(target);

    if (!stat.isFile()) {
      return res.status(400).json({ ok: false, error: "Not a file" });
    }

    res.download(target, path.basename(target));
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post(`${ADMIN_BASE}/api/fs/upload`, requireAuth, upload.any(), async (req, res) => {
  try {
    const dirRel = String(req.body?.path || "");
    const baseDir = safeResolve(dirRel);

    const st = await fs.stat(baseDir);
    if (!st.isDirectory()) {
      return res.status(400).json({ ok: false, error: "Target is not a directory" });
    }

    const files = req.files || [];
    let saved = 0;

    for (const file of files) {
      let relName = String(file.originalname || "").replace(/\\/g, "/").replace(/^\/+/, "");
      if (!relName || relName.includes("..")) continue;

      const dest = safeResolve(path.join(dirRel, relName));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, file.buffer);
      saved++;
    }

    res.json({ ok: true, saved });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* 兼容 /admin/xxx 这种路径，统一回 index */
app.get(`${ADMIN_BASE}/*`, (req, res, next) => {
  if (req.path.startsWith(`${ADMIN_BASE}/api/`)) return next();
  res.sendFile(INDEX_FILE);
});

/* ---------------- Proxies ---------------- */

const apiProxy = createProxyMiddleware({
  target: `http://127.0.0.1:${API_PORT}`,
  changeOrigin: true,
  ws: true,
  logLevel: "warn",
  onError(_err, _req, res) {
    if (!res.headersSent) {
      res.status(503).json({ ok: false, error: "API not ready" });
    }
  }
});

const frontendProxy = createProxyMiddleware({
  target: `http://127.0.0.1:${FRONTEND_PORT}`,
  changeOrigin: true,
  ws: true,
  logLevel: "warn",
  onError(_err, _req, res) {
    if (!res.headersSent) {
      res.status(503).send(`
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Clowder AI starting...</title></head>
<body style="font-family:sans-serif;padding:32px">
  <h2>Clowder AI 正在启动中...</h2>
  <p>请稍后刷新。</p>
  <p><a href="${ADMIN_BASE}/">打开管理面板</a></p>
</body>
</html>
      `);
    }
  }
});

app.use("/api", apiProxy);
app.use("/socket.io", apiProxy);

app.use((req, res, next) => {
  if (req.path === ADMIN_BASE || req.path.startsWith(`${ADMIN_BASE}/`)) {
    return next();
  }
  return frontendProxy(req, res, next);
});

app.listen(PORT, "0.0.0.0", () => {
  addLog(`[manager] listening on 0.0.0.0:${PORT}`);
  addLog(`[manager] admin panel: ${ADMIN_BASE}/`);
  addLog(`[manager] app root: ${ROOT}`);
  addLog(`[manager] start cmd: ${START_CMD}`);

  if (AUTO_START) {
    setTimeout(() => {
      addLog("[manager] AUTO_START enabled, starting app...");
      startMain();
    }, 500);
  }
});

process.on("SIGTERM", () => {
  addLog("[manager] SIGTERM received");
  stopMain();
  process.exit(0);
});

process.on("SIGINT", () => {
  addLog("[manager] SIGINT received");
  stopMain();
  process.exit(0);
});
