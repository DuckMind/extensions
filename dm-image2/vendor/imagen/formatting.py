from typing import Optional
import re
from pathlib import Path

PREVIEW_MAX_LINES = 50


def _split_string(s: str, left_budget: int, right_budget: int) -> tuple[int, str, str]:
    if not s: return 0, "", ""
    total_bytes = len(s_bytes := s.encode("utf-8"))
    if total_bytes <= left_budget + right_budget: return 0, s, ""
    prefix_end = 0
    suffix_start = total_bytes
    removed_chars = 0
    suffix_started = False
    byte_index = 0
    tail_start_target = total_bytes - right_budget
    for ch in s:
        ch_len = len(ch.encode("utf-8"))
        char_end = byte_index + ch_len
        if char_end <= left_budget: prefix_end = char_end; byte_index = char_end; continue
        if byte_index >= tail_start_target:
            if not suffix_started: suffix_start = byte_index; suffix_started = True
            byte_index = char_end; continue
        removed_chars += 1; byte_index = char_end
    if suffix_start < prefix_end: suffix_start = prefix_end
    before = s_bytes[:prefix_end].decode("utf-8", errors="replace")
    after = s_bytes[suffix_start:].decode("utf-8", errors="replace")
    return removed_chars, before, after


def _truncate_with_byte_estimate(s: str, max_bytes: int) -> str:
    if not s: return ""
    if max_bytes == 0: return f"…{len(s)} chars truncated…"
    if len(s_bytes := s.encode("utf-8")) <= max_bytes: return s
    left_budget = max_bytes // 2
    removed_chars, left, right = _split_string(s, left_budget, max_bytes - left_budget)
    return f"{left}…{removed_chars} chars truncated…{right}"


def _format_duration_seconds(duration_seconds: float) -> str:
    return f"{(int(duration_seconds * 10.0 + 0.5) / 10.0):g}"


def _truncate_preview_by_lines(text: str, max_lines: int = PREVIEW_MAX_LINES) -> str:
    if not text: return text
    lines = text.splitlines()
    if len(lines) <= max_lines: return text
    return "\n".join(lines[:max_lines]) + f"\n…{len(lines) - max_lines} lines truncated…"


def format_exec_output(exit_code: int, duration_seconds: float, output_text: str, workdir: Optional[Path] = None, total_lines: Optional[int] = None) -> str:
    return "\n".join(
        [f"Exit code: {exit_code}", f"Wall time: {_format_duration_seconds(duration_seconds)} seconds"]
        + ([f"Workdir: {workdir}"] if workdir is not None else [])
        + ([f"Total output lines: {total_lines}"] if total_lines is not None else [])
        + ["Output:", output_text]
    )


def _format_shell_output(exit_code: int, duration_seconds: float, timed_out: bool, aggregated_output: str, workdir: Optional[Path] = None, max_bytes: int = 90000) -> str:
    duration_str = _format_duration_seconds(duration_seconds)
    content = f"command timed out after {duration_str} seconds\n{aggregated_output}" if timed_out else aggregated_output
    formatted = _truncate_with_byte_estimate(content, max_bytes)
    total_lines = len(content.splitlines())
    return format_exec_output(exit_code, duration_seconds, formatted, workdir, total_lines if total_lines != len(formatted.splitlines()) else None)


def usage_text_from_response(response_obj: Optional[dict]) -> str:
    if not isinstance(response_obj, dict): return "n/a"
    if not isinstance((usage := response_obj.get("usage")), dict): return "n/a"
    cached = usage.get("input_tokens_details", {}).get("cached_tokens")
    think = usage.get("output_tokens_details", {}).get("reasoning_tokens")
    return f"{{in: {usage.get('input_tokens')}, cached: {cached}, out: {usage.get('output_tokens')}, think: {think}}}"

def render_markdown(text: str) -> str:
    """Render markdown using pygments - keeps markers, adds colors."""
    try:
        from pygments import highlight
        from pygments.lexers import MarkdownLexer
        from pygments.formatters import Terminal256Formatter
        return highlight(text, MarkdownLexer(), Terminal256Formatter(style='monokai')).rstrip()
    except ImportError:
        return text


def _highlight_with_pygments(text: str, lexer_factory) -> str:
    if not text: return ""
    try:
        from pygments import highlight
        from pygments.formatters import Terminal256Formatter
        lexer = lexer_factory()
        return highlight(text, lexer, Terminal256Formatter(style="monokai")).rstrip()
    except ImportError:
        return text
    except Exception:
        return text


def format_patch_preview(text: str) -> str:
    if not text: return ""
    try:
        from pygments.lexers import DiffLexer
    except ImportError:
        return text
    return _highlight_with_pygments(text, DiffLexer)


def format_shell_preview(text: str) -> str:
    if not text: return ""
    try:
        from pygments.lexers import BashLexer
    except ImportError:
        return text
    return _highlight_with_pygments(text, BashLexer)


def format_thinking(text: str, underline_on: str, underline_off: str) -> str:
    normalized = " ".join(str(text).split())
    return re.sub(r"\*\*(.+?)\*\*", lambda match: f"{underline_on}{match.group(1)}{underline_off}", normalized)


def truncate_middle_line(text: str, max_chars: int = 100) -> str:
    if not text: return ""
    line = " ".join(str(text).split())
    if max_chars <= 0: return ""
    if len(line) <= max_chars: return line
    if max_chars == 1: return "…"
    left_len = (max_chars - 1) // 2
    right_len = max_chars - 1 - left_len
    return f"{line[:left_len]}…{line[-right_len:]}"
