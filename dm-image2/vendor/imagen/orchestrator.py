#!/usr/bin/env python3
from typing import Optional, Tuple, List, Union
import atexit, errno, json, math, os, re, signal, subprocess, sys, time, shutil, traceback
from itertools import chain
from pathlib import Path

import micro_compact as mc
from apply_patch import apply_patch, format_tool_output
from api_compact import AUTO_COMPACT_TRIGGER_INPUT_TOKENS, compact_via_api, compact_via_api_with_reason
from context_init import (
    build_context_updates,
    ctx_messages_from_env,
    du_ah_summary,
    environment_context_item,
    latest_environment_context_text,
    load_system_prompt,
    load_tool_specs,
    load_view_image_tool_spec,
    ls_la_summary,
    message_has_wrapped_tag,
    parse_xml_tag,
    prune_tag_context_messages,
)
from input_images import (
    generated_image_note_item,
    image_refs_from_env,
    input_image_part,
    save_generated_image,
    sanitize_request_input_items,
    view_image_output_item,
)
from retry_policy import (
    error_code_from_payload as shared_error_code_from_payload,
    error_status_from_payload as shared_error_status_from_payload,
    parse_float as shared_parse_float,
    retry_delay as shared_retry_delay,
    stream_backoff_delay as shared_stream_backoff_delay,
)
from streaming import run_stream
from formatting import _format_shell_output, _truncate_preview_by_lines, format_patch_preview, format_shell_preview, format_thinking, render_markdown, truncate_middle_line, usage_text_from_response

from session import (
    append_history,
    apply_compaction_result,
    init_session,
    latest_assistant_text_from_session,
    prompt_cache_key_for_session,
    release_session_lock,
    rewrite_history,
)

PURPLE = "\033[0;35m"
CYAN = "\033[0;36m"
GRAY = "\033[0;90m"
ITALIC = "\033[3m"
UNDERLINE = "\033[4m"
UNDERLINE_OFF = "\033[24m"
YELLOW = "\033[0;33m"
TAN = "\033[38;5;180m"
RED = "\033[0;31m"

NC = "\033[0m"
LLM_REQUEST_TIMEOUT_SECONDS = 120.0
SHELL_TIMEOUT_DEFAULT_SECONDS = 60.0
SHELL_TIMEOUT_MIN_SECONDS = 1.0
SHELL_TIMEOUT_MAX_SECONDS = 900.0
SHELL_PLANNING_TEXT_MAX_CHARS = 99
REQUIRED_TOOLS = ("rg",)
RECOMMENDED_TOOLS = ("tilth", "chrome-devtools")
SUPPORTED_MODELS = ("gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.5")
IMAGE_INPUT_MODELS = ("gpt-5.5",)
IMG_ENV_VAR = "img"
LEGACY_IMAGE_ENV_VARS = ("images",)
IMAGE_DETAIL_ORIGINAL = "original"
IMAGE_GENERATION_OUTPUT_FORMAT = "png"
CTX_ENV_VAR = "ctx"
VIEW_IMAGE_TOOL_NAME = "view_image"

FLOWS_SYSTEM_REMINDER = (
    "Do not re-read FLOWS.md during normal execution when <FLOWS> context is already injected. "
    "Re-read FLOWS.md only immediately before updating FLOWS.md at session end, or when the user explicitly asks about FLOWS.md."
    'Then treat its "Note for agents" block as mandatory policy.'
)

def load_auth(auth_file: Path) -> tuple[str, str]:
    try: data = json.loads(auth_file.read_text(encoding="utf-8", errors="replace"))
    except Exception as exc: raise SystemExit(f"Failed to read auth file {auth_file}: {exc}")

    access_token = data.get("tokens").get("access_token")
    if not access_token: raise SystemExit(f"Auth file missing access_token: {auth_file}")

    account_id = data.get("tokens").get("account_id")
    if not account_id: raise SystemExit(f"Auth file missing account_id: {auth_file}")
    return access_token, account_id

def to_plain_dict(obj): return obj if isinstance(obj, dict) else (obj.model_dump() if hasattr(obj, "model_dump") else (obj.dict() if hasattr(obj, "dict") else obj))

def env_flag(name: str, default: str = "0") -> bool:
    value = os.environ.get(name, default)
    if value is None: return False
    return str(value).strip().lower() in ("1", "true", "yes", "y", "on")

def env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None: return int(default)
    try: return int(str(value).strip())
    except Exception: return int(default)


def reject_legacy_image_env_vars() -> None:
    legacy_keys = [name for name in LEGACY_IMAGE_ENV_VARS if str(os.environ.get(name) or "").strip()]
    if legacy_keys:
        joined = ", ".join(f"{name}=" for name in legacy_keys)
        raise SystemExit(f"{joined} no longer works. Use {IMG_ENV_VAR}= instead.")

def reasoning_summary_supported(model: str) -> bool:
    return model != "gpt-5.3-codex-spark"


def model_supports_original_image_input(model: str) -> bool:
    return model in IMAGE_INPUT_MODELS


def _request_input_items(history: list, allow_image_input: bool) -> list:
    return sanitize_request_input_items(history, allow_image_input)


def _request_tools(shell_tool: dict, apply_patch_tool: dict, view_image_tool: dict, allow_image_input: bool) -> list[dict]:
    tools = [shell_tool, apply_patch_tool]
    if allow_image_input:
        tools.append(view_image_tool)
        tools.append({"type": "image_generation", "output_format": IMAGE_GENERATION_OUTPUT_FORMAT})
    tools.append({"type": "web_search"})
    return tools


def json_loads(text: str, default=None):
    if not isinstance(text, str): return default
    try: return json.loads(text)
    except Exception: return default

def _jsonable(value):
    try:
        json.dumps(value, ensure_ascii=False)
        return value
    except Exception:
        return str(value)

def _append_jsonl_silent(path: Path, item: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
    except Exception:
        pass

def _truncate_text(text: str, limit: int = 1200) -> str:
    if not isinstance(text, str): text = str(text)
    if len(text) <= limit: return text
    return f"{text[:limit]}…<{len(text) - limit} chars truncated>"

def _brief_history_item(item) -> Union[dict, str]:
    if not isinstance(item, dict): return _truncate_text(item)
    typ = item.get("type")
    out = {"type": typ}
    for key in ("role", "call_id", "name"):
        if key in item and item.get(key) is not None: out[key] = item.get(key)
    if typ == "message":
        # Keep just the first text segment (if any).
        content = item.get("content") or []
        if isinstance(content, list):
            for part in content:
                if not isinstance(part, dict): continue
                if part.get("type") in ("input_text", "output_text") and isinstance((text := part.get("text")), str) and text:
                    out["text"] = _truncate_text(text, 800)
                    break
    elif typ in ("function_call", "custom_tool_call"):
        for key in ("arguments", "input"):
            val = item.get(key)
            if isinstance(val, str) and val.strip(): out[key] = _truncate_text(val, 800)
    else:
        val = item.get("output")
        if isinstance(val, str) and val.strip(): out["output"] = _truncate_text(val, 800)
    return out

def request_debug_snapshot(request: dict, keep_input_items: int = 3) -> dict:
    if not isinstance(request, dict): return {"request": _truncate_text(request)}
    snap: dict = {}
    for key in ("model", "tool_choice", "prompt_cache_key", "parallel_tool_calls"):
        if key in request: snap[key] = request.get(key)
    if isinstance((reasoning := request.get("reasoning")), dict):
        snap["reasoning"] = {k: reasoning.get(k) for k in ("effort", "summary") if k in reasoning}
    input_items = request.get("input")
    if isinstance(input_items, list):
        snap["input_count"] = len(input_items)
        tail = input_items[-max(0, int(keep_input_items)) :] if keep_input_items else []
        snap["input_tail"] = [_brief_history_item(it) for it in tail]
    return snap

def payload_debug_snapshot(payload) -> Union[dict, str]:
    if not isinstance(payload, dict): return _truncate_text(payload)
    out: dict = {}
    if "_stream_debug" in payload: out["_stream_debug"] = payload.get("_stream_debug")
    if "error" in payload: out["error"] = payload.get("error")
    resp = payload.get("response")
    if isinstance(resp, dict):
        out["response"] = {
            k: resp.get(k)
            for k in ("id", "status", "incomplete_details", "error")
            if k in resp and resp.get(k) is not None
        }
    if payload.get("incomplete") is True: out["incomplete"] = True
    if "incomplete_details" in payload: out["incomplete_details"] = payload.get("incomplete_details")
    return out

def install_fast_sigint() -> None:
    def _handle_sigint(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGINT, _handle_sigint)
    if hasattr(signal, "siginterrupt"):
        signal.siginterrupt(signal.SIGINT, True)


def normalize_shell_planning_args(args: dict) -> dict:
    if not isinstance(args, dict): return {}
    normalized = dict(args)
    intent = shell_intent_from_args(normalized)
    expect = shell_expect_from_args(normalized)
    normalized.pop("approach", None)
    normalized.pop("plan", None)
    normalized.pop("expected_output", None)
    normalized.pop("expected", None)
    if intent: normalized["intent"] = intent
    else: normalized.pop("intent", None)
    if expect: normalized["expect"] = expect
    else: normalized.pop("expect", None)
    return normalized

def normalize_output_items(items) -> list:
    output_items = []
    for item in (items or []):
        if not isinstance((data := to_plain_dict(item)), dict): continue
        if data.get("type") == "web_search_call_output": continue
        if data.get("type") in ("function_call", "custom_tool_call"):
            if not isinstance((data := normalize_tool_call_item(data)), dict): continue
        if data.get("type") == "function_call" and data.get("name") == "shell":
            raw_args = data.get("arguments")
            parsed_args = raw_args if isinstance(raw_args, dict) else json_loads(raw_args, None)
            if isinstance(parsed_args, dict):
                data = dict(data)
                data["arguments"] = json.dumps(
                    normalize_shell_planning_args(parsed_args),
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
        output_items.append(data)
    return output_items


def try_auto_compact_on_context_error(
    history_snapshot: list,
    session_dir: Path,
    compact_mode: str,
    system_prompt: str,
    model: str,
    token: str,
    account_id: str,
    base_url: str,
    timeout: float,
    on_stage_start=None,
    on_stage_trigger=None,
) -> Tuple[bool, list, Optional[Tuple[List[str], List[str]]]]:
    if compact_mode not in ("", "micro", "auto"):
        raise ValueError(f"Invalid compact mode: {compact_mode}. Allowed: micro, auto")
    if not isinstance(history_snapshot, list):
        return False, history_snapshot, None

    use_micro = compact_mode in ("", "micro")
    use_auto = compact_mode in ("", "auto")

    if use_micro:
        if on_stage_start: on_stage_start("micro")
        changed, compacted, compact_output_ids, compact_input_ids = mc.try_micro_compact(history_snapshot, session_dir)
        if changed:
            if on_stage_trigger: on_stage_trigger("micro")
            return True, compacted, (compact_output_ids, compact_input_ids)
        if compact_mode == "micro":
            return False, history_snapshot, None

    if use_auto:
        if on_stage_start: on_stage_start("auto")
        compacted = compact_via_api(
            history_snapshot,
            system_prompt,
            model,
            token,
            account_id,
            base_url,
            timeout,
            preserve_first_user_prompt=True,
            allow_image_inputs=model_supports_original_image_input(model),
        )
        if isinstance(compacted, list) and len(compacted) > 0 and len(compacted) < len(history_snapshot):
            if on_stage_trigger: on_stage_trigger("auto")
            return True, compacted, None

    return False, history_snapshot, None

def extract_output_text(response: dict) -> str:
    return "\n".join(
        part["text"]
        for item in (response.get("output") or [])
        if isinstance(item, dict) and item.get("type") == "message" and item.get("role") == "assistant"
        for part in (item.get("content") or [])
        if isinstance(part, dict)
        and part.get("type") == "output_text"
        and isinstance(part.get("text"), str)
        and part.get("text")
    ).strip()

def error_code_from_payload(payload) -> Optional[str]:
    return shared_error_code_from_payload(payload)

def error_status_from_payload(payload) -> Optional[int]:
    return shared_error_status_from_payload(payload)

def retry_error_info(payload) -> str:
    status = error_status_from_payload(payload)
    code = error_code_from_payload(payload)
    if isinstance(code, str): code = code.strip()
    else: code = ""
    if status and code: return f" [{status}] {code}"
    if status: return f" [{status}]"
    if code: return f" [{code}]"
    return ""


def stream_has_valid_response(payload) -> bool:
    dbg = payload.get("_stream_debug") if isinstance(payload, dict) else None
    if not isinstance(dbg, dict):
        return False
    try:
        return int(dbg.get("valid_event_count") or 0) > 0
    except Exception:
        return False

def pre_compact_skip_reason(reason: Optional[str], before_len: int, compacted) -> str:
    if isinstance(reason, str) and reason.strip() and reason != "ok": return reason.strip()
    if isinstance(compacted, list):
        after_len = len(compacted)
        if after_len >= before_len: return f"no_reduction (history={before_len}, compacted={after_len})"
        return f"unexpected_result (history={before_len}, compacted={after_len})"
    return "compact_failed"

def response_input_tokens(response: dict) -> Optional[int]:
    if not isinstance(response, dict): return None
    usage = response.get("usage")
    if not isinstance(usage, dict): return None
    try: value = int(usage.get("input_tokens"))
    except Exception: return None
    return value if value >= 0 else None


def estimated_input_tokens(items: list) -> Optional[int]:
    if not isinstance(items, list): return None
    try: value = int(mc.estimate_history_usage_tokens(items))
    except Exception: return None
    return value if value >= 0 else None

def stream_terminal_event_from_payload(payload) -> Optional[str]:
    if not isinstance(payload, dict): return None
    dbg = payload.get("_stream_debug")
    if not isinstance(dbg, dict): return None
    extra = dbg.get("extra")
    if not isinstance(extra, dict): return None
    event = extra.get("terminal_event")
    return event if isinstance(event, str) and event else None


def stream_duplicate_output_item_ids_from_payload(payload) -> list[str]:
    if not isinstance(payload, dict): return []
    dbg = payload.get("_stream_debug")
    if not isinstance(dbg, dict): return []
    extra = dbg.get("extra")
    if not isinstance(extra, dict): return []
    ids = extra.get("duplicate_output_item_ids")
    if not isinstance(ids, list): return []
    out = []
    for item_id in ids:
        if not isinstance(item_id, str) or not item_id.strip() or item_id in out: continue
        out.append(item_id)
    return out

def terminal_failure_classification(payload) -> dict:
    code = error_code_from_payload(payload)
    status = error_status_from_payload(payload)
    terminal_event = stream_terminal_event_from_payload(payload)
    try: parse_error_count = int((((payload.get("_stream_debug") if isinstance(payload, dict) else None) or {}).get("parse_error_count")) or 0)
    except Exception: parse_error_count = 0
    kind = next((label for cond, label in (
        (code == "invalid_prompt", "policy_rejection"),
        (code == "context_length_exceeded", "context_length_exceeded"),
        (code in {"token_invalidated", "token_revoked", "token_expired", "authentication_error"} or status == 401, "auth_error"),
        (code == "usage_limit_reached", "usage_limit_reached"),
        (code in {"transport_error", "timeout", "request_timeout"}, "transport_error"),
        (parse_error_count > 0, "stream_parse_error"),
        (terminal_event in {"stream_end", "exception", "http_error", "transport_error"}, f"stream_{terminal_event}"),
        (status == 429, "rate_limited"),
        (isinstance(status, int) and status >= 500, "server_error"),
    ) if cond), "terminal_stream_failure")
    return {
        "kind": kind,
        "code": code,
        "status": status,
        "terminal_event": terminal_event,
        "parse_error_count": parse_error_count,
    }

def stream_backoff_delay(attempt: int, base_seconds: float, max_seconds: Optional[float] = None, jitter_ratio: float = 0.1) -> float:
    return shared_stream_backoff_delay(attempt, base_seconds, max_seconds=max_seconds, jitter_ratio=jitter_ratio)

def _parse_float(value) -> Optional[float]:
    return shared_parse_float(value)

def normalize_shell_timeout(
    value,
    default: float = SHELL_TIMEOUT_DEFAULT_SECONDS,
    min_seconds: float = SHELL_TIMEOUT_MIN_SECONDS,
    max_seconds: float = SHELL_TIMEOUT_MAX_SECONDS,
) -> float:
    if (timeout := _parse_float(value)) is None or timeout <= 0:
        timeout = float(default)
    if not math.isfinite(timeout):
        timeout = float(default)
    if timeout < min_seconds:
        timeout = float(min_seconds)
    if timeout > max_seconds:
        timeout = float(max_seconds)
    return float(timeout)

def env_float(name: str, default: str) -> float:
    return value if (value := _parse_float(os.environ.get(name))) is not None else float(default)

def retry_delay(payload, attempt: int, base_seconds: float, rate_limit_base: float, max_seconds: Optional[float] = None) -> Optional[float]:
    return shared_retry_delay(payload, attempt, base_seconds, rate_limit_base, max_seconds=max_seconds)

def _nonempty_string(value) -> Optional[str]:
    if not isinstance(value, str): return None
    value = value.strip()
    return value or None


def normalize_tool_call_item(item: dict) -> Optional[dict]:
    if not isinstance(item, dict): return None
    if (typ := item.get("type")) not in ("function_call", "custom_tool_call"): return None
    if not (name := _nonempty_string(item.get("name"))): return None
    call_id = _nonempty_string(item.get("call_id"))
    if not call_id:
        call_id = _nonempty_string(item.get("id"))
    if not call_id: return None
    data = dict(item)
    data["name"] = name
    data["call_id"] = call_id
    return data


def iter_tool_calls(response: dict):
    for item in (response.get("output") or []):
        if not isinstance((data := to_plain_dict(item)), dict): continue
        if not isinstance((data := normalize_tool_call_item(data)), dict): continue
        yield {
            "id": data.get("call_id"),
            "name": data.get("name"),
            "input": data.get("input", ""),
            "arguments": data.get("arguments", ""),
            "tool_type": data.get("type"),
        }

def _merge_tool_call(existing: dict, incoming: dict) -> dict:
    if not isinstance(existing, dict): return incoming
    if not isinstance(incoming, dict): return existing
    merged = dict(existing)
    for key in ("id", "call_id", "name", "tool_type"):
        if not merged.get(key) and incoming.get(key): merged[key] = incoming.get(key)
    for field in ("input", "arguments"):
        if field not in incoming: continue
        current = merged.get(field)
        candidate = incoming.get(field)
        if isinstance(candidate, str):
            if not isinstance(current, str) or len(candidate) > len(current): merged[field] = candidate
        elif current is None and candidate is not None:
            merged[field] = candidate
    for key, value in incoming.items():
        if key not in merged: merged[key] = value
    return merged

def merge_tool_calls(calls):
    merged = {}
    for call in calls:
        if not isinstance(call, dict): continue
        key = call.get("id") or call.get("call_id") or id(call)
        if key in merged:
            merged[key] = _merge_tool_call(merged[key], call)
        else:
            merged[key] = dict(call)
    return list(merged.values())

def resolve_workdir(raw: Optional[str], default: Optional[Path] = None) -> Path:
    if not raw: return default or Path.cwd()
    path = Path(raw).expanduser()
    return path if path.is_absolute() else (default or Path.cwd()) / path


def _coerce_process_text(value) -> str:
    if value is None: return ""
    if isinstance(value, str): return value
    if isinstance(value, (bytes, bytearray, memoryview)): return bytes(value).decode("utf-8", errors="replace")
    return str(value)

def _terminate_process_group(proc: subprocess.Popen, grace_seconds: float = 0.2) -> None:
    if proc.poll() is not None: return
    if os.name == "posix":
        try: os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError: return
        try: proc.wait(timeout=grace_seconds)
        except subprocess.TimeoutExpired:
            try: os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError: return
            try: proc.wait(timeout=grace_seconds)
            except subprocess.TimeoutExpired: pass
    else:
        try: proc.kill()
        except Exception: pass

def run_shell(script: str, workdir: Path, timeout_seconds: float) -> str:
    if not script: return _format_shell_output(1, 0.0, False, "Error: empty command", workdir)
    if workdir is None: return _format_shell_output(2, 0.0, False, "Error: missing workdir", workdir)
    if not workdir.exists(): return _format_shell_output(2, 0.0, False, f"Error: workdir does not exist: {workdir}", workdir)
    if not workdir.is_dir(): return _format_shell_output(2, 0.0, False, f"Error: workdir is not a directory: {workdir}", workdir)
    start = time.monotonic()
    try:
        proc = subprocess.Popen(
            ["bash", "-c", script],
            cwd=str(workdir),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            # Merge stderr into stdout so captured output keeps write-time order.
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            start_new_session=True,
        )
        try:
            stdout, stderr = proc.communicate(timeout=timeout_seconds)
            code = proc.returncode
            out = _coerce_process_text(stdout) + _coerce_process_text(stderr)
            return _format_shell_output(code, time.monotonic() - start, False, out, workdir)
        except subprocess.TimeoutExpired as exc:
            partial = _coerce_process_text(exc.stdout) + _coerce_process_text(exc.stderr)
            _terminate_process_group(proc)
            try: stdout, stderr = proc.communicate(timeout=0.5)
            except subprocess.TimeoutExpired: stdout, stderr = "", ""
            out = partial + _coerce_process_text(stdout) + _coerce_process_text(stderr)
            return _format_shell_output(124, time.monotonic() - start, True, out, workdir)
    except FileNotFoundError as exc: return _format_shell_output(127, time.monotonic() - start, False, f"Command not found: {exc}", workdir)
    except Exception as exc: return _format_shell_output(-1, time.monotonic() - start, False, f"Error: {exc}", workdir)

def shell_script_from_args(args: dict) -> str:
    if not isinstance(args, dict): return ""
    if "script" in args:
        script = args.get("script")
        if isinstance(script, str) and script: return script
        if script is not None:
            script = str(script)
            if script: return script
    # Backward compatibility for old history/tool outputs that still use "command".
    command = args.get("command")
    if isinstance(command, str): return command
    if command is None: return ""
    return str(command)


def _shell_text_field(args: dict, keys: tuple[str, ...], max_chars: Optional[int] = None) -> str:
    if not isinstance(args, dict): return ""
    for key in keys:
        if key not in args: continue
        value = args.get(key)
        if isinstance(value, str):
            if text := value.strip():
                if max_chars is not None and max_chars >= 0: return text[:max_chars]
                return text
            continue
        if value is None: continue
        if text := str(value).strip():
            if max_chars is not None and max_chars >= 0: return text[:max_chars]
            return text
    return ""


def shell_intent_from_args(args: dict) -> str:
    return _shell_text_field(args, ("intent",), max_chars=SHELL_PLANNING_TEXT_MAX_CHARS)


def shell_expect_from_args(args: dict) -> str:
    return _shell_text_field(args, ("expect",), max_chars=SHELL_PLANNING_TEXT_MAX_CHARS)

def run_apply_patch(patch_input: str, workdir: Path) -> str:
    start = time.monotonic()
    output, exit_code = apply_patch(patch_input, workdir)
    return format_tool_output(output, exit_code, time.monotonic() - start)

def main(argv=None) -> int:
    argv = list(argv) if argv is not None else sys.argv[1:]
    install_fast_sigint()
    script_dir = Path(__file__).resolve().parent
    auth_file = Path(os.environ.get("auth_file") or "~/.codex/auth.json").expanduser().resolve()
    model = os.environ.get("model") or "gpt-5.5"
    if model not in SUPPORTED_MODELS:
        raise SystemExit(f"Invalid model: {model}. Allowed: {', '.join(SUPPORTED_MODELS)}")
    allow_image_input = model_supports_original_image_input(model)
    base_url = "https://chatgpt.com/backend-api/codex"
    quiet_mode = env_flag("quiet")
    debug_level = env_int("debug", 0)
    if quiet_mode: debug_level = 0
    llm_timeout = LLM_REQUEST_TIMEOUT_SECONDS
    shell_timeout = normalize_shell_timeout(
        os.environ.get("timeout"),
        default=SHELL_TIMEOUT_DEFAULT_SECONDS,
        max_seconds=SHELL_TIMEOUT_MAX_SECONDS,
    )
    reject_legacy_image_env_vars()
    stream_max_retries = int(os.environ.get("stream_max_retries", "9") or "9")
    stream_retry_delay = env_float("stream_retry_delay", "0.2")
    stream_retry_delay_rate_limit = env_float("stream_retry_delay_rate_limit", "1.0")
    stream_retry_max_delay = env_float("stream_retry_max_delay", "30")
    if stream_retry_delay_rate_limit <= 0: stream_retry_delay_rate_limit = stream_retry_delay
    if stream_retry_max_delay <= 0: stream_retry_max_delay = None
    prompt = (" ".join(argv) if argv else (sys.stdin.read() if not sys.stdin.isatty() else "")).strip()
    if not prompt:
        if (last_assistant := latest_assistant_text_from_session(Path.cwd() / ".m" / "session.jsonl")):
            if quiet_mode: sys.stdout.write(f"{last_assistant}\n")
            else: sys.stdout.write(f"{PURPLE}[assist]{NC}\n{render_markdown(last_assistant)}\n")
            sys.stdout.flush()
            return 0
        return print('No prompt provided. Usage: ./m.py "your prompt"', file=sys.stderr) or 1

    reasoning_effort = os.environ.get("effort") or "high"
    if re.search(r"\b(review|promax)\b", prompt, flags=re.IGNORECASE): reasoning_effort = "xhigh"
    if reasoning_effort not in ("low", "medium", "high", "xhigh"):
        raise SystemExit(f"Invalid effort: {reasoning_effort}. Allowed: low, medium, high, xhigh")
    reasoning_summary = "detailed"
    priority_tier_requested = str(os.environ.get("priority") or "").strip() == "1"
    new_mode = str(os.environ.get("n") or "0").strip()
    if new_mode not in ("0", "1", "2", "3", "4"): raise SystemExit(f"Invalid n: {new_mode}. Allowed: 0, 1, 2, 3, 4")
    ctx_env_value = _nonempty_string(os.environ.get(CTX_ENV_VAR))
    img_env_value = _nonempty_string(os.environ.get(IMG_ENV_VAR))

    token, account_id = load_auth(auth_file)
    if not quiet_mode:
        print(f"{GRAY}Auth: {auth_file.name}{NC}")
        print(f"{GRAY}Model: {model} | {reasoning_effort} | {'priority' if priority_tier_requested else 'default'}{NC}")
        if ctx_env_value:
            print(f"{GRAY}Ctx: {truncate_middle_line(ctx_env_value, 120)}{NC}")
        if img_env_value:
            print(f"{GRAY}Img: {truncate_middle_line(img_env_value, 120)}{NC}")
        if debug_level > 0: print(f"{GRAY}[debug] base_url={base_url}{NC}", file=sys.stderr)

    marker = Path.cwd() / ".m" / ".tools_checked"
    # Version the marker so new tool checks are not hidden by an old sentinel file.
    marker_expected = (
        "v2\n"
        f"required:{','.join(REQUIRED_TOOLS)}\n"
        f"recommended:{','.join(RECOMMENDED_TOOLS)}\n"
    )
    try:
        marker_seen = marker.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        marker_seen = ""
    if marker_seen != marker_expected:
        missing = [t for t in REQUIRED_TOOLS if shutil.which(t) is None]
        if missing:
            print(f"{YELLOW}WARN missing tools: {', '.join(missing)}. Run: ./setup.sh{NC}", file=sys.stderr)
        missing_recommended = [t for t in RECOMMENDED_TOOLS if shutil.which(t) is None]
        if missing_recommended:
            print(
                f"{YELLOW}WARN missing recommended tools: {', '.join(missing_recommended)}. "
                f"Run: ./setup.sh{NC}",
                file=sys.stderr,
            )
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(marker_expected, encoding="utf-8")

    compact_mode = os.environ.get("compact") or ""
    pre_compact = new_mode == "3"
    if compact_mode not in ("", "micro", "auto"): raise SystemExit(f"Invalid compact: {compact_mode}. Allowed: micro, auto")
    session_opt = os.environ.get("session") or ""
    session_file, history = init_session(new_mode, session_opt, Path.cwd())

    log_dir = Path.cwd() / ".m"
    errors_log_path = log_dir / "errors.jsonl"
    warns_log_path = log_dir / "warns.jsonl"
    crashes_log_path = log_dir / "crashes.jsonl"

    def _append_log(path: Path, item: dict) -> None:
        _append_jsonl_silent(path, item)

    def log_warn(message: str, **extra) -> None:
        event = {"ts": time.time(), "message": message}
        if extra: event["extra"] = _jsonable(extra)
        _append_log(warns_log_path, event)

    def log_error(payload, **extra) -> None:
        event = {"ts": time.time(), "payload": _jsonable(payload)}
        if extra: event["extra"] = _jsonable(extra)
        _append_log(errors_log_path, event)

    def log_crash(message: str, **extra) -> None:
        event = {"ts": time.time(), "pid": os.getpid(), "message": message}
        if extra: event["extra"] = _jsonable(extra)
        _append_log(crashes_log_path, event)

    system_prompt = f"{load_system_prompt(script_dir).rstrip()}\n\n{FLOWS_SYSTEM_REMINDER}".strip()
    if pre_compact:
        log_warn("pre-compact running (session overwrite)")
        if not quiet_mode:
            print(f"{YELLOW}WARN pre-compact running (session overwrite){NC}", file=sys.stderr)
            sys.stderr.flush()
        def _emit_pre_compact_trim_retry(removed: int, remaining: int, total_removed: int) -> None:
            log_warn(
                "pre-compact trim+retry (context_length_exceeded)",
                removed=removed,
                remaining=remaining,
                total_removed=total_removed,
            )
            if quiet_mode: return
            print(
                f"{YELLOW}WARN pre-compact trim+retry: removed={removed}, remaining={remaining}, total_removed={total_removed}{NC}",
                file=sys.stderr,
            )
            sys.stderr.flush()

        def _emit_pre_compact_request_retry(retry_no: int, max_retries: int, delay: float, reason: str) -> None:
            log_warn(
                "pre-compact request retry",
                retry=retry_no,
                max_retries=max_retries,
                delay=delay,
                reason=reason,
            )
            if quiet_mode: return
            print(
                f"{YELLOW}WARN pre-compact request retry ({retry_no}/{max_retries}) in {delay:.2f}s: {reason}{NC}",
                file=sys.stderr,
            )
            sys.stderr.flush()
        history_before = len(history) if isinstance(history, list) else 0
        compacted, compact_reason = compact_via_api_with_reason(
            history, system_prompt, model, token, account_id, base_url, llm_timeout,
            keep_last_items=0,
            on_trim_retry=_emit_pre_compact_trim_retry,
            on_request_retry=_emit_pre_compact_request_retry,
            preserve_first_user_prompt=False,
            allow_image_inputs=allow_image_input,
        )
        if isinstance(compacted, list) and len(compacted) > 0 and len(compacted) < len(history):
            history = compacted
            rewrite_history(session_file, history)
            log_warn("pre-compact applied (session overwritten)")
            if not quiet_mode:
                print(f"{YELLOW}WARN pre-compact applied (session overwritten){NC}", file=sys.stderr)
                sys.stderr.flush()
        else:
            reason = pre_compact_skip_reason(compact_reason, history_before, compacted)
            log_warn("pre-compact skipped (session unchanged)", reason=reason)
            if not quiet_mode:
                print(f"{YELLOW}WARN pre-compact skipped (session unchanged): {reason}{NC}", file=sys.stderr)
                sys.stderr.flush()
    if debug_level > 0 and not quiet_mode: print(f"{GRAY}[debug] session_dir={session_file.parent}{NC}", file=sys.stderr)
    request = None
    def _rebuild_environment_context(current_history: list) -> list:
        history = list(current_history)
        cwd_now = Path.cwd().resolve()
        prev_env_text = latest_environment_context_text(history)
        shell_name = parse_xml_tag(prev_env_text, "shell") if prev_env_text else None
        shell_name = shell_name or "bash"
        history, _ = prune_tag_context_messages(history, "environment_context")
        env_item = environment_context_item(
            cwd_now,
            shell_name,
            du_output=du_ah_summary(cwd_now),
            ls_output=ls_la_summary(cwd_now),
        )
        insert_at = 0
        for idx, item in enumerate(history):
            if message_has_wrapped_tag(item, "KEYWORDS") or message_has_wrapped_tag(item, "FLOWS"):
                insert_at = idx + 1
                continue
            break
        else:
            insert_at = len(history)
        history.insert(insert_at, env_item)
        return history

    def _apply_compaction_result(compacted_history: list, compact_ids: Optional[Tuple[List[str], List[str]]]) -> None:
        nonlocal history, request
        history = apply_compaction_result(
            compacted_history=compacted_history,
            session_file=session_file,
            compact_ids=compact_ids,
            rebuild_environment_context=_rebuild_environment_context,
        )
        if isinstance(request, dict):
            request["input"] = _request_input_items(history, allow_image_input)

    def _request_input_tokens_estimate() -> Optional[int]:
        if not isinstance(request, dict):
            return None
        return estimated_input_tokens(request.get("input"))

    def _try_hard_auto_compact(trigger_tokens: Optional[int], source: str = "usage.input_tokens") -> bool:
        threshold = AUTO_COMPACT_TRIGGER_INPUT_TOKENS
        if not isinstance(trigger_tokens, int) or trigger_tokens < threshold:
            return False

        log_warn(
            "auto-compact running (hard input_tokens threshold)",
            threshold=threshold,
            input_tokens=trigger_tokens,
            source=source,
        )
        if not quiet_mode:
            print(
                f"{YELLOW}WARN auto-compact running (input_tokens={trigger_tokens}, threshold={threshold}, source={source}){NC}",
                file=sys.stderr,
            )
            sys.stderr.flush()

        history_before = len(history) if isinstance(history, list) else 0
        compacted, compact_reason = compact_via_api_with_reason(
            history,
            system_prompt,
            model,
            token,
            account_id,
            base_url,
            llm_timeout,
            preserve_first_user_prompt=True,
            allow_image_inputs=allow_image_input,
        )
        if isinstance(compacted, list) and 0 < len(compacted) < len(history):
            _apply_compaction_result(compacted, None)
            post_tokens = _request_input_tokens_estimate()
            log_warn(
                "auto-compact triggered (hard input_tokens threshold)",
                threshold=threshold,
                input_tokens=trigger_tokens,
                source=source,
                post_compact_input_tokens=post_tokens,
            )
            if not quiet_mode:
                print(
                    f"{YELLOW}WARN auto-compact triggered (input_tokens={trigger_tokens}, threshold={threshold}, post_compact_input_tokens={post_tokens}){NC}",
                    file=sys.stderr,
                )
                sys.stderr.flush()
            return True
        else:
            reason = pre_compact_skip_reason(compact_reason, history_before, compacted)
            log_warn(
                "auto-compact skipped (hard input_tokens threshold)",
                threshold=threshold,
                input_tokens=trigger_tokens,
                source=source,
                reason=reason,
            )
            if not quiet_mode:
                print(
                    f"{YELLOW}WARN auto-compact skipped (input_tokens={trigger_tokens}, threshold={threshold}): {reason}{NC}",
                    file=sys.stderr,
                )
                sys.stderr.flush()
        return False

    current_workdir = Path.cwd().resolve()
    history, removed_env_context = prune_tag_context_messages(history, "environment_context")
    if removed_env_context:
        rewrite_history(session_file, history)
        log_warn(
            "environment_context refreshed (removed stale items)",
            removed=removed_env_context,
            workdir=str(current_workdir),
        )
    startup_changed, startup_history, startup_output_ids, startup_input_ids, startup_saved_tokens = mc.try_micro_compact_with_stats(
        list(history),
        session_file.parent,
        min_saved=0,
    )
    if startup_changed:
        _apply_compaction_result(startup_history, (startup_output_ids, startup_input_ids))
        log_warn("micro-compact triggered (startup)", min_saved=0, saved_tokens=startup_saved_tokens)
        if not quiet_mode:
            print(f"{YELLOW}WARN micro-compact triggered (startup, saved_tokens={startup_saved_tokens}){NC}", file=sys.stderr)
            sys.stderr.flush()

    context_items, fixed_workdir, fixed_shell = build_context_updates(history, current_workdir)
    if context_items:
        history.extend(context_items)
        append_history(session_file, context_items)
    fixed_workdir_path = resolve_workdir(fixed_workdir, Path.cwd())
    if not quiet_mode:
        user_line = truncate_middle_line(prompt, 100)
        sys.stdout.write(f"{PURPLE}[user]{NC} {user_line}\n")
        sys.stdout.flush()
    tool_spec, apply_patch_tool = load_tool_specs(script_dir)
    view_image_tool = load_view_image_tool_spec(script_dir)

    image_refs = image_refs_from_env(os.environ.get(IMG_ENV_VAR))
    ctx_items = ctx_messages_from_env(os.environ.get(CTX_ENV_VAR), current_workdir, history=history)
    if ctx_items:
        history.extend(ctx_items)
        append_history(session_file, ctx_items)
    user_content = [{"type": "input_text", "text": prompt}]
    if image_refs and allow_image_input:
        user_content.extend(
            input_image_part(image_ref, current_workdir, detail=IMAGE_DETAIL_ORIGINAL)
            for image_ref in image_refs
        )
    elif image_refs:
        log_warn("image input skipped (unsupported model)", model=model, count=len(image_refs))
        if not quiet_mode:
            print(
                f"{YELLOW}WARN image input skipped for model {model}; original image input is only enabled on gpt-5.5{NC}",
                file=sys.stderr,
            )
            sys.stderr.flush()
    user_item = {"type": "message", "role": "user", "content": user_content}
    history.append(user_item)
    append_history(session_file, [user_item])
    reasoning = {"effort": reasoning_effort}
    if reasoning_summary_supported(model):
        reasoning["summary"] = reasoning_summary
    request = {
        "model": model,
        "instructions": system_prompt,
        "input": _request_input_items(history, allow_image_input),
        "reasoning": reasoning,
        "tools": _request_tools(tool_spec, apply_patch_tool, view_image_tool, allow_image_input),
        "tool_choice": "auto",
        "parallel_tool_calls": True,
        "store": False,
        "stream": True,
        "include": ["reasoning.encrypted_content"],
    }
    if priority_tier_requested:
        request["service_tier"] = "priority"
    if (cache_key := prompt_cache_key_for_session(session_file)): request["prompt_cache_key"] = cache_key

    def _persist_generated_images(output_items: list[dict]) -> tuple[list[dict], list[dict]]:
        persisted_items: list[dict] = []
        note_items: list[dict] = []
        for item in output_items:
            if not isinstance(item, dict) or item.get("type") != "image_generation_call":
                persisted_items.append(item)
                continue
            image_id = _nonempty_string(item.get("id"))
            result = item.get("result")
            if not image_id or not isinstance(result, str):
                persisted_items.append(item)
                continue
            try:
                saved_path = save_generated_image(
                    result,
                    session_file.parent,
                    image_id,
                    output_format=IMAGE_GENERATION_OUTPUT_FORMAT,
                )
            except Exception as exc:
                log_warn("failed to save generated image", call_id=image_id, error=str(exc))
                if not quiet_mode:
                    print(f"{YELLOW}WARN failed to save generated image {image_id}: {exc}{NC}", file=sys.stderr)
                    sys.stderr.flush()
                persisted_items.append(item)
                continue
            persisted_item = dict(item)
            revised_prompt = _nonempty_string(persisted_item.get("revised_prompt"))
            persisted_item["result"] = ""
            persisted_item["saved_path"] = str(saved_path)
            persisted_items.append(persisted_item)
            note_items.append(generated_image_note_item(saved_path, revised_prompt=revised_prompt))
            if not quiet_mode:
                print(f"{CYAN}[image]{NC} saved {saved_path}", file=sys.stderr)
                if revised_prompt:
                    print(f"{CYAN}[image]{NC} revised_prompt:", file=sys.stderr)
                    print(revised_prompt, file=sys.stderr)
                sys.stderr.flush()
        return persisted_items, note_items

    def tool_items(call):
        name = _nonempty_string(call.get("name"))
        tool_type = call.get("tool_type")
        call_id = _nonempty_string(call.get("id"))
        if not name or not call_id: return None
        input_text = call.get("input", "")
        input_text = input_text if isinstance(input_text, str) else str(input_text)
        raw_arguments = call.get("arguments", "{}")
        arguments_text = raw_arguments if isinstance(raw_arguments, str) else json.dumps(raw_arguments, ensure_ascii=False, separators=(",", ":"))
        if name == "shell":
            args = json_loads(arguments_text, {})
            if not isinstance(args, dict): args = {}
            args = normalize_shell_planning_args(args)
            intent = args.get("intent", "")
            expect = args.get("expect", "")
            arguments_text = json.dumps(args, ensure_ascii=False, separators=(",", ":"))
            script = shell_script_from_args(args)
            workdir = resolve_workdir(args.get("workdir"), fixed_workdir_path)
            timeout_seconds = normalize_shell_timeout(
                args.get("timeout"),
                default=shell_timeout,
                max_seconds=SHELL_TIMEOUT_MAX_SECONDS,
            )
            call_item = {"type": "function_call", "call_id": call_id, "name": name, "arguments": arguments_text}
            script_preview = _truncate_preview_by_lines(script)
            if not quiet_mode:
                if intent:
                    sys.stderr.write(f"{CYAN}[intent]{NC} {truncate_middle_line(intent, SHELL_PLANNING_TEXT_MAX_CHARS)}\n")
                if expect:
                    sys.stderr.write(f"{CYAN}[expect]{NC} {truncate_middle_line(expect, SHELL_PLANNING_TEXT_MAX_CHARS)}\n")
                sys.stderr.write(f"{CYAN}[action]{NC} workdir: {workdir} | timeout: {timeout_seconds:g}s\n")
                sys.stderr.write(f"```bash\n{format_shell_preview(script_preview)}\n```\n")
                sys.stderr.flush()
            output = run_shell(script, workdir, timeout_seconds)
            out_type = "function_call_output"
        elif name == "apply_patch":
            call_item = {"type": "custom_tool_call", "call_id": call_id, "name": name, "input": input_text}
            patch_input = input_text
            preview = (patch_input or "").strip()
            preview = _truncate_preview_by_lines(preview)
            if not quiet_mode:
                preview = format_patch_preview(preview)
                sys.stderr.write(f"{CYAN}[patch]{NC}\n{preview}\n")
                sys.stderr.flush()
            output, out_type = run_apply_patch(str(patch_input or ""), fixed_workdir_path), "custom_tool_call_output"
        elif name == VIEW_IMAGE_TOOL_NAME:
            call_item = {"type": "function_call", "call_id": call_id, "name": name, "arguments": arguments_text}
            out_type = "function_call_output"
            if not allow_image_input:
                output = f"Error: {VIEW_IMAGE_TOOL_NAME} is only available with model gpt-5.5"
            else:
                args = json_loads(arguments_text, {})
                path_arg = _nonempty_string(args.get("path")) if isinstance(args, dict) else None
                detail_arg = _nonempty_string(args.get("detail")) if isinstance(args, dict) else None
                if detail_arg not in (None, IMAGE_DETAIL_ORIGINAL):
                    output = (
                        f"Error: {VIEW_IMAGE_TOOL_NAME}.detail only supports "
                        f"`{IMAGE_DETAIL_ORIGINAL}`; omit `detail` or use `{IMAGE_DETAIL_ORIGINAL}`"
                    )
                else:
                    try:
                        output = view_image_output_item(path_arg or "", fixed_workdir_path, detail=detail_arg)
                    except SystemExit as exc:
                        output = f"Error: {exc}"
        else:
            if tool_type == "function_call":
                call_item = {"type": "function_call", "call_id": call_id, "name": name, "arguments": arguments_text}
                out_type = "function_call_output"
            else:
                call_item = {"type": "custom_tool_call", "call_id": call_id, "name": name, "input": input_text}
                out_type = "custom_tool_call_output"
            output = f"Error: Unknown tool: {name}"
        return call_item, {"type": out_type, "call_id": call_id, "output": output}

    def _emit_compact_start(stage: str) -> None:
        label = "micro-compact" if stage == "micro" else "auto-compact"
        log_warn(f"{label} running (context_length_exceeded)", stage=stage)
        if quiet_mode: return
        print(f"{YELLOW}WARN {label} running (context_length_exceeded){NC}", file=sys.stderr)
        sys.stderr.flush()

    def _emit_compact_trigger(stage: str) -> None:
        label = "micro-compact" if stage == "micro" else "auto-compact"
        log_warn(f"{label} triggered (context_length_exceeded)", stage=stage)
        if quiet_mode: return
        print(f"{YELLOW}WARN {label} triggered (context_length_exceeded){NC}", file=sys.stderr)
        sys.stderr.write("\a")
        sys.stderr.flush()

    def _emit_thinking(text: str):
        formatted = format_thinking(text, UNDERLINE, UNDERLINE_OFF)
        sys.stderr.write(f"{PURPLE}[think]{NC} {TAN}{formatted}{NC}\n")
        sys.stderr.flush()

    def _debug_event(event_type: str, payload: Optional[dict]):
        print(f"{GRAY}[debug] type={event_type}{NC}", file=sys.stderr)
        if isinstance(payload, dict):
            print(f"{GRAY}{ITALIC}{json.dumps(payload, ensure_ascii=False)}{NC}", file=sys.stderr)

    last_status = None
    last_payload = None
    last_stream_calls = None
    last_attempt = 0

    try:
        # Outer loop = conversation turns. It repeats only when tools are called
        # and we need to send another model request with tool outputs appended.
        while True:
            retry_streak = 0
            first_stream_anomaly = None
            # Inner loop = retry the same request on transient stream/transport failures.
            while True:
                status, payload, stream_calls = run_stream(
                    request, debug_level, token, account_id,
                    base_url, llm_timeout, quiet_mode,
                    on_thinking=_emit_thinking,
                    on_debug=_debug_event,
                )
                last_status = status
                last_payload = payload
                last_stream_calls = stream_calls
                if status == "failed" and stream_has_valid_response(payload):
                    retry_streak = 0
                    first_stream_anomaly = None
                current_attempt = retry_streak + 1
                last_attempt = current_attempt

                dbg = payload.get("_stream_debug") if isinstance(payload, dict) else None
                if first_stream_anomaly is None and isinstance(dbg, dict):
                    # Log-worthy anomalies: SSE parse errors or "ended without completion" / exceptions.
                    parse_error_count = dbg.get("parse_error_count")
                    try: parse_error_count = int(parse_error_count or 0)
                    except Exception: parse_error_count = 0
                    extra = dbg.get("extra")
                    terminal_event = extra.get("terminal_event") if isinstance(extra, dict) else None
                    duplicate_output_item_ids = stream_duplicate_output_item_ids_from_payload(payload)
                    if parse_error_count > 0 or terminal_event in ("stream_end", "exception") or duplicate_output_item_ids:
                        first_stream_anomaly = {
                            "attempt": current_attempt,
                            "status": status,
                            "terminal_event": terminal_event,
                            "parse_error_count": parse_error_count,
                            "duplicate_output_item_ids": duplicate_output_item_ids,
                            "payload": payload_debug_snapshot(payload),
                        }
                if status == "failed":
                    delay = retry_delay(payload, current_attempt, stream_retry_delay, stream_retry_delay_rate_limit, max_seconds=stream_retry_max_delay)
                    log_error(payload, attempt=current_attempt, retry_delay=delay, retrying=delay is not None and retry_streak < stream_max_retries)
                    if delay is not None and retry_streak < stream_max_retries:
                        next_streak = current_attempt
                        log_warn("retryable error; retrying", attempt=next_streak, max_retries=stream_max_retries, delay=delay)
                        err_info = retry_error_info(payload)
                        if not quiet_mode: print(f"{YELLOW}WARN retryable error{err_info}; retrying ({next_streak}/{stream_max_retries}) in {delay:.2f}s{NC}", file=sys.stderr)
                        retry_streak = next_streak
                        if delay > 0: time.sleep(delay)
                        continue
                break

            # If request context is too large, try compaction and retry the turn once history shrinks.
            if status == "failed" and (code := error_code_from_payload(payload)) == "context_length_exceeded":
                changed, compacted_history, compact_ids = try_auto_compact_on_context_error(
                    list(history), session_file.parent,
                    compact_mode, system_prompt,
                    model, token, account_id,
                    base_url, llm_timeout,
                    on_stage_start=_emit_compact_start,
                    on_stage_trigger=_emit_compact_trigger,
                )
                if changed:
                    _apply_compaction_result(compacted_history, compact_ids)
                    retry_streak = 0
                    first_stream_anomaly = None
                    continue
            if status == "failed":
                failure = terminal_failure_classification(payload)
                log_crash(
                    "terminal stream failure",
                    status=status,
                    attempts=retry_streak + 1,
                    max_retries=stream_max_retries,
                    failure=failure,
                    payload=payload_debug_snapshot(payload),
                    first_stream_anomaly=first_stream_anomaly,
                    request=request_debug_snapshot(request),
                    history_len=len(history),
                    session_file=str(session_file),
                    cwd=str(Path.cwd()),
                    fixed_workdir=str(fixed_workdir_path),
                )
                print(f"{RED}{json.dumps(payload, ensure_ascii=False)}{NC}", file=sys.stderr)
                if not quiet_mode: sys.stderr.write("\a"); sys.stderr.flush()
                return 1

            response = payload.get("response") or {}
            if first_stream_anomaly:
                if duplicate_output_item_ids := first_stream_anomaly.get("duplicate_output_item_ids"):
                    log_warn("duplicate output item ids returned by stream", ids=duplicate_output_item_ids)
                    if not quiet_mode:
                        print(
                            f"{YELLOW}WARN duplicate output item ids returned by stream: {', '.join(duplicate_output_item_ids)}{NC}",
                            file=sys.stderr,
                        )
                        sys.stderr.flush()
                log_crash(
                    "stream anomaly",
                    status="completed",
                    attempts=retry_streak + 1,
                    anomaly=first_stream_anomaly,
                    request=request_debug_snapshot(request),
                    history_len=len(history),
                    session_file=str(session_file),
                    cwd=str(Path.cwd()),
                )
            incomplete_flag = isinstance(payload, dict) and payload.get("incomplete") is True
            if isinstance(response, dict) and (incomplete_flag or response.get("status") == "incomplete"):
                details = response.get("incomplete_details")
                if not isinstance(details, dict) and isinstance(payload, dict):
                    details = payload.get("incomplete_details")
                reason = details.get("reason") if isinstance(details, dict) else None
                reason = reason or "unknown"
                log_warn(f"response incomplete ({reason})", reason=reason)
                if not quiet_mode:
                    sys.stderr.write(f"{YELLOW}WARN response incomplete ({reason}){NC}\n")
                    sys.stderr.flush()
            if not quiet_mode:
                usage_text = usage_text_from_response(response if isinstance(response, dict) else None)
                sys.stderr.write(f"{GRAY}[usage] {usage_text}{NC}\n")
                sys.stderr.flush()
            response_text = extract_output_text(response) if isinstance(response, dict) else ""
            output_text = response_text
            output_items = normalize_output_items(response.get("output")) if isinstance(response, dict) else []
            if output_items:
                output_items, generated_image_notes = _persist_generated_images(output_items)
                history.extend(output_items)
                append_history(session_file, output_items)
                if generated_image_notes:
                    history.extend(generated_image_notes)
                    append_history(session_file, generated_image_notes)
                request["input"] = _request_input_items(history, allow_image_input)
            threshold = mc.MICRO_COMPACT_TRIGGER_INPUT_TOKENS
            usage_input_tokens = response_input_tokens(response)
            hard_auto_compact_triggered = (
                isinstance(usage_input_tokens, int)
                and usage_input_tokens >= AUTO_COMPACT_TRIGGER_INPUT_TOKENS
            )
            if hard_auto_compact_triggered:
                _try_hard_auto_compact(trigger_tokens=usage_input_tokens, source="usage.input_tokens")
            else:
                trigger_tokens = usage_input_tokens
                trigger_source = "usage.input_tokens"
                if trigger_tokens is None:
                    trigger_tokens = _request_input_tokens_estimate()
                    trigger_source = "estimated_input_tokens"
                if isinstance(trigger_tokens, int) and trigger_tokens >= threshold:
                    log_warn(
                        "micro-compact running (input_tokens threshold)",
                        threshold=threshold,
                        input_tokens=trigger_tokens,
                        source=trigger_source,
                    )
                    changed, compacted_history, compact_output_ids, compact_input_ids, saved_tokens = mc.try_micro_compact_with_stats(
                        list(history),
                        session_file.parent,
                    )
                    if changed:
                        _apply_compaction_result(compacted_history, (compact_output_ids, compact_input_ids))
                        log_warn(
                            "micro-compact triggered (input_tokens threshold)",
                            threshold=threshold,
                            input_tokens=trigger_tokens,
                            source=trigger_source,
                            saved_tokens=saved_tokens,
                        )
                        if not quiet_mode:
                            print(
                                f"{YELLOW}WARN micro-compact triggered (input_tokens={trigger_tokens}, threshold={threshold}, saved_tokens={saved_tokens}){NC}",
                                file=sys.stderr,
                            )
                            sys.stderr.flush()
                    else:
                        log_warn(
                            "micro-compact skipped (input_tokens threshold)",
                            threshold=threshold,
                            input_tokens=trigger_tokens,
                            source=trigger_source,
                        )
            calls = merge_tool_calls(chain(stream_calls, iter_tool_calls(response)))
            if output_text:
                output_text = output_text.strip()
                if quiet_mode: sys.stdout.write(f"{output_text}\n")
                else: sys.stdout.write(f"{PURPLE}[assist]{NC}\n{render_markdown(output_text)}\n")
                sys.stdout.flush()

            if calls:
                pairs = [pair for pair in map(tool_items, calls) if pair is not None]
                tool_call_items, tool_output_items = map(list, zip(*pairs)) if pairs else ([], [])
                existing = {(it.get("type"), it.get("call_id")) for it in output_items if isinstance(it, dict)}
                # Avoid duplicating call records when model output already included them.
                if tool_call_items: tool_call_items = [it for it in tool_call_items if (it.get("type"), it.get("call_id")) not in existing]
                if tool_call_items:
                    history.extend(tool_call_items)
                    append_history(session_file, tool_call_items)
                history.extend(tool_output_items)
                append_history(session_file, tool_output_items)
                request["input"] = _request_input_items(history, allow_image_input)
                retry_streak = 0
                first_stream_anomaly = None
                continue

            if not quiet_mode: sys.stderr.write("\a"); sys.stderr.flush()
            return 0
    except KeyboardInterrupt:
        raise
    except Exception as exc:
        log_crash(
            "unhandled exception in main loop",
            exception=repr(exc),
            traceback=traceback.format_exc(),
            last_status=last_status,
            last_attempt=last_attempt,
            last_payload=payload_debug_snapshot(last_payload),
            last_stream_calls_count=len(last_stream_calls or []),
            request=request_debug_snapshot(request),
            history_len=len(history),
            session_file=str(session_file),
            cwd=str(Path.cwd()),
            fixed_workdir=str(fixed_workdir_path),
            fixed_shell=fixed_shell,
            compact_mode=compact_mode,
        )
        if not quiet_mode:
            sys.stderr.write(f"{RED}CRASH {exc.__class__.__name__}: {exc}{NC}\n")
            sys.stderr.flush()
        return 1

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except SystemExit:
        raise
    except Exception as exc:
        _append_jsonl_silent(
            Path.cwd() / ".m" / "crashes.jsonl",
            {
                "ts": time.time(),
                "pid": os.getpid(),
                "message": "fatal exception outside main()",
                "extra": {
                    "exception": repr(exc),
                    "traceback": traceback.format_exc(),
                },
            },
        )
        raise SystemExit(1)
