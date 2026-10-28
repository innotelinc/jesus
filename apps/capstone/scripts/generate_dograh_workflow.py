#!/usr/bin/env python3
"""generate_dograh_workflow.py — create a custom dograh phone workflow.

Lets you define a new voice agent by describing what you want and generating an
importable dograh workflow JSON (the same schema as the workflows in dograh/*).
Two modes:

  1. Guided template  — answer a few prompts (use case, role/goal, key script)
     and a deterministic template builds the workflow graph.
  2. LLM (free-form)  — give a one-line description and this script calls the
     self-hosted OmniRoute gateway (`/v1/chat/completions`) to expand it into a
     persona, greeting and script, then builds the same graph around it. This
     is the "describe what you want and AI creates it" flow.

Output is written to `dograh/<name>-workflow.json` (or the --out path) and can
be imported the usual way — `python3 scripts/dograh_wire.py` (all tracks are
imported + wired), or `python3 dograh/import_workflow.py dograh/<name>-workflow.json`.

Usage:
  python3 scripts/generate_dograh_workflow.py --name sales-call \
      --use-case outbound --desc "a friendly outreach call that books demos"
  python3 scripts/generate_dograh_workflow.py --name helpdesk \
      --use-case inbound --prompt "IT help desk that asks for the caller's issue..." \
      --out dograh/helpdesk-workflow.json
  # guided interactive:
  python3 scripts/generate_dograh_workflow.py --guided

Environment:
  OMNIROUTE_URL    LLM gateway base (default http://127.0.0.1:20128)
  OMNIROUTE_API_KEY  gateway API key (Bearer), optional
  OMNIROUTE_MODEL  model alias to request (default auto)
  DOGRAH_API_ENDPOINT / DOGRAH_API_TOKEN  only used with --import (optional)
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DOGRAH_DIR = REPO / "dograh"

GATEWAY_DEFAULT = "http://127.0.0.1:20128"


# ── graph builders ──────────────────────────────────────────────────────────
def build_workflow(
    name: str,
    trigger_path: str,
    persona_prompt: str,
    greeting: str,
    script_prompt: str,
    close_prompt: str,
    node_name: str = "Main Script",
    edge_open_label: str = "script_started",
    edge_open_condition: str = "You have opened the call and are ready to run the script.",
    edge_close_label: str = "script_complete",
    edge_close_condition: str = "The script is complete and you are ready to close.",
) -> dict:
    """Assemble a globalNode → startCall → agentNode → endCall graph."""
    definition = {
        "nodes": [
            {
                "id": "node-global",
                "type": "globalNode",
                "position": {"x": 0, "y": 360},
                "data": {
                    "name": "Agent Persona",
                    "prompt": persona_prompt,
                },
            },
            {
                "id": "node-trigger",
                "type": "trigger",
                "position": {"x": 0, "y": 120},
                "data": {
                    "name": "Agent Trigger",
                    "enabled": True,
                    "trigger_path": trigger_path,
                },
            },
            {
                "id": "node-start",
                "type": "startCall",
                "position": {"x": 0, "y": 0},
                "data": {
                    "name": "Open & Greet",
                    "greeting_type": "text",
                    "greeting": greeting,
                    "prompt": (
                        "# Role\n" + script_prompt
                        + "\n\n# Opening\n1. Greet the caller/person appropriately.\n"
                        "2. If you need consent or availability, ask for it first.\n"
                        "3. Start the main part of the script (next node)."
                    ),
                    "allow_interrupt": True,
                    "add_global_prompt": True,
                    "delayed_start": False,
                    "delayed_start_duration": 2,
                    "extraction_enabled": True,
                    "pre_call_fetch_mode": "disabled",
                },
            },
            {
                "id": "node-script",
                "type": "agentNode",
                "position": {"x": 300, "y": 0},
                "data": {
                    "name": node_name,
                    "prompt": script_prompt,
                    "allow_interrupt": True,
                    "add_global_prompt": True,
                    "extraction_enabled": True,
                },
            },
            {
                "id": "node-close",
                "type": "endCall",
                "position": {"x": 600, "y": 0},
                "data": {
                    "name": "Wrap Up & Hang Up",
                    "prompt": close_prompt,
                    "add_global_prompt": True,
                    "extraction_enabled": True,
                },
            },
        ],
        "edges": [
            {
                "id": "edge-start-script",
                "source": "node-start",
                "target": "node-script",
                "data": {
                    "label": edge_open_label,
                    "condition": edge_open_condition,
                    "transition_speech": "",
                    "transition_speech_type": "text",
                },
            },
            {
                "id": "edge-script-close",
                "source": "node-script",
                "target": "node-close",
                "data": {
                    "label": edge_close_label,
                    "condition": edge_close_condition,
                    "transition_speech": "",
                    "transition_speech_type": "text",
                },
            },
        ],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    }
    return {"name": name, **definition}


# ── guided template ─────────────────────────────────────────────────────────
def guided(name: str, use_case: str, role: str, goal: str, msg: str) -> str:
    """Produce a persona + script from deterministic templates (no LLM)."""
    use_case = (use_case or "inbound").strip().lower()
    greeting_ctx = (
        "from {{initial_context.organization_or_company | fallback:our organization}}"
        if use_case in ("sales", "outbound", "outreach", "campaign")
        else "thank you for calling x-placeholder"
    )
    persona = (
        f"You are {role}. You are calling on behalf of {goal}. "
        "Always speak in short, natural sentences — this is a phone call, not an "
        "essay. Stay in character at all times. Be warm, professional and concise."
    )
    script = (
        "# Role\n" + f"{role}. {goal}.\n"
        "# Script / what to accomplish\n" + msg
        + "\n\n# Rules\n- Voice conversation: short, natural sentences.\n"
        "- One question or statement at a time.\n- If the person wants to end the "
        "call, thank them and END THE CALL."
    )
    close = (
        "# Closing\n- Summarize any agreed next step in one sentence.\n"
        "- Thank them for their time.\n- Keep it to 2-3 sentences, then END THE CALL."
    )
    greeting = (
        f"Hi {{initial_context.contact_name | fallback:there}}, this is "
        f"{{{{initial_context.agent_name | fallback:{name.title()}}}}}, and I'm "
        f"calling about {role}. Do you have a quick minute?"
        if use_case in ("sales", "outbound", "outreach", "campaign")
        else f"Hello, this is {name.title()} — how can I help you today?"
    )
    return persona, greeting, script, close


# ── LLM generation via OmniRoute ───────────────────────────────────────────
def llm_generate(desc: str, gateway: str, api_key: str, model: str) -> dict:
    """Ask the gateway to expand a description into the workflow pieces.

    Returns {persona, greeting, script, close}. Strict JSON via the prompt.
    """
    system = (
        "You design phone-call voice agent scripts. Given a one-line description, "
        "return ONLY JSON with these keys (no markdown): "
        "persona (string, an in-character persona prompt), "
        "greeting (string, spoken greeting using {{...}} placeholders sparingly, "
        "e.g. {{initial_context.contact_name | fallback:there}}), "
        "script (string, the in-character '# Role' + checklist of what to accomplish, "
        "a phone script), "
        "close (string, an in-character closing prompt). "
        "Keep everything conversationally short; it is a phone call."
    )
    payload = {
        "model": model,
        "temperature": 0.4,
        "stream": False,
        "max_tokens": 1200,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": desc},
        ],
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(
        f"{gateway.rstrip('/')}/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"LLM gateway error HTTP {e.code}: {e.read().decode(errors='replace')[:400]}")
    except urllib.error.URLError as e:
        raise SystemExit(f"LLM gateway unreachable at {gateway}: {e.reason} — is OmniRoute up?")

    content = ((data or {}).get("choices") or [{}])[0].get("message", {}).get("content", "")
    if not content:
        raise SystemExit("LLM returned empty content")
    # strip fences if present
    content = content.strip()
    if content.startswith("```"):
        content = content.split("\n", 1)[-1]
        content = content.rsplit("```", 1)[0]
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        raise SystemExit(f"LLM did not return JSON. Raw:\n{content[:600]}")
    persona = parsed.get("persona") or "You are a friendly voice assistant."
    greeting = parsed.get("greeting") or "Hello, how can I help you today?"
    script = parsed.get("script") or "Handle the caller's request conversationally."
    close = parsed.get("close") or "Thank them and end the call."
    node = parsed.get("node_name") or parsed.get("script_title") or "Main Script"
    return {"persona": persona, "greeting": greeting, "script": script, "close": close, "node": node}


def make_trigger(use_case: str, name: str) -> str:
    """Pick a trigger path + extension suggestion from the use case."""
    slug = name.strip().replace(" ", "-").lower()
    return slug or "custom-agent"


def interactive() -> dict:
    """Collect settings interactively. Returns an args-like dict."""
    a = {
        "name": input("Workflow name? [my-agent] ").strip() or "my-agent",
        "use_case": input("Use case? [inbound] (inbound|outbound|survey|interview|custom) ").strip() or "inbound",
        "out": "",
        "import_wf": False,
        "gateway": os.environ.get("OMNIROUTE_URL", GATEWAY_DEFAULT),
        "desc": "",
        "prompt": "",
        "role": "a friendly voice assistant",
        "goal": "help the caller",
    }
    print("How do you want to create it?")
    print("  1) Guided template (answer a few questions, no LLM)")
    print("  2) Describe it and let AI generate it (OmniRoute gateway)")
    mode = input("Choose 1 or 2: ").strip()
    if mode == "1":
        a["role"] = input("Agent role? (e.g. sales rep) ").strip()
        a["goal"] = input("Overall goal? (e.g. book a demo) ").strip()
        a["prompt"] = input("What should it say / accomplish in the call? ").strip()
    else:
        a["desc"] = input("Describe the workflow in one line: ").strip()
    return a


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", default="", help="workflow name + trigger slug")
    parser.add_argument("--use-case", default="inbound",
                        help="inbound|outbound|survey|interview|custom (used for guided templates)")
    parser.add_argument("--desc", default="", help="free-form description (LLM mode)")
    parser.add_argument("--prompt", default="", help="guided script text (no LLM)")
    parser.add_argument("--role", default="a friendly voice assistant", help="agent role (guided)")
    parser.add_argument("--goal", default="help the caller", help="agent goal (guided)")
    parser.add_argument("--guided", action="store_true", help="use guided template instead of LLM")
    parser.add_argument("--out", default="", help="output JSON path")
    parser.add_argument("--import-wf", dest="import_wf", action="store_true",
                        help="after writing, import via scripts/dograh_wire.py if running")
    parser.add_argument("--gateway", default=os.environ.get("OMNIROUTE_URL", GATEWAY_DEFAULT))
    args = parser.parse_args()

    if args.guided or (args.desc and not args.llm):  # --guided or --prompt
        pass

    # Decide mode. Interactive if no name given.
    use_interactive = not args.name and sys.stdin.isatty()
    if use_interactive:
        args = interactive()

    name = (args.name or "custom-agent").strip()
    use_case = (args.use_case or "inbound").strip().lower()
    out = Path(args.out) if args.out else DOGRAH_DIR / f"{name.replace(' ','-').lower()}-workflow.json"

    if args.desc and not args.prompt:
        api_key = os.environ.get("OMNIROUTE_API_KEY", "")
        model = os.environ.get("OMNIROUTE_MODEL", "auto")
        print(f"[gen] expanding description via gateway {args.gateway} (model={model})…")
        pieces = llm_generate(args.desc, args.gateway, api_key, model)
    elif args.prompt or args.role or args.goal:
        pieces = {}
        persona, greeting, script, close = guided(name, use_case, args.role, args.goal, args.prompt)
        pieces = {"persona": persona, "greeting": greeting, "script": script, "close": close, "node": "Main Script"}
    else:
        print("Nothing to generate: pass --desc (LLM) or --prompt/--guided (template).", file=sys.stderr)
        return 2

    trigger = make_trigger(use_case, name)
    try:
        workflow = build_workflow(
            name=name,
            trigger_path=trigger,
            persona_prompt=pieces["persona"],
            greeting=pieces["greeting"],
            script_prompt=pieces["script"],
            close_prompt=pieces["close"],
            node_name=pieces.get("node", "Main Script"),
        )
    except KeyError as e:
        raise SystemExit(f"missing generated piece: {e}")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(workflow, indent=2, ensure_ascii=False) + "\n")
    print(f"[gen] wrote {out}")
    print(f"[gen] trigger path: {trigger}   name: {name!r}")
    print("Next: import via `python3 scripts/dograh_wire.py --workflows-dir dograh`\n"
          "      (or `python3 dograh/import_workflow.py <file>`) and re-run to wire an extension.")

    if args.import_wf:
        env = dict(os.environ)
        env.setdefault("DOGRAH_API_ENDPOINT", os.environ.get("DOGRAH_API_ENDPOINT", "http://127.0.0.1:8000"))
        subprocess.run([sys.executable, str(REPO / "scripts" / "dograh_wire.py")], env=env, check=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())