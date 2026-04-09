import os
import io
import json
import time
import signal
import queue
import shlex
import threading
import subprocess
from collections import deque
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from flask import Flask, request, jsonify, Response, send_file

APP_ROOT = os.environ.get("APP_ROOT", "/app")
PORT = int(os.environ.get("PORT", "7860"))
MANAGER_PORT = int(os.environ.get("MANAGER_PORT", "7861"))
FRONTEND_PORT = int(os.environ.get("FRONTEND_PORT", "3003"))
API_PORT = int(os.environ.get("API_SERVER_PORT", "3004"))
AUTO_START = os.environ.get("AUTO_START", "1") != "0"
APP_START_CMD = os.environ.get("APP_START_CMD", "pnpm start:direct")
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
ADMIN_ENABLE_SHELL = os.environ.get("ADMIN_ENABLE_SHELL", "0") == "1"
MAX_LOG_LINES = int(os.environ.get("MAX_LOG_LINES", "5000"))

app = Flask(__name__)

main_proc = None
main_lock = threading.Lock()
log_buffer = deque(maxlen=MAX_LOG_LINES)
log_clients = []
log_clients_lock = threading.Lock()

probe_state = {
    "lastRunAt": None,
    "frontendHttp": None,
    "apiHttp": None,
}

PRESET_COMMANDS = {
    "build": "pnpm build",
    "test": "pnpm test",
    "status": "pnpm start:status || true",
    "stopDaemon": "pnpm stop || true",
    "runtimeStatus": "pnpm runtime:status || true",
    "redisStatus": "pnpm redis:user:status || true",
}

def log(msg):
    line = f"[manager] {msg}"
    print(line, flush=True)
    item = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "line": line}
    log_buffer.append(item)
    with log_clients_lock:
        dead = []
        for q in log_clients:
            try:
                q.put_nowait(item)
            except Exception:
                dead.append(q)
        for q in dead:
            try:
                log_clients.remove(q)
            except Exception:
                pass

def is_inside_root(target: str) -> bool:
    root = os.path.abspath(APP_ROOT)
    target = os.path.abspath(target)
    return target == root or target.startswith(root + os.sep)

def safe_resolve(rel=""):
    target = os.path.abspath(os.path.join(APP_ROOT, rel or "."))
    if not is_inside_root(target):
        raise ValueError(f"path out of root: {rel}")
    return target

def safe_join(rel_dir="", name=""):
    clean = os.path.basename((name or "").strip())
    if not clean:
        raise ValueError("invalid name")
    return safe_resolve(os.path.join(rel_dir or "", clean))

def require_auth():
    if not ADMIN_TOKEN:
        return None
    token = request.headers.get("x-admin-token") or request.args.get("token") or ""
    if token != ADMIN_TOKEN:
        log(f"auth deny method={request.method} path={request.path}")
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    return None

def list_dir(rel=""):
    target = safe_resolve(rel)
    if not os.path.isdir(target):
        raise ValueError("not a directory")

    items = []
    for name in os.listdir(target):
        full = os.path.join(target, name)
        st = os.stat(full)
        items.append({
            "name": name,
            "path": os.path.relpath(full, APP_ROOT),
            "type": "dir" if os.path.isdir(full) else "file",
            "size": st.st_size,
            "sizeText": format_size(st.st_size),
            "mtime": int(st.st_mtime),
        })

    items.sort(key=lambda x: (x["type"] != "dir", x["name"].lower()))
    cwd = os.path.relpath(target, APP_ROOT)
    if cwd == ".":
        cwd = ""
    parent = None if os.path.abspath(target) == os.path.abspath(APP_ROOT) else os.path.relpath(os.path.dirname(target), APP_ROOT)
    if parent == ".":
        parent = ""
    return {
        "ok": True,
        "root": APP_ROOT,
        "cwd": cwd,
        "parent": parent,
        "items": items,
    }

def format_size(size: int):
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    if size < 1024 * 1024 * 1024:
        return f"{size / 1024 / 1024:.1f} MB"
    return f"{size / 1024 / 1024 / 1024:.1f} GB"

def stream_reader(pipe, tag):
    try:
        for line in iter(pipe.readline, ''):
            if not line:
                break
            log(f"[{tag}] {line.rstrip()}")
    except Exception as e:
        log(f"[{tag}] stream error: {e}")
    finally:
        try:
            pipe.close()
        except Exception:
            pass

def spawn_command(cmd, tag="task", background=True):
    env = os.environ.copy()
    env["FORCE_COLOR"] = "1"
    log(f"spawn tag={tag} cmd={cmd}")
    proc = subprocess.Popen(
        ["bash", "-lc", f"cd {shlex.quote(APP_ROOT)} && {cmd}"],
        cwd=APP_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    log(f"spawn tag={tag} pid={proc.pid}")
    t = threading.Thread(target=stream_reader, args=(proc.stdout, tag), daemon=True)
    t.start()
    if background:
        return proc
    code = proc.wait()
    log(f"spawn tag={tag} exit code={code}")
    return code

def start_main():
    global main_proc
    with main_lock:
        if main_proc and main_proc.poll() is None:
            log("main already running")
            return False
        main_proc = spawn_command(APP_START_CMD, "main", background=True)

        def waiter(p):
            code = p.wait()
            log(f"main exited code={code}")
        threading.Thread(target=waiter, args=(main_proc,), daemon=True).start()
        return True

def stop_main():
    global main_proc
    with main_lock:
        if not main_proc or main_proc.poll() is not None:
            log("main not running")
            return False
        try:
            os.killpg(os.getpgid(main_proc.pid), signal.SIGTERM)
            log(f"main SIGTERM pid={main_proc.pid}")
        except Exception as e:
            log(f"main stop error: {e}")
            return False
        main_proc = None
        return True

def http_probe(name, url, headers=None):
    headers = headers or {}
    try:
        log(f"probe {name} -> {url}")
        req = Request(url, headers=headers)
        with urlopen(req, timeout=3) as resp:
            body = resp.read(180).decode("utf-8", errors="ignore")
            data = {
                "ok": True,
                "status": resp.status,
                "bodyPreview": body,
            }
            log(f"probe {name} <- {json.dumps(data, ensure_ascii=False)}")
            return data
    except HTTPError as e:
        body = e.read(180).decode("utf-8", errors="ignore")
        data = {
            "ok": True,
            "status": e.code,
            "bodyPreview": body,
        }
        log(f"probe {name} <- {json.dumps(data, ensure_ascii=False)}")
        return data
    except URLError as e:
        data = {
            "ok": False,
            "error": str(e),
        }
        log(f"probe {name} error {data}")
        return data
    except Exception as e:
        data = {
            "ok": False,
            "error": str(e),
        }
        log(f"probe {name} error {data}")
        return data

def run_probes():
    probe_state["lastRunAt"] = int(time.time())
    probe_state["frontendHttp"] = http_probe("frontend", f"http://127.0.0.1:{FRONTEND_PORT}/")
    probe_state["apiHttp"] = http_probe(
        "api",
        f"http://127.0.0.1:{API_PORT}/api/audit/thread/default?userId=default",
        {"X-Cat-Cafe-User": "default"},
    )

def admin_html():
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Clowder Admin</title>
  <style>
    * {{ box-sizing: border-box; }}
    body {{ margin:0; font-family:Arial,sans-serif; background:#0b1020; color:#e5e7eb; }}
    header {{ padding:16px 20px; background:#111827; border-bottom:1px solid #1f2937; }}
    .wrap {{ padding:16px; }}
    .card {{ background:#111827; border:1px solid #1f2937; border-radius:12px; padding:16px; margin-bottom:16px; }}
    .grid {{ display:grid; grid-template-columns:1fr 1fr; gap:16px; }}
    .toolbar {{ display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; align-items:center; }}
    button,.btn-label {{ background:#2563eb; color:#fff; border:0; padding:10px 14px; border-radius:8px; cursor:pointer; display:inline-block; }}
    button.secondary,.btn-label.secondary {{ background:#374151; }}
    button.danger {{ background:#dc2626; }}
    button.success,.btn-label.success {{ background:#16a34a; }}
    button.warn {{ background:#d97706; }}
    input,textarea {{ width:100%; padding:10px; border-radius:8px; border:1px solid #374151; background:#0f172a; color:#fff; }}
    textarea {{ min-height:260px; font-family:monospace; }}
    pre {{ margin:0; background:#020617; color:#d1fae5; border-radius:8px; padding:12px; min-height:280px; max-height:600px; overflow:auto; white-space:pre-wrap; }}
    ul {{ list-style:none; padding:0; margin:8px 0 0 0; }}
    li {{ padding:10px; border-bottom:1px solid #1f2937; }}
    li:hover {{ background:#0f172a; }}
    .muted {{ color:#94a3b8; font-size:14px; }}
    .row {{ display:flex; gap:12px; align-items:center; }}
    .row > * {{ flex:1; }}
    .status {{ margin-top:8px; color:#93c5fd; line-height:1.6; }}
    .path {{ margin:8px 0 12px 0; word-break:break-all; }}
    .files .name {{ font-weight:bold; cursor:pointer; }}
    .files .meta {{ color:#94a3b8; font-size:12px; margin-top:4px; }}
    .files .actions {{ margin-top:8px; display:flex; flex-wrap:wrap; gap:6px; }}
    .badge {{ display:inline-block; padding:3px 8px; border-radius:999px; background:#1f2937; color:#cbd5e1; font-size:12px; }}
    code {{ background:#0f172a; padding:2px 6px; border-radius:6px; }}
    a {{ color:#60a5fa; }}
    @media (max-width:960px){{ .grid {{ grid-template-columns:1fr; }} .row {{ flex-direction:column; align-items:stretch; }} }}
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
(function () {{
  var API_BASE = "/admin-api";
  var currentPath = "";
  var currentFilePath = "";
  var eventSource = null;

  function getToken() {{
    return localStorage.getItem("adminToken") || "";
  }}

  function saveToken() {{
    var v = document.getElementById("token").value.trim();
    localStorage.setItem("adminToken", v);
    connectLogs();
    refreshStatus();
    loadDir(currentPath);
    alert("Token 已保存");
  }}

  function authHeaders(json) {{
    var h = {{}};
    var token = getToken();
    if (token) h["x-admin-token"] = token;
    if (json !== false) h["Content-Type"] = "application/json";
    return h;
  }}

  async function api(path, options) {{
    options = options || {{}};
    var res = await fetch(API_BASE + path, {{
      method: options.method || "GET",
      body: options.body,
      headers: Object.assign({{}}, authHeaders(!(options.body instanceof FormData)), options.headers || {{}})
    }});
    var text = await res.text();
    var data = text;
    try {{ data = JSON.parse(text); }} catch {{}}
    if (!res.ok) throw new Error((data && data.error) || text || ("HTTP " + res.status));
    return data;
  }}

  async function refreshStatus() {{
    try {{
      var data = await api("/status");
      document.getElementById("status").innerHTML =
        "运行状态：<b>" + (data.running ? "运行中" : "未运行") + "</b> " +
        (data.pid ? "(PID " + data.pid + ")" : "") + "<br>" +
        "启动命令：<code>" + data.startCmd + "</code><br>" +
        "frontendHttp：<code>" + JSON.stringify(data.probe.frontendHttp || null) + "</code><br>" +
        "apiHttp：<code>" + JSON.stringify(data.probe.apiHttp || null) + "</code>";
    }} catch (e) {{
      document.getElementById("status").textContent = "状态获取失败：" + e.message;
    }}
  }}

  async function startApp() {{
    await api("/start", {{ method: "POST", body: "{{}}" }});
    refreshStatus();
  }}

  async function stopApp() {{
    await api("/stop", {{ method: "POST", body: "{{}}" }});
    refreshStatus();
  }}

  async function runPreset(key) {{
    await api("/run", {{ method: "POST", body: JSON.stringify({{ key: key }}) }});
  }}

  async function runCustom() {{
    var cmd = document.getElementById("customCmd").value.trim();
    if (!cmd) return;
    await api("/run", {{ method: "POST", body: JSON.stringify({{ cmd: cmd }}) }});
  }}

  async function probeNow() {{
    await api("/probe", {{ method: "POST", body: "{{}}" }});
    refreshStatus();
  }}

  function connectLogs() {{
    if (eventSource) eventSource.close();
    var token = getToken();
    var url = API_BASE + "/logs" + (token ? ("?token=" + encodeURIComponent(token)) : "");
    eventSource = new EventSource(url);
    eventSource.onmessage = function (ev) {{
      try {{
        var item = JSON.parse(ev.data);
        var box = document.getElementById("logs");
        box.textContent += "[" + item.ts + "] " + item.line + "\\n";
        box.scrollTop = box.scrollHeight;
      }} catch {{}}
    }};
  }}

  function mkBtn(text, cls, fn) {{
    var b = document.createElement("button");
    if (cls) b.className = cls;
    b.textContent = text;
    b.onclick = fn;
    return b;
  }}

  async function loadDir(p) {{
    currentPath = p || "";
    var data = await api("/fs?path=" + encodeURIComponent(currentPath));
    document.getElementById("cwd").innerHTML = "当前目录：<code>/" + (data.cwd || "") + "</code>";
    var box = document.getElementById("files");
    box.innerHTML = "";

    if (data.parent !== null) {{
      var up = document.createElement("li");
      up.innerHTML = '<div class="name">📁 ..</div>';
      up.onclick = function () {{ loadDir(data.parent); }};
      box.appendChild(up);
    }}

    if (!data.items || !data.items.length) {{
      var empty = document.createElement("li");
      empty.textContent = "目录为空";
      box.appendChild(empty);
      return;
    }}

    data.items.forEach(function (item) {{
      var li = document.createElement("li");

      var name = document.createElement("div");
      name.className = "name";
      name.textContent = (item.type === "dir" ? "📁 " : "📄 ") + item.name;
      name.onclick = function () {{
        if (item.type === "dir") loadDir(item.path);
        else openFile(item.path);
      }};

      var meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = (item.type === "dir" ? "dir" : item.sizeText) + " | " + (item.mtime || "");

      var actions = document.createElement("div");
      actions.className = "actions";

      if (item.type === "dir") {{
        actions.appendChild(mkBtn("进入", "", function () {{ loadDir(item.path); }}));
      }} else {{
        actions.appendChild(mkBtn("打开", "", function () {{ openFile(item.path); }}));
        actions.appendChild(mkBtn("下载", "success", function () {{ downloadFile(item.path); }}));
      }}

      actions.appendChild(mkBtn("重命名", "warn", function () {{ renameItem(item.path, item.name); }}));
      actions.appendChild(mkBtn("删除", "danger", function () {{ deleteItem(item.path, item.type); }}));

      li.appendChild(name);
      li.appendChild(meta);
      li.appendChild(actions);
      box.appendChild(li);
    }});
  }}

  function refreshDir() {{ loadDir(currentPath); }}

  function goParent() {{
    if (!currentPath) return;
    var parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    loadDir(parts.join("/"));
  }}

  async function mkdirNow() {{
    var name = prompt("请输入新文件夹名称");
    if (!name) return;
    await api("/fs/mkdir", {{
      method: "POST",
      body: JSON.stringify({{ path: currentPath, name: name }})
    }});
    refreshDir();
  }}

  async function newFileNow() {{
    var name = prompt("请输入新文件名");
    if (!name) return;
    var data = await api("/fs/newfile", {{
      method: "POST",
      body: JSON.stringify({{ path: currentPath, name: name }})
    }});
    refreshDir();
    if (data.path) openFile(data.path);
  }}

  async function renameItem(pathValue, oldName) {{
    var newName = prompt("请输入新名称", oldName);
    if (!newName || newName === oldName) return;
    await api("/fs/rename", {{
      method: "POST",
      body: JSON.stringify({{ path: pathValue, newName: newName }})
    }});
    refreshDir();
  }}

  async function deleteItem(pathValue, type) {{
    if (!confirm("确认删除这个" + (type === "dir" ? "文件夹" : "文件") + "？\\n" + pathValue)) return;
    await api("/fs/delete", {{
      method: "POST",
      body: JSON.stringify({{ path: pathValue }})
    }});
    if (currentFilePath === pathValue) clearEditor();
    refreshDir();
  }}

  async function openFile(pathValue) {{
    var data = await api("/file?path=" + encodeURIComponent(pathValue));
    currentFilePath = pathValue;
    document.getElementById("editingPath").innerHTML = "当前文件：<code>" + pathValue + "</code>";
    document.getElementById("editor").value = data.content || "";
  }}

  async function saveCurrentFile() {{
    if (!currentFilePath) return alert("请先打开文件");
    var content = document.getElementById("editor").value;
    await api("/file", {{
      method: "POST",
      body: JSON.stringify({{ path: currentFilePath, content: content }})
    }});
    alert("保存成功");
    refreshDir();
  }}

  function clearEditor() {{
    currentFilePath = "";
    document.getElementById("editingPath").textContent = "未打开文件";
    document.getElementById("editor").value = "";
  }}

  function downloadFile(pathValue) {{
    var token = getToken();
    var qs = "?path=" + encodeURIComponent(pathValue) + (token ? ("&token=" + encodeURIComponent(token)) : "");
    window.open(API_BASE + "/fs/download" + qs, "_blank");
  }}

  async function uploadFiles(fileList) {{
    if (!fileList || !fileList.length) return;
    var fd = new FormData();
    fd.append("path", currentPath);
    for (var i = 0; i < fileList.length; i++) {{
      var f = fileList[i];
      fd.append("files", f, f.webkitRelativePath || f.name);
    }}

    var headers = {{}};
    var token = getToken();
    if (token) headers["x-admin-token"] = token;

    var res = await fetch(API_BASE + "/fs/upload", {{
      method: "POST",
      body: fd,
      headers: headers
    }});

    var text = await res.text();
    var data = text;
    try {{ data = JSON.parse(text); }} catch {{}}
    if (!res.ok) throw new Error((data && data.error) || text || ("HTTP " + res.status));

    document.getElementById("uploadInput").value = "";
    alert("上传完成：" + (data.saved || 0) + " 个文件");
    refreshDir();
  }}

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
}})();
</script>
</body>
</html>"""

@app.route("/healthz")
def healthz():
    return jsonify({
        "ok": True,
        "running": bool(main_proc and main_proc.poll() is None),
        "probe": probe_state,
        "ports": {
            "manager": MANAGER_PORT,
            "frontend": FRONTEND_PORT,
            "api": API_PORT,
        }
    })

@app.route("/admin")
@app.route("/admin/")
def admin_page():
    log(f"route ADMIN {request.path}")
    return admin_html()

@app.route("/admin-api/status")
def admin_status():
    auth = require_auth()
    if auth:
        return auth
    return jsonify({
        "ok": True,
        "root": APP_ROOT,
        "running": bool(main_proc and main_proc.poll() is None),
        "pid": main_proc.pid if main_proc and main_proc.poll() is None else None,
        "startCmd": APP_START_CMD,
        "adminEnableShell": ADMIN_ENABLE_SHELL,
        "presets": list(PRESET_COMMANDS.keys()),
        "probe": probe_state,
    })

@app.route("/admin-api/probe", methods=["POST"])
def admin_probe():
    auth = require_auth()
    if auth:
        return auth
    run_probes()
    return jsonify({"ok": True, "probe": probe_state})

@app.route("/admin-api/start", methods=["POST"])
def admin_start():
    auth = require_auth()
    if auth:
        return auth
    started = start_main()
    return jsonify({"ok": True, "started": started})

@app.route("/admin-api/stop", methods=["POST"])
def admin_stop():
    auth = require_auth()
    if auth:
        return auth
    stopped = stop_main()
    return jsonify({"ok": True, "stopped": stopped})

@app.route("/admin-api/run", methods=["POST"])
def admin_run():
    auth = require_auth()
    if auth:
        return auth
    data = request.get_json(silent=True) or {}
    key = data.get("key")
    cmd = data.get("cmd")

    if key in PRESET_COMMANDS:
        spawn_command(PRESET_COMMANDS[key], key, background=True)
        return jsonify({"ok": True, "mode": "preset", "key": key})

    if cmd and ADMIN_ENABLE_SHELL:
        spawn_command(str(cmd), "shell", background=True)
        return jsonify({"ok": True, "mode": "shell"})

    return jsonify({"ok": False, "error": "Unknown command or shell disabled"}), 400

@app.route("/admin-api/logs")
def admin_logs():
    auth = require_auth()
    if auth:
        return auth

    q = queue.Queue()
    with log_clients_lock:
        log_clients.append(q)

    def gen():
        try:
            for item in list(log_buffer):
                yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
            while True:
                item = q.get()
                yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
        finally:
            with log_clients_lock:
                try:
                    log_clients.remove(q)
                except ValueError:
                    pass

    return Response(gen(), mimetype="text/event-stream")

@app.route("/admin-api/fs")
def fs_list():
    auth = require_auth()
    if auth:
        return auth
    try:
        rel = request.args.get("path", "")
        log(f"fs list path={rel}")
        return jsonify(list_dir(rel))
    except Exception as e:
        log(f"fs list error {e}")
        return jsonify({"ok": False, "error": str(e)}), 400

@app.route("/admin-api/file")
def fs_read():
    auth = require_auth()
    if auth:
        return auth
    try:
        rel = request.args.get("path", "")
        target = safe_resolve(rel)
        if not os.path.isfile(target):
            return jsonify({"ok": False, "error": "Not a file"}), 400
        if os.path.getsize(target) > 2 * 1024 * 1024:
            return jsonify({"ok": False, "error": "File too large (>2MB)"}), 413
        with open(target, "r", encoding="utf-8") as f:
            content = f.read()
        log(f"fs read file path={rel}")
        return jsonify({"ok": True, "path": rel, "content": content})
    except Exception as e:
        log(f"fs read error {e}")
        return jsonify({"ok": False, "error": str(e)}), 400

@app.route("/admin-api/file", methods=["POST"])
def fs_write():
    auth = require_auth()
    if auth:
        return auth
    try:
        data = request.get_json(silent=True) or {}
        rel = str(data.get("path", ""))
        content = str(data.get("content", ""))
        target = safe_resolve(rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as f:
            f.write(content)
        log(f"fs write file path={rel} bytes={len(content.encode('utf-8'))}")
        return jsonify({"ok": True, "path": rel})
    except Exception as e:
        log(f"fs write error {e}")
        return jsonify({"ok": False, "error": str(e)}), 400

@app.route("/admin-api/fs/mkdir", methods=["POST"])
def fs_mkdir():
    auth = require_auth()
    if auth:
        return auth
    try:
        data = request.get_json(silent=True) or {}
        dir_rel = str(data.get("path", ""))
        name = str(data.get("name", ""))
        target = safe_join(dir_rel, name)
        os.makedirs(target, exist_ok=True)
        log(f"fs mkdir dir={dir_rel} name={name}")
        return jsonify({"ok": True})
    except Exception as e:
        log(f"fs mkdir error {e}")
        return jsonify({"ok": False, "error": str(e)}), 400

@app.route("/admin-api/fs/newfile", methods=["POST"])
def fs_newfile():
    auth = require_auth()
    if auth:
        return auth
    try:
        data = request.get_json(silent=True) or {}
        dir_rel = str(data.get("path", ""))
        name = str(data.get("name", ""))
        target = safe_join(dir_rel, name)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        if not os.path.exists(target):
            with open(target, "w", encoding="utf-8") as f:
                f.write("")
        rel = os.path.relpath(target, APP_ROOT)
        log(f"fs newfile dir={dir_rel} name={name}")
        return jsonify({"ok": True, "path": rel})
    except Exception as e:
        log(f"fs newfile error {e}")
        return jsonify({"ok": False, "error": str(e)}), 400

@app.route("/admin-api/fs/delete", methods=["POST"])
def fs_delete():
    auth = require_auth()
    if auth:
        return auth
    try:
        data = request.get_json(silent=True) or {}
        rel = str(data.get("path", ""))
        target = safe_resolve(rel)
        if os.path.abspath(target) == os.path.abspath(APP_ROOT):
            return jsonify({"ok": False, "error": "Cannot delete root"}), 403
        if os.path.isdir(target):
            import shutil
            shutil.rmtree(target)
        else:
            os.remove(target)
        log(f"fs delete path={rel}")
        return jsonify({"ok": True})
    except Exception as e:
        log(f"fs delete error {e}")
        return jsonify({"ok": False, "error": str(e)}), 400

@app.route("/admin-api/fs/rename", methods=["POST"])
def fs_rename():
    auth = require_auth()
    if auth:
        return auth
    try:
        data = request.get_json(silent=True) or {}
        rel = str(data.get("path", ""))
        new_name = str(data.get("newName", ""))
        old_target = safe_resolve(rel)
        parent_rel = os.path.dirname(rel)
        if parent_rel == ".":
            parent_rel = ""
        new_target = safe_join(parent_rel, new_name)
        os.rename(old_target, new_target)
        log(f"fs rename path={rel} newName={new_name}")
        return jsonify({"ok": True, "oldPath": rel, "newPath": os.path.relpath(new_target, APP_ROOT)})
    except Exception as e:
        log(f"fs rename error {e}")
        return jsonify({"ok": False, "error": str(e)}), 400

@app.route("/admin-api/fs/download")
def fs_download():
    auth = require_auth()
    if auth:
        return auth
    try:
        rel = request.args.get("path", "")
        target = safe_resolve(rel)
        if not os.path.isfile(target):
            return jsonify({"ok": False, "error": "Not a file"}), 400
        log(f"fs download path={rel}")
        return send_file(target, as_attachment=True, download_name=os.path.basename(target))
    except Exception as e:
        log(f"fs download error {e}")
        return jsonify({"ok": False, "error": str(e)}), 400

@app.route("/admin-api/fs/upload", methods=["POST"])
def fs_upload():
    auth = require_auth()
    if auth:
        return auth
    try:
        dir_rel = request.form.get("path", "")
        base_dir = safe_resolve(dir_rel)
        if not os.path.isdir(base_dir):
            return jsonify({"ok": False, "error": "Target is not a directory"}), 400

        files = request.files.getlist("files")
        saved = 0
        for f in files:
            rel_name = (f.filename or "").replace("\\", "/").lstrip("/")
            if not rel_name or ".." in rel_name:
                continue
            dest = safe_resolve(os.path.join(dir_rel, rel_name))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            f.save(dest)
            saved += 1
            log(f"fs upload saved {rel_name} -> {dest}")

        return jsonify({"ok": True, "saved": saved})
    except Exception as e:
        log(f"fs upload error {e}")
        return jsonify({"ok": False, "error": str(e)}), 400

def auto_start_thread():
    time.sleep(1)
    if AUTO_START:
        log("AUTO_START enabled -> start_main")
        start_main()

def probe_loop():
    while True:
        try:
            run_probes()
        except Exception as e:
            log(f"probe loop error {e}")
        time.sleep(20)

if __name__ == "__main__":
    log(f"boot manager on 127.0.0.1:{MANAGER_PORT}")
    log(f"APP_ROOT={APP_ROOT}")
    log(f"FRONTEND_PORT={FRONTEND_PORT}")
    log(f"API_PORT={API_PORT}")
    log(f"AUTO_START={AUTO_START}")
    log(f"APP_START_CMD={APP_START_CMD}")
    log(f"ADMIN_ENABLE_SHELL={ADMIN_ENABLE_SHELL}")
    log(f"exists .env={os.path.exists(os.path.join(APP_ROOT, '.env'))}")
    log(f"exists .mcp.json={os.path.exists(os.path.join(APP_ROOT, '.mcp.json'))}")

    threading.Thread(target=probe_loop, daemon=True).start()
    threading.Thread(target=auto_start_thread, daemon=True).start()

    app.run(host="127.0.0.1", port=MANAGER_PORT, debug=False, threaded=True)
