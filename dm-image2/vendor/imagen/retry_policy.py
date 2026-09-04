from typing import Optional
import random
import re


def parse_float(value) -> Optional[float]:
    try: return float(value)
    except Exception: return None


def _iter_error_dicts(payload):
    if not isinstance(payload, dict):
        return ()
    response = payload.get("response")
    return (
        err
        for err in (
            payload.get("error"),
            response.get("error") if isinstance(response, dict) else None,
        )
        if isinstance(err, dict)
    )


def _stream_terminal_event(payload) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    dbg = payload.get("_stream_debug")
    if not isinstance(dbg, dict):
        return None
    extra = dbg.get("extra")
    if not isinstance(extra, dict):
        return None
    event = extra.get("terminal_event")
    return event if isinstance(event, str) and event else None


CONTEXT_LENGTH_ERROR_MARKERS = (
    "context_length_exceeded",
    "context window",
    "context length",
    "maximum context length",
    "reduce the length of the messages",
)


def _error_message_text(err: dict) -> str:
    if not isinstance(err, dict):
        return ""
    for key in ("message", "detail", "error_description"):
        if isinstance((value := err.get(key)), str) and value.strip():
            return value.strip()
    return ""


def _error_param_targets_input(err: dict) -> bool:
    if not isinstance(err, dict):
        return False
    param = err.get("param")
    if param is None:
        return True
    if not isinstance(param, str):
        return False
    value = param.strip().lower()
    return not value or value == "input" or value.startswith("input[")


def _error_is_context_length_exceeded(err: dict) -> bool:
    if not isinstance(err, dict):
        return False
    for key in ("code", "type"):
        if isinstance((value := err.get(key)), str) and value.strip() == "context_length_exceeded":
            return True
    message = _error_message_text(err).lower()
    if not message:
        return False
    if not any(marker in message for marker in CONTEXT_LENGTH_ERROR_MARKERS):
        return False
    return _error_param_targets_input(err)


def is_context_length_exceeded_payload(payload) -> bool:
    return any(_error_is_context_length_exceeded(err) for err in _iter_error_dicts(payload))


def _error_code_from_error(err: dict) -> Optional[str]:
    if not isinstance(err, dict):
        return None
    if _error_is_context_length_exceeded(err):
        return "context_length_exceeded"
    for key in ("code", "type"):
        if isinstance((value := err.get(key)), str) and value:
            return value
    return None


def error_code_from_payload(payload) -> Optional[str]:
    for err in _iter_error_dicts(payload):
        if (code := _error_code_from_error(err)) is not None:
            return code
    return None


def error_status_from_payload(payload) -> Optional[int]:
    for err in _iter_error_dicts(payload):
        for key in ("status", "status_code"):
            try:
                value = int(err.get(key))
                if value > 0: return value
            except Exception:
                pass
    return None


def stream_backoff_delay(attempt: int, base_seconds: float, max_seconds: Optional[float] = None, jitter_ratio: float = 0.1) -> float:
    if attempt <= 0: return 0.0
    delay = base_seconds * (2.0 ** (attempt - 1))
    if isinstance(max_seconds, (int, float)) and max_seconds > 0: delay = min(delay, max_seconds)
    if jitter_ratio and delay > 0:
        span = delay * float(jitter_ratio)
        delay = max(0.0, random.uniform(delay - span, delay + span))
    return delay


def retry_delay_from_error(err: dict) -> Optional[float]:
    for key in ("retry_after", "retry_after_seconds", "retry_after_sec", "retry_after_s"):
        if key in err and (seconds := parse_float(err.get(key))) is not None: return max(0.0, seconds)
    if "retry_after_ms" in err and (ms := parse_float(err.get("retry_after_ms"))) is not None: return max(0.0, ms / 1000.0)
    if isinstance((message := err.get("message")), str) and (m := re.search(r"(?i)try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)", message)):
        value = float(m.group(1))
        unit = m.group(2).lower()
        return value / 1000.0 if unit == "ms" else value
    return None


NON_RETRYABLE_CODES = {"context_length_exceeded", "invalid_prompt", "invalid_request", "invalid_request_error", "insufficient_quota", "authentication_error", "permission_denied", "not_found", "model_not_found", "usage_not_included", "token_invalidated", "token_revoked", "usage_limit_reached", "token_expired"}
HARD_NON_RETRYABLE_CODES = {"token_invalidated", "token_revoked", "usage_limit_reached", "token_expired"}
RETRYABLE_CODES = {"rate_limit_exceeded", "server_error", "internal_server_error", "service_unavailable", "timeout", "request_timeout"}
RETRYABLE_STATUSES = {408, 429, 500, 502, 503, 504, 507, 520, 521, 522, 523, 524}
TRANSIENT_MARKERS = (
    "timed out",
    "timeout",
    "connection reset",
    "connection aborted",
    "connection refused",
    "temporarily unavailable",
    "server error",
    "internal server error",
    "bad gateway",
    "gateway timeout",
    "service unavailable",
    "you can retry your request",
)


def retry_delay(payload, attempt: int, base_seconds: float, rate_limit_base: float, max_seconds: Optional[float] = None) -> Optional[float]:
    if not isinstance(payload, dict): return None
    if _stream_terminal_event(payload) == "stream_end":
        return stream_backoff_delay(attempt, base_seconds, max_seconds=max_seconds)
    code = error_code_from_payload(payload)
    err = payload.get("error")
    if isinstance(err, dict) and err.get("retryable") is True and code in NON_RETRYABLE_CODES and code not in HARD_NON_RETRYABLE_CODES: code = None
    if code in NON_RETRYABLE_CODES: return None
    if isinstance(err, dict) and str(err.get("message") or "") in ("Stream ended without completion", "stream closed before response.completed"):
        return stream_backoff_delay(attempt, base_seconds, max_seconds=max_seconds)
    if (seconds := parse_float(payload.get("retry_after"))) is not None: return max(0.0, seconds)

    retryable = code in RETRYABLE_CODES
    rate_limit = code == "rate_limit_exceeded"
    msg = None
    for e in _iter_error_dicts(payload):
        if (delay := retry_delay_from_error(e)) is not None: return delay
        status = e.get("status") or e.get("status_code")
        try: status = int(status)
        except Exception: status = None
        if status in RETRYABLE_STATUSES: retryable = True
        if status == 429: rate_limit = True
        if msg is None:
            m = e.get("message")
            if isinstance(m, str) and m.strip(): msg = m
        if e.get("retryable") is True: retryable = True
    if msg:
        msg_l = msg.lower()
        if "rate limit" in msg_l: rate_limit = True
        if any(marker in msg_l for marker in TRANSIENT_MARKERS): retryable = True
    if not retryable: return None
    base = rate_limit_base if rate_limit else base_seconds
    return stream_backoff_delay(attempt, base, max_seconds=max_seconds)


def compact_retry_delay(
    payload,
    attempt: int,
    base_seconds: float,
    max_seconds: Optional[float] = None,
    retry_429: bool = False,
) -> Optional[float]:
    delay = retry_delay(payload, attempt, base_seconds, base_seconds, max_seconds=max_seconds)
    if delay is None: return None
    status = error_status_from_payload(payload)
    code = error_code_from_payload(payload)
    if not retry_429 and (status == 429 or code == "rate_limit_exceeded"): return None
    return delay
