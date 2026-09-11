"""Dograh workflow authoring for the Control Center.

Builds the same ``globalNode → startCall → agentNode → endCall`` graph as
``scripts/generate_dograh_workflow.py`` (the Workflow Studio generator), so a
workflow created from the dashboard is identical to one created in the Studio
or by the dograh UI's own template flow. It also extracts the user-editable
prompt fields of an existing workflow so the dashboard can edit the same text
the dograh canvas exposes — structure (nodes/edges) is only changed there.

Kept dependency-free (urllib only) so it unit-tests without the stack —
mirrors ``app/agents.py``.
"""

from __future__ import annotations

import copy
import json
import os
import re
import urllib.error
import urllib.request
from typing import Any

GATEWAY_DEFAULT = "http://127.0.0.1:20128"
DEFAULT_MODEL = "auto"

# Node types whose ``data.prompt`` (plus ``startCall``'s greeting) is editable
# text. Structure changes stay in the dograh canvas / Workflow Studio.
EDITABLE_TYPES = {"globalNode", "startCall", "agentNode", "endCall"}

TRIGGER_PATH_RE = re.compile(r"[^a-z0-9]+")


class WorkflowError(RuntimeError):
    """A generation failure that should surface to the caller as a 4xx/502."""


# ── graph builders (mirror scripts/generate_dograh_workflow.py) ─────────────


def trigger_slug(name: str) -> str:
    """'Appointment Reminders' → 'appointment-reminders'."""
    slug = TRIGGER_PATH_RE.sub("-", (name or "").strip().lower()).strip("-")
    return slug or "custom-agent"


def build_workflow(
    name: str,
    trigger_path: str,
    persona_prompt: str,
    greeting: str,
    script_prompt: str,
    close_prompt: str,
    node_name: str = "Main Script",
) -> dict[str, Any]:
    """Assemble a globalNode → startCall → agentNode → endCall graph."""
    definition: dict[str, Any] = {
        "nodes": [
            {
                "id": "node-global",
                "type": "globalNode",
                "position": {"x": 0, "y": 360},
                "data": {"name": "Agent Persona", "prompt": persona_prompt},
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
                    "label": "script_started",
                    "condition": "You have opened the call and are ready to run the script.",
                    "transition_speech": "",
                    "transition_speech_type": "text",
                },
            },
            {
                "id": "edge-script-close",
                "source": "node-script",
                "target": "node-close",
                "data": {
                    "label": "script_complete",
                    "condition": "The script is complete and you are ready to close.",
                    "transition_speech": "",
                    "transition_speech_type": "text",
                },
            },
        ],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    }
    return {"name": name, **definition}


# ── guided template (no LLM) ────────────────────────────────────────────────


def guided_pieces(name: str, use_case: str, role: str, goal: str, msg: str) -> dict[str, str]:
    """Persona + greeting + script + close from deterministic templates."""
    use_case = (use_case or "inbound").strip().lower()
    role = (role or "a friendly voice assistant").strip()
    goal = (goal or "help the caller").strip()
    outbound = use_case in ("sales", "outbound", "outreach", "campaign")
    persona = (
        f"You are {role}. You are calling on behalf of {goal}. "
        "Always speak in short, natural sentences — this is a phone call, not an "
        "essay. Stay in character at all times. Be warm, professional and concise."
    )
    script = (
        "# Role\n" + f"{role}. {goal}.\n"
        "# Script / what to accomplish\n" + (msg or "Help the caller with their request.")
        + "\n\n# Rules\n- Voice conversation: short, natural sentences.\n"
        "- One question or statement at a time.\n"
        "- If the person wants to end the call, thank them and END THE CALL."
    )
    close = (
        "# Closing\n- Summarize any agreed next step in one sentence.\n"
        "- Thank them for their time.\n- Keep it to 2-3 sentences, then END THE CALL."
    )
    if outbound:
        greeting = (
            "Hi {{initial_context.contact_name | fallback:there}}, this is "
            f"{{{{initial_context.agent_name | fallback:{name.title()}}}}}, and I'm "
            f"calling about {role}. Do you have a quick minute?"
        )
    else:
        greeting = f"Hello, this is {name.title()} — how can I help you today?"
    return {"persona": persona, "greeting": greeting, "script": script, "close": close}


# ── AI generation via the OmniRoute gateway ─────────────────────────────────


def llm_pieces(description: str, gateway: str, api_key: str, model: str) -> dict[str, str]:
    """Ask the gateway to expand a description into the workflow pieces."""
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
        "model": model or DEFAULT_MODEL,
        "temperature": 0.4,
        "stream": False,
        "max_tokens": 1200,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": description},
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
        with urllib.request.urlopen(req, timeout=120) as resp:  # noqa: S310 - configured endpoint
            data = json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:300]
        raise WorkflowError(f"LLM gateway HTTP {err.code}: {detail}") from err
    except urllib.error.URLError as err:
        raise WorkflowError(
            f"LLM gateway unreachable at {gateway}: {err.reason} — is OmniRoute up?"
        ) from err

    content = ((data or {}).get("choices") or [{}])[0].get("message", {}).get("content", "")
    content = (content or "").strip()
    if content.startswith("```"):
        content = content.split("\n", 1)[-1]
        content = content.rsplit("```", 1)[0]
    if not content:
        raise WorkflowError("LLM returned empty content")
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as err:
        raise WorkflowError(f"LLM did not return JSON: {content[:300]}") from err
    return {
        "persona": parsed.get("persona") or "You are a friendly voice assistant.",
        "greeting": parsed.get("greeting") or "Hello, how can I help you today?",
        "script": parsed.get("script") or "Handle the caller's request conversationally.",
        "close": parsed.get("close") or "Thank them and end the call.",
        "node": parsed.get("node_name") or parsed.get("script_title") or "Main Script",
    }


def generate_definition(name: str, mode: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Build a workflow definition from a dashboard request.

    ``mode``: ``ai`` (expand ``description`` via OmniRoute), ``guided`` (build
    from role/goal/prompt) or ``blank`` (a minimal working agent to edit).
    """
    mode = (payload.get("mode") or mode or "guided").strip().lower()
    use_case = str(payload.get("useCase") or payload.get("use_case") or "inbound")
    if mode == "ai":
        description = str(payload.get("description") or "").strip()
        if not description:
            raise WorkflowError("describe the agent first (mode 'ai' needs a description)")
        pieces = llm_pieces(
            description,
            os.environ.get("OMNIROUTE_URL", GATEWAY_DEFAULT),
            os.environ.get("OMNIROUTE_API_KEY", ""),
            os.environ.get("OMNIROUTE_MODEL", DEFAULT_MODEL),
        )
    elif mode == "guided":
        pieces = guided_pieces(
            name,
            use_case,
            str(payload.get("role") or ""),
            str(payload.get("goal") or ""),
            str(payload.get("prompt") or ""),
        )
    elif mode == "blank":
        pieces = guided_pieces(name, use_case, "a friendly voice assistant", "help the caller", "")
    else:
        raise WorkflowError(f"unknown workflow mode '{mode}' (expected ai, guided or blank)")

    return build_workflow(
        name=name,
        trigger_path=trigger_slug(name),
        persona_prompt=pieces["persona"],
        greeting=pieces["greeting"],
        script_prompt=pieces["script"],
        close_prompt=pieces["close"],
        node_name=pieces.get("node", "Main Script"),
    )


# ── editable prompts of an existing workflow ────────────────────────────────


def editable_nodes(definition: dict[str, Any] | None) -> list[dict[str, Any]]:
    """The prompt-bearing nodes of a workflow, in graph order."""
    out: list[dict[str, Any]] = []
    for node in (definition or {}).get("nodes") or []:
        if not isinstance(node, dict) or node.get("type") not in EDITABLE_TYPES:
            continue
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        entry: dict[str, Any] = {
            "id": node.get("id"),
            "type": node.get("type"),
            "name": data.get("name") or node.get("id") or "",
            "prompt": data.get("prompt") or "",
        }
        if node.get("type") == "startCall":
            entry["greeting"] = data.get("greeting") or ""
        out.append(entry)
    return out


def apply_node_edits(
    definition: dict[str, Any] | None, edits: list[dict[str, Any]] | None
) -> dict[str, Any]:
    """Merge ``[{id, name?, prompt?, greeting?}]`` edits into a definition."""
    merged = copy.deepcopy(definition or {})
    by_id = {
        node.get("id"): node
        for node in merged.get("nodes") or []
        if isinstance(node, dict)
    }
    for edit in edits or []:
        if not isinstance(edit, dict):
            continue
        node = by_id.get(edit.get("id"))
        if node is None or node.get("type") not in EDITABLE_TYPES:
            continue
        data = node.get("data")
        if not isinstance(data, dict):
            data = {}
            node["data"] = data
        if edit.get("name") is not None:
            data["name"] = str(edit["name"])
        if edit.get("prompt") is not None:
            data["prompt"] = str(edit["prompt"])
        if edit.get("greeting") is not None and node.get("type") == "startCall":
            data["greeting"] = str(edit["greeting"])
    return merged
