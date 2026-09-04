from typing import Optional, Union, Dict, List
import json
import os
import socket
import ssl
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime


def json_loads(text: str, default=None):
    if not isinstance(text, str): return default
    try: return json.loads(text)
    except Exception: return default


# Keep crash logs small and relevant: capture only the tail of the SSE stream.
STREAM_DEBUG_RECENT_EVENTS = 12
STREAM_DEBUG_MAX_ITEMS = 12
STREAM_DEBUG_MAX_DEPTH = 3
STREAM_DEBUG_MAX_TEXT = 1000
_STREAM_CAPTURE_DIR_SEEN = ""
_STREAM_CAPTURE_CALL_NUMBER = 0


def _truncate_debug_text(text: str, limit: int = STREAM_DEBUG_MAX_TEXT) -> str:
    if not isinstance(text, str): text = str(text)
    if len(text) <= limit: return text
    return f"{text[:limit]}…<{len(text) - limit} chars truncated>"


def _compact_debug_value(value, depth: int = 0):
    if value is None or isinstance(value, (int, float, bool)): return value
    if isinstance(value, str): return _truncate_debug_text(value)
    if depth >= STREAM_DEBUG_MAX_DEPTH: return f"<{type(value).__name__}>"
    if isinstance(value, dict):
        items = list(value.items())
        out = {}
        for idx, (key, val) in enumerate(items):
            if idx >= STREAM_DEBUG_MAX_ITEMS:
                out["…"] = f"{len(items) - STREAM_DEBUG_MAX_ITEMS} keys truncated"
                break
            out[str(key)] = _compact_debug_value(val, depth + 1)
        return out
    if isinstance(value, (list, tuple, set)):
        seq = list(value)
        out = [_compact_debug_value(item, depth + 1) for item in seq[:STREAM_DEBUG_MAX_ITEMS]]
        if len(seq) > STREAM_DEBUG_MAX_ITEMS: out.append(f"…{len(seq) - STREAM_DEBUG_MAX_ITEMS} items truncated")
        return out
    return _truncate_debug_text(str(value))


def _headers_text(headers) -> str:
    if headers is None: return ""
    try: items = list(headers.items()) if hasattr(headers, "items") else []
    except Exception: items = []
    lines = []
    for key, value in items:
        if key is None: continue
        lines.append(f"{key}: {value}")
    return ("\n".join(lines) + "\n") if lines else ""


def _stream_capture_next_call_number(capture_dir: str) -> int:
    global _STREAM_CAPTURE_DIR_SEEN, _STREAM_CAPTURE_CALL_NUMBER
    if capture_dir != _STREAM_CAPTURE_DIR_SEEN:
        _STREAM_CAPTURE_DIR_SEEN = capture_dir
        _STREAM_CAPTURE_CALL_NUMBER = 0
    _STREAM_CAPTURE_CALL_NUMBER += 1
    return _STREAM_CAPTURE_CALL_NUMBER


def _write_capture_text(path: str, text: str) -> None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", errors="replace") as fh:
            fh.write(text or "")
    except Exception:
        pass


def _capture_http_exchange(
    url: str,
    headers: dict,
    data: bytes,
    timeout: float,
    status: Optional[int],
    response_headers,
    response_body: str,
) -> None:
    capture_dir = os.environ.get("stream_capture_dir")
    if not isinstance(capture_dir, str) or not capture_dir.strip(): return
    capture_dir = capture_dir.strip()
    call_no = _stream_capture_next_call_number(capture_dir)
    prefix = os.path.join(capture_dir, str(call_no))
    request_text = data.decode("utf-8", errors="replace") if isinstance(data, (bytes, bytearray)) else str(data or "")
    meta = json.dumps({"url": url, "timeout": timeout}, ensure_ascii=False)
    _write_capture_text(f"{prefix}.request.json", request_text)
    _write_capture_text(f"{prefix}.request.headers", _headers_text(headers))
    _write_capture_text(f"{prefix}.request.meta.json", meta)
    _write_capture_text(f"{prefix}.response.headers", _headers_text(response_headers))
    _write_capture_text(f"{prefix}.response.body", response_body or "")
    _write_capture_text(f"{prefix}.status", str(int(status)) if isinstance(status, int) else "0")


def sse_headers(token: str, account_id: str) -> dict:
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "Accept": "text/event-stream",
        "Cache-Control": "no-cache",
        "originator": "Codex Desktop",
        "User-Agent": "Codex Desktop/26.212.1823 (darwin; arm64)",
    }
    if account_id: headers["ChatGPT-Account-Id"] = account_id
    return headers


def http_post(url: str, headers: dict, data: bytes, timeout: float):
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    ctx = ssl.create_default_context()
    return urllib.request.urlopen(req, context=ctx, timeout=timeout)


def read_http_error(exc: urllib.error.HTTPError) -> str:
    try: return exc.read().decode("utf-8", errors="replace")
    except Exception: return ""


def _parse_float(value) -> Optional[float]:
    try: return float(value)
    except Exception: return None


def parse_retry_after_header(value: Optional[str]) -> Optional[float]:
    if not isinstance(value, str) or not value.strip(): return None
    if (seconds := _parse_float(value.strip())) is not None: return max(0.0, seconds)
    try:
        if (dt := parsedate_to_datetime(value)) is None: return None
        if dt.tzinfo is None: dt = dt.replace(tzinfo=timezone.utc)
        delta = (dt - datetime.now(timezone.utc)).total_seconds()
        return max(0.0, delta)
    except Exception:
        return None


def normalize_error_payload(payload) -> dict:
    if not isinstance(payload, dict):
        return {"message": str(payload)}
    if "error" in payload:
        inner = payload.get("error")
        if isinstance(inner, dict):
            merged = dict(inner)
        else:
            merged = {"message": str(inner)}
        for key, value in payload.items():
            if key == "error": continue
            if key not in merged:
                merged[key] = value
        return merged
    return payload

def _extract_error_message(payload: dict) -> Optional[str]:
    for key in ("message", "detail", "error_description", "error", "msg"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip(): return value.strip()
    errors = payload.get("errors")
    if isinstance(errors, list) and errors:
        first = errors[0]
        if isinstance(first, str) and first.strip(): return first.strip()
        if isinstance(first, dict):
            for key in ("message", "detail", "error"):
                value = first.get(key)
                if isinstance(value, str) and value.strip(): return value.strip()
    return None

def normalize_http_error_payload(payload, status: Optional[int], retry_after: Optional[float], body: Optional[str]) -> dict:
    err: dict
    if isinstance(payload, dict):
        if "error" in payload:
            err = normalize_error_payload(payload)
        elif isinstance(payload.get("response"), dict) and isinstance(payload["response"].get("error"), dict):
            err = dict(payload["response"]["error"])
            for key, value in payload.items():
                if key == "response": continue
                if key not in err: err[key] = value
        else:
            message = _extract_error_message(payload)
            if not message and isinstance(body, str) and body.strip(): message = body.strip()
            if not message:
                try: message = json.dumps(payload, ensure_ascii=False)
                except Exception: message = str(payload)
            err = {"message": message}
            for key in ("code", "type", "param"):
                value = payload.get(key)
                if isinstance(value, str) and value and key not in err: err[key] = value
            for key, value in payload.items():
                if key not in err: err[key] = value
        if status is not None:
            if "status" not in err: err["status"] = status
            if "status_code" not in err: err["status_code"] = status
        if retry_after is not None and "retry_after" not in err:
            err["retry_after"] = retry_after
        return {"error": err}
    message = body.strip() if isinstance(body, str) and body.strip() else str(payload)
    err = {"message": message}
    if status is not None:
        err["status"] = status
        err["status_code"] = status
    if retry_after is not None: err["retry_after"] = retry_after
    return {"error": err}


def transport_error_payload(exc: Exception) -> dict:
    message = str(exc) or repr(exc)
    err = {
        "message": message,
        "type": "transport_error",
        "retryable": True,
        "exception": exc.__class__.__name__,
    }
    if isinstance(exc, urllib.error.URLError):
        reason = exc.reason
        if isinstance(reason, BaseException):
            err["reason"] = str(reason) or repr(reason)
            err["reason_type"] = reason.__class__.__name__
        elif reason is not None:
            err["reason"] = str(reason)
    return {"error": err}


def _header_value(headers, name: str) -> Optional[str]:
    if headers is None or not isinstance(name, str) or not name: return None
    if hasattr(headers, "get"):
        try:
            value = headers.get(name)
        except Exception:
            value = None
        if isinstance(value, str):
            value = value.strip()
            if value: return value
    try:
        items = headers.items() if hasattr(headers, "items") else []
    except Exception:
        items = []
    lname = name.lower()
    for key, value in items:
        if isinstance(key, str) and key.lower() == lname and isinstance(value, str):
            value = value.strip()
            if value: return value
    return None


def _header_bool(headers, name: str) -> Optional[bool]:
    if (value := _header_value(headers, name)) is None: return None
    lowered = value.lower()
    if lowered in ("1", "true", "yes", "on"): return True
    if lowered in ("0", "false", "no", "off"): return False
    return True


def _header_float(headers, name: str) -> Optional[float]:
    if (value := _header_value(headers, name)) is None: return None
    try: return float(value)
    except Exception: return None


def _header_int(headers, name: str) -> Optional[int]:
    if (value := _header_value(headers, name)) is None: return None
    try: return int(value)
    except Exception: return None


def _parse_rate_limits(headers) -> list[dict]:
    prefix = "x-codex"
    primary_used = _header_float(headers, f"{prefix}-primary-used-percent")
    primary_minutes = _header_int(headers, f"{prefix}-primary-window-minutes")
    primary_reset = _header_int(headers, f"{prefix}-primary-reset-at")
    secondary_used = _header_float(headers, f"{prefix}-secondary-used-percent")
    secondary_minutes = _header_int(headers, f"{prefix}-secondary-window-minutes")
    secondary_reset = _header_int(headers, f"{prefix}-secondary-reset-at")
    has_credits = _header_bool(headers, f"{prefix}-credits-has-credits")
    unlimited = _header_bool(headers, f"{prefix}-credits-unlimited")
    balance = _header_value(headers, f"{prefix}-credits-balance")
    limit_name = _header_value(headers, f"{prefix}-limit-name")

    def _window(used, minutes, reset):
        if used is None and minutes is None and reset is None: return None
        return {"used_percent": used, "window_minutes": minutes, "resets_at": reset}

    primary = _window(primary_used, primary_minutes, primary_reset)
    secondary = _window(secondary_used, secondary_minutes, secondary_reset)
    credits = None
    if has_credits is not None and unlimited is not None:
        credits = {"has_credits": has_credits, "unlimited": unlimited, "balance": balance}
    if primary is None and secondary is None and credits is None and limit_name is None:
        return []
    return [{
        "limit_id": "codex",
        "limit_name": limit_name,
        "primary": primary,
        "secondary": secondary,
        "credits": credits,
    }]


def responses_url(base_url: str) -> str:
    base = (base_url or "").rstrip("/")
    return base if base.endswith("/responses") else f"{base}/responses"


def _nonempty_string(value) -> Optional[str]:
    if not isinstance(value, str): return None
    value = value.strip()
    return value or None


def _normalize_tool_call_item(item: dict) -> Optional[dict]:
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


def _dedupe_output_items_by_id(items):
    if not isinstance(items, list): return items, []
    out = []
    seen = {}
    duplicate_ids = []
    for item in items:
        if not isinstance(item, dict):
            out.append(item)
            continue
        item_id = _nonempty_string(item.get("id"))
        if not item_id:
            out.append(item)
            continue
        if item_id not in seen:
            seen[item_id] = len(out)
            out.append(item)
            continue
        if item_id not in duplicate_ids: duplicate_ids.append(item_id)
        out[seen[item_id]] = item
    return out, duplicate_ids


def iter_sse_payloads(lines):
    event = None
    buffer = []

    def _parse_error_payload(error: str, data: str, parsed_type: Optional[str] = None) -> dict:
        payload = {
            "type": "sse.parse_error",
            "event": event or "",
            "error": error,
            "data_len": len(data),
            "data": _truncate_debug_text(data, 2000),
        }
        if parsed_type:
            payload["parsed_type"] = parsed_type
        return payload

    def flush():
        nonlocal buffer
        if not buffer: return []
        data = "\n".join(buffer)
        buffer = []
        if data.strip() == "[DONE]": return [(event or "", None)]
        try:
            payload = json.loads(data)
        except Exception as exc:
            # Surface malformed chunks as synthetic events instead of crashing the stream loop.
            return [("sse.parse_error", _parse_error_payload(repr(exc), data))]
        if isinstance(payload, dict):
            return [(payload.get("type") or event or "", payload)]
        return [("sse.parse_error", _parse_error_payload("non_object_payload", data, parsed_type=type(payload).__name__))]

    for raw in lines:
        line = raw.rstrip("\n\r")
        if line.startswith("event:"): event = line.split(":", 1)[1].strip(); continue
        if line.startswith("data:"): buffer.append(line.split(":", 1)[1].lstrip()); continue
        if line == "": yield from flush()
    yield from flush()


def run_stream(
    request: dict,
    debug_level: int,
    token: str,
    account_id: str,
    base_url: str,
    timeout: float,
    quiet: bool = False,
    on_thinking=None,
    on_web_search=None,
    on_image_partial=None,
    on_debug=None,
) -> tuple[str, dict, list[dict]]:
    tool_calls: list[dict] = []
    response_obj = None
    completed_output_items: list[dict] = []
    completed_output_item_indexes: Dict[str, int] = {}
    stream_meta: dict = {}
    seen_thinking: set[str] = set()
    seen_web_search: set[str] = set()
    delta_parts: list[str] = []
    saw_output_text_delta = False
    reasoning_text_parts: Dict[str, List[str]] = {}
    custom_tool_inputs: Dict[str, Union[List[str], str]] = {}
    incomplete = False
    incomplete_details: Optional[dict] = None
    recent_events: list[dict] = []
    event_count = 0
    valid_event_count = 0
    last_event_type = ""
    parse_error_count = 0
    last_parse_error = None
    duplicate_output_item_ids: list[str] = []

    def _record_event(event_type: str, payload) -> None:
        nonlocal event_count, valid_event_count, last_event_type, parse_error_count, last_parse_error
        event_count += 1
        et = event_type or ""
        last_event_type = et
        if isinstance(payload, dict) and et != "sse.parse_error":
            valid_event_count += 1
        event: dict = {"n": event_count, "type": et}
        if payload is not None:
            event["payload"] = _compact_debug_value(payload)
        if et == "sse.parse_error":
            parse_error_count += 1
            if "payload" in event:
                last_parse_error = event["payload"]
        recent_events.append(event)
        if len(recent_events) > STREAM_DEBUG_RECENT_EVENTS:
            del recent_events[: len(recent_events) - STREAM_DEBUG_RECENT_EVENTS]

    def _stream_debug(extra: Optional[dict] = None) -> dict:
        debug = {
            "event_count": event_count,
            "valid_event_count": valid_event_count,
            "last_event_type": last_event_type,
            "parse_error_count": parse_error_count,
            # newest-first so log truncation keeps the most relevant tail
            "recent_events_order": "newest_first",
            "recent_events": list(reversed(recent_events)),
        }
        if last_parse_error is not None:
            debug["last_parse_error"] = last_parse_error
        if incomplete: debug["incomplete"] = True
        if isinstance(incomplete_details, dict) and incomplete_details:
            debug["incomplete_details"] = _compact_debug_value(incomplete_details)
        if extra: debug["extra"] = _compact_debug_value(extra)
        return debug

    def _custom_call_id(payload: Optional[dict]) -> str:
        if not isinstance(payload, dict): return ""
        return str(payload.get("call_id") or payload.get("id") or payload.get("item_id") or payload.get("tool_call_id") or "")

    def _clone_custom_tool_input(value):
        if isinstance(value, list): return list(value)
        return value

    def _promote_item_input(item_id: Optional[str], call_id: Optional[str]) -> None:
        if not item_id or not call_id or item_id == call_id: return
        key_item = str(item_id)
        key_call = str(call_id)
        if key_call in custom_tool_inputs: return
        # Some streams emit input deltas under item_id before call_id is known.
        # Copy buffered text forward so downstream tool execution sees full input.
        if (buffered := custom_tool_inputs.get(key_item)) is None: return
        custom_tool_inputs[key_call] = _clone_custom_tool_input(buffered)

    def _append_custom_tool_input(call_id: str, text: str) -> None:
        if not call_id or not isinstance(text, str) or text == "": return
        current = custom_tool_inputs.get(call_id)
        if current is None:
            custom_tool_inputs[call_id] = [text]
        elif isinstance(current, list):
            current.append(text)
        else:
            custom_tool_inputs[call_id] = [current, text]

    def _set_custom_tool_input(call_id: str, text: str) -> None:
        if not call_id or not isinstance(text, str): return
        custom_tool_inputs[call_id] = text

    def _get_custom_tool_input(call_id: str) -> str:
        current = custom_tool_inputs.get(call_id)
        if current is None: return ""
        return "".join(current) if isinstance(current, list) else str(current)

    def _prefer_buffered_input(call_id: Optional[str], current: Optional[str]) -> str:
        if not call_id: return current or ""
        if not isinstance(current, str): current = ""
        buffered = _get_custom_tool_input(str(call_id))
        if buffered and (not current or len(buffered) > len(current)): return buffered
        return current

    def emit_thinking(text: str):
        if quiet or on_thinking is None: return
        if text and text not in seen_thinking:
            seen_thinking.add(text)
            on_thinking(text)

    def _reasoning_key(payload: Optional[dict]) -> str:
        if not isinstance(payload, dict): return ""
        return _nonempty_string(payload.get("item_id")) or _nonempty_string(payload.get("id")) or ""

    def _append_reasoning_text(key: str, text: str) -> None:
        if not isinstance(text, str) or not text: return
        bucket = reasoning_text_parts.setdefault(key or "", [])
        bucket.append(text)

    def _clear_reasoning_text(key: str) -> None:
        if key:
            reasoning_text_parts.pop(key, None)
            return
        reasoning_text_parts.clear()

    def _flush_reasoning_text(key: Optional[str] = None) -> bool:
        if key is not None:
            parts = reasoning_text_parts.pop(key or "", None)
            if not parts: return False
            emit_thinking("".join(parts))
            return True
        emitted = False
        for item_key in list(reasoning_text_parts.keys()):
            parts = reasoning_text_parts.pop(item_key, None)
            if not parts: continue
            emit_thinking("".join(parts))
            emitted = True
        return emitted

    def emit_web_search(data: dict):
        if quiet or on_web_search is None: return
        call_id = str(data.get("call_id") or data.get("id") or "")
        query = data.get("query")
        if (not isinstance(query, str) or not query.strip()) and isinstance((action := data.get("action")), dict) and isinstance(action.get("query"), str): query = action.get("query")
        if (not isinstance(query, str) or not query.strip()) and isinstance((input_text := data.get("input")), str): query = input_text
        if (not isinstance(query, str) or not query.strip()) and isinstance((input_text := data.get("input")), dict): query = input_text.get("query") if isinstance(input_text.get("query"), str) else None
        if not isinstance(query, str) or not query.strip(): return
        if call_id and call_id in seen_web_search: return
        if call_id: seen_web_search.add(call_id)
        on_web_search(query.strip())

    def emit_image_partial(data: dict):
        if quiet or on_image_partial is None: return
        if not isinstance(data, dict): return
        if not isinstance(data.get("partial_image_b64"), str) or not data.get("partial_image_b64").strip():
            return
        on_image_partial(dict(data))

    def normalize_completed_output_item(item):
        if not isinstance(item, dict): return None
        output_item = dict(item)
        typ = output_item.get("type")
        if typ == "custom_tool_call":
            if not isinstance((normalized := _normalize_tool_call_item(output_item)), dict): return None
            output_item = normalized
            item_id = output_item.get("id")
            call_id = output_item.get("call_id")
            _promote_item_input(item_id, call_id)
            output_item["input"] = _prefer_buffered_input(call_id, output_item.get("input", ""))
            tool_calls.append({"id": call_id, "name": output_item.get("name"), "input": output_item.get("input", ""), "tool_type": "custom_tool_call"})
            return output_item
        if typ == "function_call":
            if not isinstance((normalized := _normalize_tool_call_item(output_item)), dict): return None
            output_item = normalized
            call_id = output_item.get("call_id")
            tool_calls.append({"id": call_id, "name": output_item.get("name"), "arguments": output_item.get("arguments", ""), "tool_type": "function_call"})
            return output_item
        if typ == "message":
            if not isinstance(output_item.get("role"), str) or not output_item.get("role").strip(): return None
            if not isinstance(output_item.get("content"), list): return None
            return output_item
        if typ == "reasoning":
            return output_item
        if typ == "web_search_call":
            return output_item
        if typ == "image_generation_call":
            return output_item
        return None

    def event_text_delta(payload, event_type):
        nonlocal saw_output_text_delta
        if not isinstance(payload, dict): return ""
        if event_type == "response.output_text.delta":
            if isinstance(delta := payload.get("delta", ""), str):
                saw_output_text_delta = True
                return delta
            return ""
        if not saw_output_text_delta and event_type == "response.content_part.delta":
            part = payload.get("part") or {}
            if isinstance(part, dict) and part.get("type") == "output_text" and isinstance(text := part.get("text", ""), str): return text
        return ""

    def handle_output_item(item):
        if not isinstance((output_item := normalize_completed_output_item(item)), dict): return
        item_id = _nonempty_string(output_item.get("id"))
        if item_id:
            if item_id in completed_output_item_indexes:
                if item_id not in duplicate_output_item_ids: duplicate_output_item_ids.append(item_id)
                completed_output_items[completed_output_item_indexes[item_id]] = output_item
            else:
                completed_output_item_indexes[item_id] = len(completed_output_items)
                completed_output_items.append(output_item)
        else:
            completed_output_items.append(output_item)
        if output_item.get("type") == "reasoning":
            item_key = _reasoning_key(output_item)
            summary_texts = [
                part.get("text")
                for part in output_item.get("summary") or []
                if isinstance(part, dict) and part.get("type") == "summary_text" and isinstance(part.get("text"), str)
            ]
            if summary_texts:
                for text in summary_texts:
                    emit_thinking(text)
                _clear_reasoning_text(item_key)
            else:
                _flush_reasoning_text(item_key)
        if output_item.get("type") == "web_search_call": emit_web_search(output_item)

    def handle_event(event_type: str, payload: Optional[dict]):
        nonlocal incomplete, incomplete_details
        if debug_level > 1 and not quiet and on_debug: on_debug(event_type, payload)
        if event_type in ("response.output_text.delta", "response.content_part.delta"):
            if delta := event_text_delta(payload, event_type): delta_parts.append(delta)
            return None
        # Buffer reasoning deltas and emit them only when the reasoning block is
        # completed (or the stream ends) to avoid token-chunk spam like `[think] ing`.
        if event_type == "response.reasoning_summary_text.delta":
            return None
        if event_type == "response.reasoning_text.delta":
            if isinstance(payload, dict) and isinstance((text := payload.get("delta")), str):
                _append_reasoning_text(_reasoning_key(payload), text)
            return None
        if event_type == "response.reasoning_summary_text.done":
            text = payload.get("text") if isinstance(payload, dict) else None
            if isinstance(text, str):
                emit_thinking(text)
                _clear_reasoning_text(_reasoning_key(payload))
            return None
        if event_type == "response.output_item.done": item = payload.get("item") if isinstance(payload, dict) else None; (handle_output_item(item) if isinstance(item, dict) else None); return None
        if event_type in ("response.custom_tool_call_input.delta", "response.custom_tool_call_input.done"):
            call_id = _custom_call_id(payload)
            if not call_id: return None
            if event_type.endswith(".done"):
                # Prefer full final input when provided; otherwise keep accumulated deltas.
                if isinstance((full_input := payload.get("input")), str):
                    _set_custom_tool_input(call_id, full_input)
                elif isinstance((full_input := payload.get("text")), str):
                    _set_custom_tool_input(call_id, full_input)
                elif isinstance((delta := payload.get("delta")), str):
                    _append_custom_tool_input(call_id, delta)
            else:
                delta = payload.get("delta")
                if not isinstance(delta, str): delta = payload.get("text")
                if isinstance(delta, str): _append_custom_tool_input(call_id, delta)
            return None
        if event_type == "response.image_generation_call.partial_image":
            emit_image_partial(payload)
            return None
        if event_type in ("response.web_search_call.in_progress", "response.web_search_call.searching", "response.web_search_call.completed"): (emit_web_search(payload) if isinstance(payload, dict) else None); return None
        if event_type == "response.failed":
            resp = payload.get("response") if isinstance(payload, dict) else None
            err = payload.get("error") if isinstance(payload, dict) else None
            err = (resp.get("error") if (not err and isinstance(resp, dict) and resp.get("error")) else err)
            return "failed", {"response": resp, "error": err, "_stream_debug": _stream_debug({"terminal_event": event_type})}
        if event_type == "error":
            return "failed", {"error": normalize_error_payload(payload), "_stream_debug": _stream_debug({"terminal_event": event_type})}
        if event_type == "response.incomplete":
            resp = payload.get("response") if isinstance(payload, dict) else None
            if isinstance(resp, dict):
                details = resp.get("incomplete_details")
                reason = details.get("reason") if isinstance(details, dict) and isinstance(details.get("reason"), str) else "unknown"
                return "failed", {
                    "response": resp,
                    "error": {"message": f"Incomplete response returned, reason: {reason}"},
                    "_stream_debug": _stream_debug({"terminal_event": event_type}),
                }
            return "failed", {"error": {"message": "response.incomplete without response payload"}, "_stream_debug": _stream_debug({"terminal_event": event_type})}
        if event_type == "response.completed":
            resp = payload.get("response") if isinstance(payload, dict) else None
            if isinstance(resp, dict):
                _flush_reasoning_text()
                return "completed", {"response": resp}
            return None
        if event_type == "response.done":
            resp = payload.get("response") if isinstance(payload, dict) else None
            if not isinstance(resp, dict): resp = {}
            _flush_reasoning_text()
            return "completed", {"response": resp}
        return None

    url = responses_url(base_url)
    headers = sse_headers(token, account_id)
    data = json.dumps(request).encode("utf-8")
    raw_chunks: list[str] = []
    response_headers = None
    response_status = 0
    try:
        with http_post(url, headers, data, timeout) as resp:
            response_headers = getattr(resp, "headers", None)
            try: response_status = int(getattr(resp, "status", 200) or 200)
            except Exception: response_status = 200
            if (server_model := _header_value(response_headers, "OpenAI-Model")) is not None:
                stream_meta["server_model"] = server_model
            if (models_etag := _header_value(response_headers, "X-Models-Etag")) is not None:
                stream_meta["models_etag"] = models_etag
            if (reasoning_included := _header_bool(response_headers, "X-Reasoning-Included")) is True:
                stream_meta["server_reasoning_included"] = True
            if (rate_limits := _parse_rate_limits(response_headers)):
                stream_meta["rate_limits"] = rate_limits
            terminal_result = None
            def _decoded_lines():
                for raw in resp:
                    text = raw.decode("utf-8", errors="replace")
                    raw_chunks.append(text)
                    yield text
            for event_type, payload in iter_sse_payloads(
                _decoded_lines()
            ):
                _record_event(event_type, payload)
                if payload is None: continue
                result = handle_event(event_type, payload)
                if result:
                    status, out_payload = result
                    terminal_result = (status, out_payload)
                    if status == "completed": response_obj = out_payload.get("response")
                    break
            _capture_http_exchange(
                url,
                headers,
                data,
                timeout,
                response_status,
                response_headers,
                "".join(raw_chunks),
            )
            if terminal_result and terminal_result[0] != "completed":
                return terminal_result[0], terminal_result[1], tool_calls
    except urllib.error.HTTPError as exc:
        body = read_http_error(exc)
        _capture_http_exchange(url, headers, data, timeout, getattr(exc, "code", 0), getattr(exc, "headers", None), body)
        payload = json_loads(body) if body else None
        retry_after = parse_retry_after_header(exc.headers.get("Retry-After")) if getattr(exc, "headers", None) else None
        normalized = normalize_http_error_payload(payload, exc.code, retry_after, body or str(exc))
        normalized["_stream_debug"] = _stream_debug({"terminal_event": "http_error", "status": exc.code, "body": _truncate_debug_text(body, 2000)})
        return "failed", normalized, tool_calls
    except (urllib.error.URLError, ssl.SSLError, socket.timeout, TimeoutError, ConnectionError) as exc:
        captured_body = "".join(raw_chunks) if raw_chunks else (str(exc) or repr(exc))
        _capture_http_exchange(url, headers, data, timeout, response_status, response_headers, captured_body)
        payload = transport_error_payload(exc)
        payload["_stream_debug"] = _stream_debug({"terminal_event": "transport_error"})
        return "failed", payload, tool_calls
    except Exception as exc:
        captured_body = "".join(raw_chunks) if raw_chunks else repr(exc)
        _capture_http_exchange(url, headers, data, timeout, response_status, response_headers, captured_body)
        return "failed", {
            "error": {
                "message": repr(exc),
                "exception": exc.__class__.__name__,
                "traceback": traceback.format_exc(),
            },
            "_stream_debug": _stream_debug({"terminal_event": "exception"}),
        }, tool_calls

    if custom_tool_inputs:
        for call in tool_calls:
            if call.get("tool_type") != "custom_tool_call": continue
            call_id = call.get("id")
            if not call_id: continue
            current = call.get("input")
            buffered = _get_custom_tool_input(str(call_id))
            # Choose the richest reconstructed input to avoid truncated tool arguments.
            if buffered and (not isinstance(current, str) or not current.strip() or len(buffered) > len(current)):
                call["input"] = buffered
        for item in completed_output_items:
            if not isinstance(item, dict) or item.get("type") != "custom_tool_call": continue
            call_id = item.get("call_id")
            if not call_id: continue
            buffered = _get_custom_tool_input(str(call_id))
            current = item.get("input")
            if buffered and (not isinstance(current, str) or not current.strip() or len(buffered) > len(current)):
                item["input"] = buffered
    if response_obj is None:
        return "failed", {
            "error": {"message": "Stream ended without completion"},
            "_stream_debug": _stream_debug({"terminal_event": "stream_end"}),
        }, tool_calls
    response_payload = dict(response_obj) if isinstance(response_obj, dict) else {}
    if completed_output_items:
        response_payload["output"] = completed_output_items
    response_output = response_payload.get("output")
    if isinstance(response_output, list):
        response_output, response_duplicate_ids = _dedupe_output_items_by_id(response_output)
        response_payload["output"] = response_output
        for item_id in response_duplicate_ids:
            if item_id not in duplicate_output_item_ids: duplicate_output_item_ids.append(item_id)
    assistant_text = "".join(
        part["text"]
        for item in (response_payload.get("output") or [])
        if isinstance(item, dict) and item.get("type") == "message" and item.get("role") == "assistant"
        for part in (item.get("content") or [])
        if isinstance(part, dict)
        and part.get("type") == "output_text"
        and isinstance(part.get("text"), str)
        and part.get("text")
    ) or "".join(delta_parts)
    payload_out = {"response": response_payload, "assistant_text": assistant_text}
    if stream_meta:
        payload_out["_stream_meta"] = stream_meta
    if parse_error_count or duplicate_output_item_ids:
        extra = {"terminal_event": "completed"}
        if duplicate_output_item_ids: extra["duplicate_output_item_ids"] = duplicate_output_item_ids
        payload_out["_stream_debug"] = _stream_debug(extra)
    return "completed", payload_out, tool_calls
