#!/usr/bin/env python3
"""Aggregate-only audit of Pi custom extension use in ~/.pi/agent/sessions.

Raw prompts, tool arguments, results, paths, and reasoning are inspected in memory only.
The output contains counts, dates, categorical failure labels, and registered names.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import re
import subprocess
from pathlib import Path

HOME = Path.home()
DEFAULT_REPO = Path(__file__).resolve().parent.parent
AUDIT_SCHEMA_VERSION = 3
AUDIT_CLASSIFIER_VERSION = "pi-session-audit-v3"
SESSION_KIND_POLICY_VERSION = "pi-session-audit-kind-v2"


def parse_args():
    parser = argparse.ArgumentParser(description="Aggregate-only Pi extension session audit")
    parser.add_argument("--sessions", default=str(HOME / ".pi" / "agent" / "sessions"))
    parser.add_argument("--repo", default=str(DEFAULT_REPO))
    parser.add_argument("--registry")
    parser.add_argument("--output")
    parser.add_argument("--exclude-session", action="append", default=[], help="Session id or JSONL path; repeatable")
    parser.add_argument("--since-at", help="Only count timestamped rows at or after this ISO-8601 boundary")
    parser.add_argument("--source-version", default="unknown")
    parser.add_argument("--config-version", default="unknown")
    return parser.parse_args()


ARGS = parse_args()
ROOT = Path(ARGS.sessions).expanduser().resolve()
REPO = Path(ARGS.repo).expanduser().resolve()
REGISTRY = Path(ARGS.registry).expanduser().resolve() if ARGS.registry else REPO / ".pi" / "session-audit" / "registry.json"
OUT = Path(ARGS.output).expanduser().resolve() if ARGS.output else REPO / ".pi" / "session-audit" / "latest.json"
SESSION_FILE_STEM = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z_(.+)$")


def session_id_from_value(value):
    stem = Path(value).stem
    match = SESSION_FILE_STEM.fullmatch(stem)
    return match.group(1) if match else stem


EXCLUDED_SESSION_IDS = {session_id_from_value(value) for value in [*ARGS.exclude_session, os.environ.get("PI_SESSION_FILE")] if value}


def session_file_id(file):
    return session_id_from_value(file)


def iso(value):
    if not value:
        return None
    if isinstance(value, (int, float)):
        try:
            return dt.datetime.fromtimestamp(value / (1000 if value > 1e11 else 1), dt.timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            return None
    try:
        return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return None


SINCE_AT = iso(ARGS.since_at)
if ARGS.since_at and not SINCE_AT:
    raise SystemExit("--since-at must be a valid ISO-8601 timestamp")
for label, value in (("source-version", ARGS.source_version), ("config-version", ARGS.config_version)):
    if not re.fullmatch(r"[A-Za-z0-9_.:+-]{1,160}", value):
        raise SystemExit(f"--{label} must be a privacy-safe identifier")


def text_content(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(str(p.get("text", "")) for p in content if isinstance(p, dict) and p.get("type") in {"text", "input_text"})


def error_category(content):
    if isinstance(content, list):
        text = " ".join(str(x.get("text", "")) if isinstance(x, dict) else str(x) for x in content)
    else:
        try:
            text = content if isinstance(content, str) else json.dumps(content)
        except Exception:
            text = str(content)
    text = text.lower()[:100000]
    rules = [
        ("policy-boundary", r"policy-enforcer block|outside repo|must stay inside cwd|approval key"),
        ("edit-match", r"exact text|oldtext|old text must match|text must be unique|occurrences"),
        ("timeout", r"timed? ?out|timeout|deadline exceeded"),
        ("missing-resource", r"enoent|no such file|cannot find module|module not found|not found on path|not installed|not initialized|binary: missing"),
        ("invalid-arguments", r"validation failed|invalid tool argument|requires task|must be equal to constant|must provide|required"),
        ("missing-prerequisite", r"no verification-center latest evidence|run /verify-run first|prerequisite|not-ready"),
        ("automation-contract", r"exact completion promise|no active or paused automation loop|explicit user loop|autonomy intent"),
        ("adapter-failure", r"semgrep command failed|codegraph command failed|adapter command failed"),
        ("parse-syntax-patch", r"invalid regular expression|syntaxerror|unexpected eof|assertionerror|patch hunk does not apply"),
        ("command-failure", r"command exited with code|\"status\":\"failed\"|\"exit_code\":[1-9]|tests? failed"),
    ]
    for name, pat in rules:
        if re.search(pat, text):
            return name
    return "other-tool-error"


def git_history(extension_name):
    try:
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,160}", str(extension_name)):
            return {"birthAt": None, "lastChangedAt": None}
        candidates = [Path(".pi") / "extensions" / extension_name / "index.ts", Path("extensions") / extension_name / "index.ts"]
        rel = next((str(candidate) for candidate in candidates if (REPO / candidate).is_file()), None)
        if not rel:
            return {"birthAt": None, "lastChangedAt": None}
        p = subprocess.run(
            ["git", "log", "--follow", "--format=%aI", "--", rel],
            cwd=REPO, text=True, capture_output=True, timeout=10, check=False,
        )
        dates = [iso(x.strip()) for x in p.stdout.splitlines() if x.strip()]
        return {"birthAt": dates[-1] if dates else None, "lastChangedAt": dates[0] if dates else None}
    except Exception:
        return {"birthAt": None, "lastChangedAt": None}


def fresh_metric():
    return {
        "calls": 0, "results": 0, "errors": 0,
        "interactiveCalls": 0, "interactiveResults": 0, "interactiveErrors": 0,
        "testCalls": 0, "sessions": set(), "interactiveSessions": set(), "testSessions": set(),
        "firstCallAt": None, "lastCallAt": None,
        "operations": collections.Counter(), "errorCategories": collections.Counter(),
        "interactiveCallsByDay": collections.Counter(), "interactiveErrorsByDay": collections.Counter(),
    }


def fresh_ext(ext):
    history = git_history(ext["name"])
    return {
        "name": ext["name"], "scope": ext["scope"],
        **history, "tools": list(ext.get("tools", [])),
        "commands": list(ext.get("commands", [])), "events": list(ext.get("events", [])),
        "toolCalls": 0, "toolErrors": 0, "interactiveToolCalls": 0, "interactiveToolErrors": 0,
        "testToolCalls": 0, "toolSessions": set(), "interactiveToolSessions": set(),
        "commandInvocationsObserved": 0, "interactiveCommandInvocationsObserved": 0,
        "commandSessions": set(), "interactiveCommandSessions": set(), "automaticEvidence": 0, "automaticInteractiveEvidence": 0,
        "automaticSessions": set(), "automaticInteractiveSessions": set(),
        "eligibleInteractiveSessionsSinceBirth": 0,
    }


registry = json.loads(REGISTRY.read_text())
extensions = {e["name"]: fresh_ext(e) for e in registry["extensions"]}
tool_owner = {tool: e["name"] for e in registry["extensions"] for tool in e.get("tools", [])}
command_owner = {cmd: e["name"] for e in registry["extensions"] for cmd in e.get("commands", [])}
tool_metrics = {tool: fresh_metric() for tool in tool_owner}
command_counts = collections.Counter()
custom_types = collections.Counter()
custom_type_sessions = collections.defaultdict(set)
custom_types_interactive = collections.Counter()
custom_type_interactive_sessions = collections.defaultdict(set)

# Session-record types produced by automatic extension behavior.
auto_owner = {
    "code-context.ledger": "code-context",
    "debug-ledger": "debug-ledger",
    "experiment-ledger": "experiment-ledger",
    "obsidian-awareness": "obsidian",
    "repo-context": "repo-context",
    "run-deck": "run-deck",
    "cognitive-automation": "reasoning-runtime",
    "auto-router.state": "reasoning-runtime",
    "auto-router.decision": "reasoning-runtime",
    "auto-router.result": "reasoning-runtime",
    "role-run": "reasoning-runtime",
    "subagent.result": "reasoning-runtime",
}

session_rows = []
replacement_shell = collections.Counter()
all_tool_calls = collections.Counter()
all_tool_errors = collections.Counter()
invalid_rows = 0
oversized_rows = 0
bytes_total = 0

all_files = sorted(ROOT.rglob("*.jsonl"))
excluded_files = [file for file in all_files if session_file_id(file) in EXCLUDED_SESSION_IDS]
matched_excluded_ids = {session_file_id(file) for file in excluded_files}
all_exclusions_matched = bool(EXCLUDED_SESSION_IDS) and EXCLUDED_SESSION_IDS.issubset(matched_excluded_ids)
files = [file for file in all_files if session_file_id(file) not in EXCLUDED_SESSION_IDS]
for file in files:
    stat = file.stat()
    bytes_total += stat.st_size
    sid = file.stem.split("_", 1)[-1]
    cwd = ""
    started = None
    latest = None
    cohort_rows = 0
    user_turns = assistant_turns = user_chars = 0
    tool_calls_total = 0
    session_custom_calls = collections.Counter()
    session_custom_results = collections.Counter()
    session_custom_errors = collections.Counter()
    session_custom_ops = collections.defaultdict(collections.Counter)
    session_custom_call_days = collections.defaultdict(collections.Counter)
    session_custom_error_days = collections.defaultdict(collections.Counter)
    session_error_cats = collections.defaultdict(collections.Counter)
    session_custom_types = collections.Counter()
    session_commands = collections.Counter()
    call_names = {}
    result_ids = set()
    smoke_prompt = True
    prompt_seen = False
    shell_hits = collections.Counter()

    try:
        fh = file.open("r", encoding="utf-8", errors="replace")
    except Exception:
        continue
    with fh:
        for raw in fh:
            if len(raw) > 16 * 1024 * 1024:
                oversized_rows += 1
                continue
            try:
                row = json.loads(raw)
            except Exception:
                invalid_rows += 1
                continue
            if row.get("type") == "session":
                sid = str(row.get("id") or sid)
                cwd = str(row.get("cwd") or "")
            at = iso(row.get("timestamp"))
            if SINCE_AT and (not at or at < SINCE_AT):
                continue
            cohort_rows += 1
            if at:
                latest = at if not latest or at > latest else latest
                started = at if not started or at < started else started
            if row.get("type") in {"custom", "custom_message"}:
                ctype = str(row.get("customType") or "")
                if ctype:
                    custom_types[ctype] += 1
                    custom_type_sessions[ctype].add(sid)
                    session_custom_types[ctype] += 1
            if row.get("type") != "message" or not isinstance(row.get("message"), dict):
                continue
            msg = row["message"]
            role = msg.get("role")
            if role == "user":
                user_turns += 1
                txt = text_content(msg.get("content"))
                user_chars += len(txt)
                if txt.strip():
                    prompt_seen = True
                    normalized = re.sub(r"\s+", " ", txt.strip().lower())
                    if not re.fullmatch(r"(?:say|reply|respond|print)(?: only| exactly)?[ :]+[\"']?[a-z0-9 _.-]{1,40}[\"']?\.?", normalized):
                        smoke_prompt = False
                    for match in re.finditer(r"(?m)^\s*/([A-Za-z0-9:_-]+)\b", txt):
                        cmd = match.group(1)
                        if cmd in command_owner:
                            session_commands[cmd] += 1
            elif role == "assistant":
                assistant_turns += 1
                for part in msg.get("content") if isinstance(msg.get("content"), list) else []:
                    if not isinstance(part, dict) or part.get("type") != "toolCall":
                        continue
                    name = str(part.get("name") or "")
                    call_id = str(part.get("id") or "")
                    if call_id:
                        call_names[call_id] = name
                    tool_calls_total += 1
                    all_tool_calls[name] += 1
                    if name in tool_owner:
                        session_custom_calls[name] += 1
                        session_custom_call_days[name][(at or started or "unknown")[:10]] += 1
                        args = part.get("arguments") if isinstance(part.get("arguments"), dict) else {}
                        op = args.get("operation") or args.get("profile") or args.get("action")
                        if isinstance(op, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", op):
                            session_custom_ops[name][op] += 1
                    if name == "bash":
                        args = part.get("arguments") if isinstance(part.get("arguments"), dict) else {}
                        command = str(args.get("command") or "")[:200000]
                        patterns = {
                            "repo_context:git-status-log": r"\bgit\s+(?:status|log)\b",
                            "gitevidence:git-diff": r"\bgit\s+diff\b",
                            "commit_plan:git-add-commit": r"\bgit\s+(?:add|commit)\b",
                            "build_project:direct-build": r"\b(?:cmake\s+--build|make(?:\s|$)|ninja(?:\s|$)|(?:npm|pnpm|yarn)\s+(?:run\s+)?build)\b",
                            "test_runner:direct-test": r"\b(?:pytest|ctest|(?:npm|pnpm|yarn)\s+(?:run\s+)?test|node\s+--test)\b",
                            "run_deck:polling-ritual": r"\b(?:tail|pgrep|nvidia-smi|sleep)\b",
                        }
                        for key, pat in patterns.items():
                            shell_hits[key] += len(re.findall(pat, command, re.I))
            elif role == "toolResult":
                result_id = str(msg.get("toolCallId") or "")
                if result_id and result_id in result_ids:
                    continue
                if result_id:
                    result_ids.add(result_id)
                name = str(msg.get("toolName") or call_names.get(result_id, ""))
                if name in tool_owner:
                    session_custom_results[name] += 1
                    if msg.get("isError") is True:
                        session_custom_errors[name] += 1
                        all_tool_errors[name] += 1
                        session_custom_error_days[name][(at or latest or started or "unknown")[:10]] += 1
                        session_error_cats[name][error_category(msg.get("content"))] += 1

    if SINCE_AT and cohort_rows == 0:
        continue
    is_temp = cwd.startswith("/tmp/") or "/--tmp-" in str(file)
    is_trivial = tool_calls_total == 0 and user_chars <= 80 and assistant_turns <= 2
    is_test = is_temp or (prompt_seen and smoke_prompt) or is_trivial
    is_interactive = user_turns > 0 and assistant_turns > 0 and not is_test
    classification = "interactive" if is_interactive else ("test-or-smoke" if is_test else "other")

    session_rows.append({
        "id": sid, "startedAt": started, "latestAt": latest,
        "classification": classification, "userTurns": user_turns,
        "assistantTurns": assistant_turns, "toolCalls": tool_calls_total,
        "customToolCalls": sum(session_custom_calls.values()), "bytes": stat.st_size,
    })

    if is_interactive:
        replacement_shell.update(shell_hits)
        for ctype, count in session_custom_types.items():
            custom_types_interactive[ctype] += count
            custom_type_interactive_sessions[ctype].add(sid)
    for ctype, count in session_custom_types.items():
        owner = auto_owner.get(ctype)
        if owner in extensions:
            extensions[owner]["automaticEvidence"] += count
            extensions[owner]["automaticSessions"].add(sid)
            if is_interactive:
                extensions[owner]["automaticInteractiveEvidence"] += count
                extensions[owner]["automaticInteractiveSessions"].add(sid)
    for cmd, count in session_commands.items():
        command_counts[cmd] += count
        owner = command_owner[cmd]
        ext = extensions[owner]
        ext["commandInvocationsObserved"] += count
        ext["commandSessions"].add(sid)
        if is_interactive:
            ext["interactiveCommandInvocationsObserved"] += count
            ext["interactiveCommandSessions"].add(sid)
    for name, count in session_custom_calls.items():
        metric = tool_metrics[name]
        ext = extensions[tool_owner[name]]
        metric["calls"] += count
        metric["results"] += session_custom_results[name]
        metric["errors"] += session_custom_errors[name]
        metric["sessions"].add(sid)
        ext["toolCalls"] += count
        ext["toolErrors"] += session_custom_errors[name]
        ext["toolSessions"].add(sid)
        for op, n in session_custom_ops[name].items():
            metric["operations"][op] += n
        for cat, n in session_error_cats[name].items():
            metric["errorCategories"][cat] += n
        if started:
            metric["firstCallAt"] = started if not metric["firstCallAt"] or started < metric["firstCallAt"] else metric["firstCallAt"]
            metric["lastCallAt"] = latest if not metric["lastCallAt"] or (latest and latest > metric["lastCallAt"]) else metric["lastCallAt"]
        if is_interactive:
            metric["interactiveCalls"] += count
            metric["interactiveResults"] += session_custom_results[name]
            metric["interactiveErrors"] += session_custom_errors[name]
            metric["interactiveSessions"].add(sid)
            metric["interactiveCallsByDay"].update(session_custom_call_days[name])
            metric["interactiveErrorsByDay"].update(session_custom_error_days[name])
            ext["interactiveToolCalls"] += count
            ext["interactiveToolErrors"] += session_custom_errors[name]
            ext["interactiveToolSessions"].add(sid)
        elif is_test:
            metric["testCalls"] += count
            metric["testSessions"].add(sid)
            ext["testToolCalls"] += count

interactive_sessions = [s for s in session_rows if s["classification"] == "interactive"]
for ext in extensions.values():
    birth = ext.get("birthAt")
    ext["eligibleInteractiveSessionsSinceBirth"] = sum(1 for s in interactive_sessions if s.get("startedAt") and (not birth or s["startedAt"] >= birth))


def finalize_metric(name, m):
    calls = m["calls"]
    icalls = m["interactiveCalls"]
    return {
        "name": name, "extension": tool_owner[name],
        "calls": calls, "results": m["results"], "errors": m["errors"],
        "errorRate": round(m["errors"] / calls, 4) if calls else None,
        "interactiveCalls": icalls, "interactiveResults": m["interactiveResults"],
        "interactiveErrors": m["interactiveErrors"],
        "interactiveErrorRate": round(m["interactiveErrors"] / icalls, 4) if icalls else None,
        "testCalls": m["testCalls"], "sessions": len(m["sessions"]),
        "interactiveSessions": len(m["interactiveSessions"]), "testSessions": len(m["testSessions"]),
        "firstCallAt": m["firstCallAt"], "lastCallAt": m["lastCallAt"],
        "operations": dict(m["operations"].most_common()),
        "errorCategories": dict(m["errorCategories"].most_common()),
        "interactiveCallsByDay": dict(sorted(m["interactiveCallsByDay"].items())),
        "interactiveErrorsByDay": dict(sorted(m["interactiveErrorsByDay"].items())),
    }


def finalize_ext(ext):
    eligible = ext["eligibleInteractiveSessionsSinceBirth"]
    calls = ext["interactiveToolCalls"]
    adopted = ext["interactiveToolSessions"] | ext["interactiveCommandSessions"] | ext["automaticInteractiveSessions"]
    interactive_actions = ext["interactiveToolCalls"] + ext["interactiveCommandInvocationsObserved"] + ext["automaticInteractiveEvidence"]
    return {
        **{k: v for k, v in ext.items() if not isinstance(v, set) and k != "file"},
        "toolSessions": len(ext["toolSessions"]),
        "interactiveToolSessions": len(ext["interactiveToolSessions"]),
        "commandSessions": len(ext["commandSessions"]),
        "interactiveCommandSessions": len(ext["interactiveCommandSessions"]),
        "automaticSessions": len(ext["automaticSessions"]),
        "automaticInteractiveSessions": len(ext["automaticInteractiveSessions"]),
        "interactiveAdoptionSessions": len(adopted),
        "interactiveActions": interactive_actions,
        "interactiveToolErrorRate": round(ext["interactiveToolErrors"] / calls, 4) if calls else None,
        "interactiveSessionAdoptionRate": round(len(adopted) / eligible, 4) if eligible else None,
    }

session_class_counts = collections.Counter(s["classification"] for s in session_rows)
interactive_first_at = min((s["startedAt"] for s in interactive_sessions if s["startedAt"]), default=None)
interactive_last_at = max((s["latestAt"] for s in interactive_sessions if s["latestAt"]), default=None)
interactive_observed_days = 0
if interactive_first_at and interactive_last_at:
    interactive_observed_days = round((dt.datetime.fromisoformat(interactive_last_at.replace("Z", "+00:00")) - dt.datetime.fromisoformat(interactive_first_at.replace("Z", "+00:00"))).total_seconds() / 86400, 2)
result = {
    "schemaVersion": AUDIT_SCHEMA_VERSION,
    "classifierVersion": AUDIT_CLASSIFIER_VERSION,
    "sessionKindPolicyVersion": SESSION_KIND_POLICY_VERSION,
    "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
    "cohort": {
        "sinceAt": SINCE_AT,
        "sourceVersion": ARGS.source_version,
        "configVersion": ARGS.config_version,
        "classifierVersion": AUDIT_CLASSIFIER_VERSION,
        "sessionKindPolicyVersion": SESSION_KIND_POLICY_VERSION,
        "currentSessionExcluded": all_exclusions_matched,
        "observedInteractiveDays": interactive_observed_days,
        "eligibleForFourteenDayDecision": bool(SINCE_AT and interactive_observed_days >= 14),
    },
    "privacy": {
        "aggregateOnly": True, "rawTranscriptPersisted": False, "rawArgumentsPersisted": False,
        "rawResultsPersisted": False, "sessionPathsPersisted": False,
        "classificationNote": "Interactive excludes temp-cwd, trivial, and exact short smoke-prompt sessions; it is a heuristic.",
    },
    "inventory": {
        "extensions": len(extensions), "tools": len(tool_owner), "commands": len(command_owner),
        "configuredRoots": [{"scope": row.get("scope"), "exists": bool(row.get("exists"))} for row in registry.get("roots", [])], "conflicts": registry.get("conflicts"),
    },
    "sessions": {
        "discoveredFiles": len(all_files), "scannedFiles": len(files), "analyzedFiles": len(session_rows),
        "requestedActiveAuditSessionCount": len(EXCLUDED_SESSION_IDS),
        "excludedActiveAuditSessionCount": len(excluded_files),
        "unmatchedActiveAuditSessionCount": len(EXCLUDED_SESSION_IDS - matched_excluded_ids),
        "bytes": bytes_total, "invalidRows": invalid_rows,
        "oversizedRows": oversized_rows, "classifications": dict(session_class_counts),
        "interactiveUserTurns": sum(s["userTurns"] for s in session_rows if s["classification"] == "interactive"),
        "interactiveAssistantTurns": sum(s["assistantTurns"] for s in session_rows if s["classification"] == "interactive"),
        "interactiveToolCalls": sum(s["toolCalls"] for s in session_rows if s["classification"] == "interactive"),
        "earliestAt": min((s["startedAt"] for s in session_rows if s["startedAt"]), default=None),
        "latestAt": max((s["latestAt"] for s in session_rows if s["latestAt"]), default=None),
    },
    "extensions": sorted((finalize_ext(e) for e in extensions.values()), key=lambda x: (x["interactiveToolCalls"] + x["interactiveCommandInvocationsObserved"], x["name"])),
    "tools": sorted((finalize_metric(name, m) for name, m in tool_metrics.items()), key=lambda x: (x["interactiveCalls"], x["name"])),
    "observedSlashCommands": dict(command_counts.most_common()),
    "customTypes": [
        {"name": name, "count": count, "sessions": len(custom_type_sessions[name]),
         "interactiveCount": custom_types_interactive[name], "interactiveSessions": len(custom_type_interactive_sessions[name]),
         "mappedExtension": auto_owner.get(name)}
        for name, count in custom_types.most_common()
    ],
    "interactiveShellReplacementSignals": dict(replacement_shell.most_common()),
    "allToolCallsTop": dict(all_tool_calls.most_common(100)),
    "allToolErrors": dict(all_tool_errors.most_common()),
}
OUT.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
try:
    OUT.parent.chmod(0o700)
except OSError:
    pass
OUT.write_text(json.dumps(result, indent=2) + "\n")
try:
    OUT.chmod(0o600)
except OSError:
    pass
print(json.dumps({
    "output": str(OUT), "discoveredFiles": len(all_files), "scannedFiles": len(files), "analyzedFiles": len(session_rows), "bytes": bytes_total,
    "classifications": dict(session_class_counts), "extensions": len(extensions),
    "customTools": len(tool_owner), "invalidRows": invalid_rows,
}, indent=2))
