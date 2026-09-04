from typing import Optional, Tuple
import json
import math
import time
import urllib.error

from retry_policy import compact_retry_delay, error_code_from_payload
from input_images import sanitize_request_input_items
from streaming import (
    http_post,
    iter_sse_payloads as _iter_sse_payloads,
    json_loads,
    normalize_http_error_payload,
    parse_retry_after_header,
    read_http_error,
    responses_url,
    sse_headers,
)

AUTO_COMPACT_KEEP_LAST_ITEMS = 32
AUTO_COMPACT_TRIGGER_INPUT_TOKENS = 320_000
KEEP_LAST_TOKEN_CAP = 30_000
KEEP_LAST_IMAGE_TOKENS = 2_000
TOOL_CALL_TYPES = {"function_call": "function_call_output", "custom_tool_call": "custom_tool_call_output"}
TOOL_OUTPUT_TYPES = {v: k for k, v in TOOL_CALL_TYPES.items()}
COMPACT_REQUEST_MAX_RETRIES = 4
COMPACT_RETRY_DELAY = 0.2
COMPACT_RETRY_MAX_DELAY = 30.0
COMPACT_RETRY_429 = False
# Keep compact requests pinned to the same Codex model as the Ultra image lane.
COMPACT_API_FIXED_MODEL = "gpt-5.5"


def _output_text_from_raw(raw):
    if isinstance(raw, str) and isinstance(parsed := json_loads(raw), dict) and "output" in parsed:
        return str(parsed.get("output") or "")
    return str(raw or "") if raw is not None else ""


def _est_tokens_text(text) -> int:
    try: return int(math.ceil(len(str(text)) / 4.0)) if text else 0
    except Exception: return 0


def _est_tokens_item(item: dict) -> int:
    if not isinstance(item, dict): return 0
    itype = item.get("type")
    if itype == "message":
        total = 0
        for c in item.get("content") or []:
            if not isinstance(c, dict): continue
            if c.get("type") in ("input_image", "input_image_url"): total += KEEP_LAST_IMAGE_TOKENS
            else: total += _est_tokens_text(c.get("text"))
        return total
    if itype in ("function_call", "custom_tool_call"): return _est_tokens_text(json.dumps(item, ensure_ascii=False))
    if itype in ("function_call_output", "custom_tool_call_output"): return _est_tokens_text(_output_text_from_raw(item.get("output")))
    if itype in ("reasoning", "compaction_summary", "compaction"): return _est_tokens_text(item.get("encrypted_content") or "")
    return _est_tokens_text(json.dumps(item, ensure_ascii=False))


def _tool_pair_intervals(items: list) -> list[tuple[int, int]]:
    bounds = {}
    for idx, item in enumerate(items or []):
        if not isinstance(item, dict): continue
        itype = item.get("type")
        if itype not in TOOL_CALL_TYPES and itype not in TOOL_OUTPUT_TYPES: continue
        call_id = item.get("call_id")
        if not isinstance(call_id, str) or not call_id: continue
        entry = bounds.get(call_id)
        if entry is None:
            entry = {"low": idx, "high": idx, "has_call": False, "has_output": False}
            bounds[call_id] = entry
        entry["low"] = min(entry["low"], idx)
        entry["high"] = max(entry["high"], idx)
        if itype in TOOL_CALL_TYPES: entry["has_call"] = True
        else: entry["has_output"] = True
    intervals = []
    for entry in bounds.values():
        low, high = entry["low"], entry["high"]
        if entry["has_call"] and entry["has_output"]: intervals.append((low, high))
        else: intervals.append((-1, high))
    return intervals


def _avoid_split_tool_pairs(items: list, start: int) -> int:
    intervals = _tool_pair_intervals(items)
    if not intervals: return start
    end = len(items)
    # If the retained tail starts in the middle of a call/output pair,
    # move forward until we start after the pair's highest index.
    while start < end:
        max_high = None
        for low, high in intervals:
            if low < start <= high:
                if max_high is None or high > max_high: max_high = high
        if max_high is None: break
        start = max_high + 1
    return min(start, end)


def is_prefix_msg(item: dict) -> bool:
    if not isinstance(item, dict) or item.get("type") != "message": return False
    if item.get("role") != "user" or not isinstance((content := item.get("content")), list): return False
    for c in content:
        if not isinstance(c, dict) or c.get("type") != "input_text": continue
        t = c.get("text", "")
        if not isinstance(t, str): continue
        s = t.lstrip()
        if s.startswith("# AGENTS.md instructions for ") or s.startswith("<environment_context>"): return True
    return False


def _first_message_input_text(item: dict) -> Optional[str]:
    if not isinstance(item, dict): return None
    if item.get("type") != "message" or item.get("role") != "user": return None
    content = item.get("content")
    if not isinstance(content, list): return None
    for part in content:
        if not isinstance(part, dict) or part.get("type") != "input_text": continue
        text = part.get("text")
        if isinstance(text, str): return text
    return None


def _is_tag_wrapped_text(text: str, tag: str) -> bool:
    if not isinstance(text, str): return False
    normalized = str(tag or "").strip().lower()
    if not normalized: return False
    stripped = text.strip().lower()
    return stripped.startswith(f"<{normalized}>") and stripped.endswith(f"</{normalized}>")


def is_real_first_user_prompt(item: dict) -> bool:
    if not isinstance((text := _first_message_input_text(item)), str): return False
    stripped = text.strip()
    if not stripped: return False
    if stripped.startswith("# AGENTS.md instructions for "): return False
    if _is_tag_wrapped_text(stripped, "environment_context"): return False
    if _is_tag_wrapped_text(stripped, "KEYWORDS"): return False
    if _is_tag_wrapped_text(stripped, "FLOWS"): return False
    return True


def _keep_last_items(items: list, keep_last: int) -> list:
    if not isinstance(items, list) or not items: return items
    if keep_last <= 0: return []
    start = max(0, len(items) - keep_last)
    if KEEP_LAST_TOKEN_CAP > 0:
        tokens = [_est_tokens_item(item) for item in items]
        total = sum(tokens[start:])
        while start < len(items) and total > KEEP_LAST_TOKEN_CAP:
            total -= tokens[start]
            start += 1
    # Keep-last and token-cap trimming must still preserve tool call/output boundaries.
    start = _avoid_split_tool_pairs(items, start)
    return items[start:]


def _is_context_length_exceeded_error(err: Optional[dict]) -> bool:
    if not isinstance(err, dict): return False
    code = str(err.get("code") or err.get("type") or "").strip()
    if code != "context_length_exceeded": return False
    param = err.get("param")
    if param is None: return True
    if isinstance(param, str): return param in ("input", "")
    return False


def _error_obj_from_payload(payload: Optional[dict]) -> Optional[dict]:
    if not isinstance(payload, dict): return None
    if isinstance((err := payload.get("error")), dict): return err
    if isinstance((resp := payload.get("response")), dict) and isinstance((err := resp.get("error")), dict): return err
    return payload if isinstance(payload.get("code") or payload.get("type"), str) else None


def is_context_length_exceeded(payload_text: str) -> bool:
    if not isinstance(payload_text, str) or not payload_text.strip(): return False
    if isinstance(payload := json_loads(payload_text), dict):
        if _is_context_length_exceeded_error(_error_obj_from_payload(payload)): return True
    for evt, payload in _iter_sse_payloads(payload_text.splitlines()):
        if not isinstance(payload, dict): continue
        if evt in ("error", "response.failed"):
            if _is_context_length_exceeded_error(_error_obj_from_payload(payload)): return True
    return False


def extract_compact_output(content: str) -> list[dict]:
    if isinstance(data := json_loads(content), dict) and isinstance((output := data.get("output")), list): return output
    for evt, payload in _iter_sse_payloads(content.splitlines()):
        if payload is None: continue
        if evt in ("response.completed", "response.done") and isinstance((response := payload.get("response") if isinstance(payload, dict) else None), dict) and isinstance((output := response.get("output")), list): return output
    return []


def _http_retry_payload(status: Optional[int], body: str, retry_after: Optional[float]):
    payload = json_loads(body) if isinstance(body, str) and body.strip() else None
    return normalize_http_error_payload(payload, status, retry_after, body)


def _retry_label(payload) -> str:
    code = error_code_from_payload(payload)
    status = None
    if isinstance(payload, dict) and isinstance((err := payload.get("error")), dict):
        try: status = int(err.get("status") or err.get("status_code"))
        except Exception: status = None
    if isinstance(status, int) and status > 0 and isinstance(code, str) and code: return f"http_error [{status}] {code}"
    if isinstance(status, int) and status > 0: return f"http_error [{status}]"
    if isinstance(code, str) and code: return f"error {code}"
    return "request_error"


def compact_via_api_with_reason(
    history: list,
    system_prompt: str,
    model: str,
    token: str,
    account_id: str,
    base_url: str,
    timeout: float,
    keep_last_items: int = AUTO_COMPACT_KEEP_LAST_ITEMS,
    on_trim_retry=None,
    on_request_retry=None,
    request_max_retries: int = COMPACT_REQUEST_MAX_RETRIES,
    request_retry_delay: float = COMPACT_RETRY_DELAY,
    request_retry_max_delay: Optional[float] = COMPACT_RETRY_MAX_DELAY,
    request_retry_429: bool = COMPACT_RETRY_429,
    preserve_first_user_prompt: bool = False,
    allow_image_inputs: bool = True,
) -> Tuple[Optional[list], str]:
    try: request_max_retries = max(0, int(request_max_retries))
    except Exception: request_max_retries = COMPACT_REQUEST_MAX_RETRIES
    try: request_retry_delay = float(request_retry_delay)
    except Exception: request_retry_delay = COMPACT_RETRY_DELAY
    if request_retry_delay <= 0: request_retry_delay = COMPACT_RETRY_DELAY
    if request_retry_max_delay is not None:
        try: request_retry_max_delay = float(request_retry_max_delay)
        except Exception: request_retry_max_delay = COMPACT_RETRY_MAX_DELAY
        if request_retry_max_delay <= 0: request_retry_max_delay = None

    items = [it for it in history if isinstance(it, dict)]
    pinned, filtered = [], []
    first_user_prompt_pinned = False
    for it in items:
        if is_prefix_msg(it):
            pinned.append(it)
            continue
        if preserve_first_user_prompt and not first_user_prompt_pinned and is_real_first_user_prompt(it):
            pinned.append(it)
            first_user_prompt_pinned = True
            continue
        filtered.append(it)
    kept_tail = _keep_last_items(filtered, keep_last_items)
    keep_start = len(filtered) - len(kept_tail)
    compact_input = filtered[:keep_start]
    prefix_msgs = [item for item in pinned if isinstance(item, dict) and item.get("type") == "message"]
    if not compact_input: return prefix_msgs + kept_tail, "no_compactable_input"

    truncated_count = 0
    request_retries = 0
    while True:
        request_input = sanitize_request_input_items(compact_input, allow_image_inputs)
        req = {
            "model": COMPACT_API_FIXED_MODEL,
            "input": request_input,
            "instructions": system_prompt,
        }
        url = responses_url(base_url) + "/compact"
        headers = sse_headers(token, account_id)
        data = json.dumps(req).encode("utf-8")
        try:
            with http_post(url, headers, data, timeout) as resp: content = resp.read().decode("utf-8", errors="replace")
            request_retries = 0
        except urllib.error.HTTPError as exc:
            body = read_http_error(exc)
            status = getattr(exc, "code", None)
            retry_after = parse_retry_after_header(exc.headers.get("Retry-After")) if getattr(exc, "headers", None) else None
            if not is_context_length_exceeded(body):
                payload = _http_retry_payload(status, body, retry_after)
                attempt = request_retries + 1
                if (delay := compact_retry_delay(payload, attempt, request_retry_delay, max_seconds=request_retry_max_delay, retry_429=request_retry_429)) is not None and request_retries < request_max_retries:
                    request_retries += 1
                    if callable(on_request_retry):
                        try: on_request_retry(request_retries, request_max_retries, delay, _retry_label(payload))
                        except Exception: pass
                    time.sleep(delay)
                    continue
                status_s = str(status) if status is not None else "?"
                code = error_code_from_payload(payload)
                if code: return None, f"http_error [{status_s}] {code}"
                return None, f"http_error [{status_s}]"
            request_retries = 0
            content = None
        except Exception as exc:
            payload = {"error": {"type": "transport_error", "message": str(exc) or repr(exc), "retryable": True, "exception": exc.__class__.__name__}}
            attempt = request_retries + 1
            if (delay := compact_retry_delay(payload, attempt, request_retry_delay, max_seconds=request_retry_max_delay, retry_429=request_retry_429)) is not None and request_retries < request_max_retries:
                request_retries += 1
                if callable(on_request_retry):
                    try: on_request_retry(request_retries, request_max_retries, delay, _retry_label(payload))
                    except Exception: pass
                time.sleep(delay)
                continue
            return None, f"request_exception {exc.__class__.__name__}"

        # Handle context-length failures from either raw HTTP errors or SSE-formatted responses
        # through the same local trim-and-retry path.
        if content is not None and is_context_length_exceeded(content):
            request_retries = 0
            content = None
        if content is None and len(compact_input) <= 1: return None, "context_length_exceeded_during_compact"
        if content is not None and not (compact_output := extract_compact_output(content)): return None, "compact_output_missing"
        if content is not None:
            compact_items = [item for item in compact_output if isinstance(item, dict) and item.get("type") in ("message", "compaction_summary")]
            summaries = [item for item in compact_items if item.get("type") == "compaction_summary"]
            if not summaries: summaries = [item for item in compact_items if item.get("type") == "message"]
            formatted_summaries = [(item if item.get("type") == "message" else {"type": "compaction", "encrypted_content": item.get("encrypted_content")}) for item in summaries]
            return prefix_msgs + formatted_summaries + kept_tail, "ok"

        def remove_first_matching(it_list: list, want_type: str, call_id: str) -> None:
            idx = next(
                (i for i, it in enumerate(it_list)
                 if isinstance(it, dict) and it.get("type") == want_type and it.get("call_id") == call_id),
                None,
            )
            if idx is not None: it_list.pop(idx)

        removed_batch = 0
        target_trim = min(2, len(compact_input))
        while removed_batch < target_trim and compact_input:
            # Trim newest compactable items first to preserve earlier context.
            removed = compact_input.pop()
            if isinstance(removed, dict) and isinstance((call_id := removed.get("call_id")), str) and call_id:
                removed_type = removed.get("type")
                # Keep request input structurally valid by dropping the paired counterpart too.
                if removed_type in TOOL_CALL_TYPES: remove_first_matching(compact_input, TOOL_CALL_TYPES[removed_type], call_id)
                elif removed_type in TOOL_OUTPUT_TYPES: remove_first_matching(compact_input, TOOL_OUTPUT_TYPES[removed_type], call_id)
            truncated_count += 1
            removed_batch += 1
        if removed_batch and callable(on_trim_retry):
            try: on_trim_retry(removed_batch, len(compact_input), truncated_count)
            except Exception: pass
        if not compact_input: return prefix_msgs + kept_tail, "exhausted_input_after_context_length"


def compact_via_api(
    history: list,
    system_prompt: str,
    model: str,
    token: str,
    account_id: str,
    base_url: str,
    timeout: float,
    keep_last_items: int = AUTO_COMPACT_KEEP_LAST_ITEMS,
    preserve_first_user_prompt: bool = False,
    allow_image_inputs: bool = True,
) -> Optional[list]:
    compacted, _reason = compact_via_api_with_reason(
        history,
        system_prompt,
        model,
        token,
        account_id,
        base_url,
        timeout,
        keep_last_items=keep_last_items,
        preserve_first_user_prompt=preserve_first_user_prompt,
        allow_image_inputs=allow_image_inputs,
    )
    return compacted
