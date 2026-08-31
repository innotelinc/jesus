#!/usr/bin/env python3
"""generate_ui.py — browser UI for the dograh workflow generator.

A tiny stdlib-only web app (no pip dependencies) that wraps
scripts/generate_dograh_workflow.py so you can create phone agents from a
browser instead of the terminal:

  • type a free-form description → AI expands it via the OmniRoute gateway
  • or fill the guided template fields (role / goal / script)
  • preview the generated workflow JSON in the page
  • one-click import into dograh + register a phone extension

Run (from the repo root):
    python3 scripts/generate_ui.py            # http://127.0.0.1:8090
    PORT=9000 python3 scripts/generate_ui.py  # custom port

Environment:
    PORT              listen port (default 8090)
    OMNIROUTE_URL     LLM gateway base (default http://127.0.0.1:20128)
    OMNIROUTE_API_KEY gateway API key (optional)
    OMNIROUTE_MODEL   model alias (default auto)
    DOGRAH_API_ENDPOINT  dograh API base (default http://127.0.0.1:8000)
    DOGRAH_API_TOKEN  X-API-Key used for the import (read from .env if unset)
"""

from __future__ import annotations

import html
import json
import os
import re
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(HERE))

# Reuse the generator's graph builder + LLM call directly (no subprocess).
from generate_dograh_workflow import build_workflow, llm_generate, guided  # noqa: E402

PORT = int(os.environ.get("PORT", "8090"))
GATEWAY = os.environ.get("OMNIROUTE_URL", "http://127.0.0.1:20128")
MODEL = os.environ.get("OMNIROUTE_MODEL", "auto")
DOGRAH = os.environ.get("DOGRAH_API_ENDPOINT", "http://127.0.0.1:8000")


def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


ENV = load_env_file(REPO / ".env")
API_KEY = os.environ.get("OMNIROUTE_API_KEY", ENV.get("OMNIROUTE_API_KEY", ""))
DOGRAH_TOKEN = os.environ.get("DOGRAH_API_TOKEN", ENV.get("DOGRAH_API_TOKEN", ""))

# Extension pool: 8005+ are the "create your own" range.
USED_EXTS = {"8000", "8001", "8002", "8003", "8004", "8005", "8006", "8007"}

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Capstone Workflow Studio</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:880px;margin:2rem auto;padding:0 1rem;background:#0f172a;color:#e2e8f0}
 h1{font-size:1.4rem} label{display:block;margin:.8rem 0 .2rem;font-size:.9rem;color:#94a3b8}
 input[type=text],textarea,select{width:100%;padding:.5rem;border:1px solid #334155;border-radius:6px;background:#1e293b;color:#e2e8f0;box-sizing:border-box}
 textarea{min-height:70px;resize:vertical}
 button{background:#2563eb;color:#fff;border:0;padding:.6rem 1.2rem;border-radius:6px;font-size:1rem;cursor:pointer;margin-top:1rem}
 button.secondary{background:#334155}
 pre{background:#1e293b;border:1px solid #334155;border-radius:6px;padding:1rem;overflow:auto;max-height:340px;font-size:.8rem}
 .row{display:flex;gap:1rem}.row>div{flex:1}
 .ok{color:#4ade80}.err{color:#f87171}#status{margin-top:.6rem;min-height:1.2em}
 .tabs{display:flex;gap:.5rem;margin-top:1rem}
 .tabs button{margin:0;background:#1e293b}.tabs button.active{background:#2563eb}
</style></head><body>
<h1>Capstone Workflow Studio</h1>
<p>Create a phone agent by describing it. Preview the JSON, then import it into dograh.</p>
<div class="tabs">
 <button id="tab-ai" class="active" onclick="pick('ai')">Describe it (AI)</button>
 <button id="tab-guided" onclick="pick('guided')">Guided template</button>
</div>
<div id="pane-ai">
 <label>Describe the agent in one line</label>
 <textarea id="desc" placeholder="e.g. a dental office that calls patients to remind them of appointments and offers to reschedule"></textarea>
</div>
<div id="pane-guided" style="display:none">
 <label>Agent role</label><input type="text" id="role" placeholder="e.g. an appointment reminder caller">
 <label>Overall goal</label><input type="text" id="goal" placeholder="e.g. confirm the appointment or reschedule it">
 <label>What it should say / do in the call</label>
 <textarea id="script" placeholder="e.g. confirm identity, state the date and time, offer to reschedule, confirm the outcome"></textarea>
</div>
<div class="row">
 <div><label>Workflow name (slug)</label><input type="text" id="name" placeholder="appointment-reminders"></div>
 <div><label>Use case</label><select id="usecase">
   <option value="inbound">inbound</option><option value="outbound">outbound</option>
   <option value="survey">survey</option><option value="interview">interview</option>
 </select></div>
</div>
<button onclick="generate()">Generate workflow</button>
<button class="secondary" onclick="importWf()">Import into dograh + assign extension</button>
<div id="status"></div>
<h3>Preview</h3><pre id="preview">// generated workflow JSON appears here</pre>
<script>
let mode='ai', current=null;
function pick(m){mode=m;
 document.getElementById('pane-ai').style.display=m==='ai'?'block':'none';
 document.getElementById('pane-guided').style.display=m==='guided'?'block':'none';
 document.getElementById('tab-ai').className=m==='ai'?'active':'';
 document.getElementById('tab-guided').className=m==='guided'?'active':'';}
async function generate(){
 const body={mode};
 if(mode==='ai') body.desc=document.getElementById('desc').value;
 else {body.role=document.getElementById('role').value;
       body.goal=document.getElementById('goal').value;
       body.prompt=document.getElementById('script').value;}
 body.name=document.getElementById('name').value;
 body.usecase=document.getElementById('usecase').value;
 const r=await fetch('/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const j=await r.json();
 document.getElementById('status').innerHTML=j.ok?'<span class=ok>Generated.</span>':'<span class=err>'+j.error+'</span>';
 if(j.ok){current=j.workflow;document.getElementById('preview').textContent=JSON.stringify(j.workflow,null,2);}
}
async function importWf(){
 if(!current){document.getElementById('status').innerHTML='<span class=err>Generate a workflow first.</span>';return;}
 const r=await fetch('/import',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({workflow:current,extension:true})});
 const j=await r.json();
 document.getElementById('status').innerHTML=j.ok
   ?'<span class=ok>Imported: workflow #'+j.workflow_id+(j.extension?(' on extension '+j.extension):'')+'</span>'
   :'<span class=err>'+j.error+'</span>';
}
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj: dict) -> None:
        self._send(code, json.dumps(obj).encode(), "application/json")

    def do_GET(self) -> None:
        if self.path in ("/", "/index.html"):
            self._send(200, PAGE.encode(), "text/html; charset=utf-8")
        elif self.path == "/healthz":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._json(400, {"ok": False, "error": "invalid JSON"})
            return

        if self.path == "/generate":
            self._generate(data)
        elif self.path == "/import":
            self._import(data)
        else:
            self._json(404, {"ok": False, "error": "not found"})

    # ── POST /generate ────────────────────────────────────────────────────
    def _generate(self, data: dict) -> None:
        name = (data.get("name") or "custom-agent").strip()
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", name):
            self._json(400, {"ok": False,
                             "error": "name must be lowercase letters/digits/hyphens (2-41 chars)"})
            return
        usecase = (data.get("usecase") or "inbound").strip().lower()
        try:
            if data.get("mode") == "guided":
                persona, greeting, script, close = guided(
                    name, usecase,
                    data.get("role") or "a friendly voice assistant",
                    data.get("goal") or "help the caller",
                    data.get("prompt") or "Help the caller with their request.",
                )
                pieces = {"persona": persona, "greeting": greeting,
                          "script": script, "close": close, "node": "Main Script"}
            else:
                desc = (data.get("desc") or "").strip()
                if not desc:
                    self._json(400, {"ok": False, "error": "describe the agent first"})
                    return
                pieces = llm_generate(desc, GATEWAY, API_KEY, MODEL)
            wf = build_workflow(
                name=name, trigger_path=name,
                persona_prompt=pieces["persona"], greeting=pieces["greeting"],
                script_prompt=pieces["script"], close_prompt=pieces["close"],
                node_name=pieces.get("node", "Main Script"),
            )
            # Remember for /import (keyed by name so two tabs don't clash).
            GENERATED[name] = wf
            self._json(200, {"ok": True, "workflow": wf})
        except SystemExit as e:  # llm_generate raises SystemExit on errors
            self._json(502, {"ok": False, "error": str(e)})
        except Exception as e:  # noqa: BLE001
            self._json(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})

    # ── POST /import ──────────────────────────────────────────────────────
    def _import(self, data: dict) -> None:
        wf = data.get("workflow") or {}
        name = wf.get("name") or ""
        if not name:
            self._json(400, {"ok": False, "error": "no workflow to import"})
            return
        if not DOGRAH_TOKEN:
            self._json(500, {"ok": False,
                             "error": "DOGRAH_API_TOKEN not set (run scripts/dograh_wire.py once, or set it in .env)"})
            return
        try:
            # 1. create the workflow in dograh
            req = urllib.request.Request(
                f"{DOGRAH}/api/v1/workflow/create/definition",
                data=json.dumps({"name": name, "workflow_definition": wf}).encode(),
                headers={"Content-Type": "application/json", "X-API-Key": DOGRAH_TOKEN},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                wf_id = (json.loads(resp.read() or b"{}") or {}).get("id")

            # 2. optionally register the next free extension as its phone number
            ext = None
            if data.get("extension"):
                cfgs = self._dograh_get("/api/v1/organizations/telephony-configs")
                configs = (cfgs or {}).get("configurations", [])
                if not configs:
                    raise RuntimeError("no telephony config found — run scripts/dograh_wire.py first")
                cfg_id = configs[0]["id"]
                nums = self._dograh_get(
                    f"/api/v1/organizations/telephony-configs/{cfg_id}/phone-numbers")
                used = {n.get("address") for n in (nums or {}).get("phone_numbers", [])} | USED_EXTS
                ext = next(f"8{i:03d}" for i in range(8, 200) if f"8{i:03d}" not in used)
                urllib.request.urlopen(urllib.request.Request(
                    f"{DOGRAH}/api/v1/organizations/telephony-configs/{cfg_id}/phone-numbers",
                    data=json.dumps({
                        "address": ext, "label": name,
                        "inbound_workflow_id": wf_id, "is_active": True,
                        "is_default_caller_id": False, "extra_metadata": {},
                    }).encode(),
                    headers={"Content-Type": "application/json", "X-API-Key": DOGRAH_TOKEN},
                    method="POST",
                ), timeout=30).read()
            self._json(200, {"ok": True, "workflow_id": wf_id, "extension": ext})
        except urllib.error.HTTPError as e:
            self._json(502, {"ok": False, "error": f"dograh API HTTP {e.code}: {e.read().decode(errors='replace')[:300]}"})
        except Exception as e:  # noqa: BLE001
            self._json(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})

    def _dograh_get(self, path: str) -> dict | None:
        req = urllib.request.Request(
            f"{DOGRAH}{path}", headers={"X-API-Key": DOGRAH_TOKEN, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read() or b"null")


GENERATED: dict[str, dict] = {}


def main() -> int:
    addr = ("0.0.0.0", PORT)
    print(f"Capstone Workflow Studio → http://0.0.0.0:{PORT}")
    print(f"  AI gateway : {GATEWAY} (model {MODEL})")
    print(f"  dograh API : {DOGRAH} ({'token OK' if DOGRAH_TOKEN else 'NO TOKEN — import disabled'})")
    try:
        ThreadingHTTPServer(addr, Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())