import json, math
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from input_images import strip_input_images

MICRO_COMPACT_KEEP_LAST_TOOL_CALL_OUTPUTS = 48
MICRO_COMPACT_KEEP_LAST_APPLY_PATCH_INPUTS = 24
MICRO_COMPACT_MIN_TOOL_OUTPUT_CHARS = 1_500
MICRO_COMPACT_MIN_SAVED = 15_000
MICRO_COMPACT_MAX_SAVED = 30_000
MICRO_COMPACT_IMAGE_TOKENS = 5_000
MICRO_COMPACT_TRIGGER_INPUT_TOKENS = 230_000
PERSISTED_OUTPUT_OPEN = "<persisted-output>"
PERSISTED_OUTPUT_CLOSE = "</persisted-output>"
PERSISTED_INPUT_OPEN = "<persisted-input>"
PERSISTED_INPUT_CLOSE = "</persisted-input>"
OLD_TOOL_RESULT_CLEARED = "[Old tool result content cleared]"
TOOL_ORDER = ["Read", "LS", "Execute", "Grep", "Glob", "Edit", "WebSearch", "FetchUrl", "shell", "apply_patch", "web_search"]
ALLOWED_TOOL_NAMES = set(TOOL_ORDER)

def _json_loads(text: Any, default: Any = None) -> Any:
    if not isinstance(text, str): return default
    try: return json.loads(text)
    except Exception: return default

def _est_tokens_text(text: Any) -> int:
    try: return int(math.ceil(len(str(text)) / 4.0)) if text else 0
    except Exception: return 0

def _output_text_from_raw(raw: Any) -> str:
    if isinstance(raw, str) and isinstance(parsed := _json_loads(raw), dict) and "output" in parsed: return str(parsed.get("output") or "")
    return str(raw or "") if raw is not None else ""

def _is_compacted_text(text: Any) -> bool:
    return isinstance(text, str) and (
        PERSISTED_OUTPUT_OPEN in text
        or PERSISTED_INPUT_OPEN in text
        or text == OLD_TOOL_RESULT_CLEARED
    )

def _normalize_tool_name(name: str) -> str: return "Edit" if name == "MultiEdit" else name

def _archived_output_note(session_dir: Path, ref: Optional[str] = None) -> str:
    location = ref or f"{session_dir / '.old'} session files"
    return f"{PERSISTED_OUTPUT_OPEN}Tool result archived in {location}.{PERSISTED_OUTPUT_CLOSE}"

def _archived_input_note(session_dir: Path, ref: Optional[str] = None) -> str:
    location = ref or f"{session_dir / '.old'} session files"
    return f"{PERSISTED_INPUT_OPEN}Tool input archived in {location}.{PERSISTED_INPUT_CLOSE}"

def archived_tool_output_refs(archived_file: Path, compact_output_ids: set[str], compact_input_ids: set[str]) -> tuple[dict[str, str], dict[str, str]]:
    output_refs: dict[str, str] = {}
    input_refs: dict[str, str] = {}
    if not archived_file or not archived_file.is_file() or (not compact_output_ids and not compact_input_ids):
        return output_refs, input_refs
    resolved = str(archived_file.resolve())
    try:
        with archived_file.open("r", encoding="utf-8", errors="replace") as f:
            for line_no, raw in enumerate(f, 1):
                if not raw.strip(): continue
                obj = _json_loads(raw)
                if not isinstance(obj, dict): continue
                item = obj.get("payload") if obj.get("type") == "response_item" and isinstance(obj.get("payload"), dict) else obj
                if not isinstance(item, dict): continue
                itype = item.get("type")
                if itype in ("function_call_output", "custom_tool_call_output"):
                    call_id = str(item.get("call_id") or "")
                    if call_id in compact_output_ids and call_id not in output_refs:
                        output_refs[call_id] = f"{resolved}:{line_no}"
                if itype in ("custom_tool_call", "function_call"):
                    name = item.get("name")
                    call_id = str(item.get("call_id") or item.get("id") or "")
                    if name == "apply_patch" and call_id in compact_input_ids and call_id not in input_refs:
                        input_refs[call_id] = f"{resolved}:{line_no}"
                if itype == "message" and isinstance((content := item.get("content")), list):
                    for block in content:
                        if not (isinstance(block, dict) and block.get("type") == "tool_result"): continue
                        tid = str(block.get("tool_use_id") or block.get("toolUseId") or "")
                        if tid in compact_output_ids and tid not in output_refs:
                            output_refs[tid] = f"{resolved}:{line_no}"
    except Exception:
        return output_refs, input_refs
    return output_refs, input_refs

def _replace_output_note(raw: Any, note: str) -> Any:
    if isinstance(raw, str) and isinstance(parsed := _json_loads(raw), dict) and "output" in parsed:
        parsed["output"] = note
        return json.dumps(parsed, ensure_ascii=False)
    return note

def apply_compacted_output_refs(
    items: List[Dict[str, Any]],
    output_refs: dict[str, str],
    input_refs: dict[str, str],
    session_dir: Path,
) -> List[Dict[str, Any]]:
    if not output_refs and not input_refs: return items
    out: List[Dict[str, Any]] = []
    changed = False
    for item in items:
        if not isinstance(item, dict): out.append(item); continue
        itype = item.get("type")
        if itype in ("function_call_output", "custom_tool_call_output"):
            call_id = str(item.get("call_id") or "")
            if call_id in output_refs and _is_compacted_text(_output_text_from_raw(item.get("output"))):
                note = _archived_output_note(session_dir, output_refs[call_id])
                out.append({**item, "output": _replace_output_note(item.get("output"), note)}); changed = True; continue
        if itype == "message" and isinstance((content := item.get("content")), list):
            new_content, msg_changed = [], False
            for block in content:
                if not (isinstance(block, dict) and block.get("type") == "tool_result"):
                    new_content.append(block); continue
                tid = str(block.get("tool_use_id") or block.get("toolUseId") or "")
                if tid in output_refs and _is_compacted_text(block.get("content")):
                    note = _archived_output_note(session_dir, output_refs[tid])
                    new_content.append({**block, "content": note}); msg_changed = True; continue
                new_content.append(block)
            if msg_changed: out.append({**item, "content": new_content}); changed = True
            else: out.append(item)
            continue
        if itype in ("custom_tool_call", "function_call") and item.get("name") == "apply_patch":
            call_id = str(item.get("call_id") or item.get("id") or "")
            if call_id in input_refs and _is_compacted_text(item.get("input")):
                note = _archived_input_note(session_dir, input_refs[call_id])
                out.append({**item, "input": note}); changed = True; continue
        out.append(item)
    return out if changed else items

def _compact_output_text(raw: Any, session_dir: Path, ref: Optional[str] = None) -> Any:
    if _is_compacted_text(_output_text_from_raw(raw)): return raw
    note = _archived_output_note(session_dir, ref)
    if isinstance(raw, str) and isinstance(parsed := _json_loads(raw), dict) and "output" in parsed:
        parsed["output"] = note; return json.dumps(parsed, ensure_ascii=False)
    return note

def _compact_input_text(raw: Any, session_dir: Path, ref: Optional[str] = None) -> Any:
    if _is_compacted_text(raw): return raw
    return _archived_input_note(session_dir, ref)

def _compacted_output_ids_from_messages(messages: List[Dict[str, Any]]) -> List[str]:
    ids: List[str] = []
    for m in messages or []:
        if not isinstance(m, dict): continue
        if m.get("type") in ("function_call_output", "custom_tool_call_output") and _is_compacted_text(_output_text_from_raw(m.get("output"))):
            if (sid := str(m.get("call_id") or "")) and sid not in ids: ids.append(sid)
            continue
        if not isinstance((content := m.get("content")), list): continue
        for b in content:
            if not (isinstance(b, dict) and b.get("type") == "tool_result"): continue
            if not _is_compacted_text(b.get("content")): continue
            if (sid := str(b.get("tool_use_id") or b.get("toolUseId") or "")) and sid not in ids: ids.append(sid)
    return ids

def _compacted_apply_patch_ids_from_messages(messages: List[Dict[str, Any]]) -> List[str]:
    ids: List[str] = []
    for m in messages or []:
        if not isinstance(m, dict): continue
        if m.get("type") in ("custom_tool_call", "function_call") and m.get("name") == "apply_patch":
            if _is_compacted_text(m.get("input")):
                if (sid := str(m.get("call_id") or m.get("id") or "")) and sid not in ids: ids.append(sid)
    return ids

def _est_tokens_item(item: Dict[str, Any]) -> int:
    itype = item.get("type")
    if itype == "message": return sum(MICRO_COMPACT_IMAGE_TOKENS if c.get("type") in ("input_image", "input_image_url") else _est_tokens_text(c.get("text")) for c in (item.get("content") or []) if isinstance(c, dict))
    if itype in ("function_call", "custom_tool_call"): return _est_tokens_text(json.dumps(item, ensure_ascii=False))
    if itype in ("function_call_output", "custom_tool_call_output"): return _est_tokens_text(_output_text_from_raw(item.get("output")))
    if itype in ("reasoning", "compaction_summary", "compaction"): return _est_tokens_text(item.get("encrypted_content") or "")
    return _est_tokens_text(json.dumps(item, ensure_ascii=False))

def _micro_compact_usage_tokens(items: List[Dict[str, Any]]) -> int: return int(math.ceil(sum(_est_tokens_item(it) for it in items if isinstance(it, dict)) * 4 / 3))

def estimate_history_usage_tokens(items: List[Dict[str, Any]]) -> int:
    return _micro_compact_usage_tokens(items)

def _strip_images_with_saved_tokens(items: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], int]:
    stripped = strip_input_images(items)
    before = _micro_compact_usage_tokens(items)
    after = _micro_compact_usage_tokens(stripped)
    return stripped, max(before - after, 0)

def _assert_micro_compact_config() -> None:
    assert MICRO_COMPACT_MAX_SAVED > 0, "MICRO_COMPACT_MAX_SAVED must be > 0"
    assert 0 <= MICRO_COMPACT_MIN_SAVED < MICRO_COMPACT_MAX_SAVED, (
        "MICRO_COMPACT_MIN_SAVED must satisfy 0 <= MICRO_COMPACT_MIN_SAVED < MICRO_COMPACT_MAX_SAVED"
    )
    assert MICRO_COMPACT_MIN_TOOL_OUTPUT_CHARS >= 0, (
        "MICRO_COMPACT_MIN_TOOL_OUTPUT_CHARS must be >= 0"
    )

def _micro_compact_items(
    items: List[Dict[str, Any]],
    session_dir: Path,
    already_outputs: set[str],
    already_inputs: set[str],
    min_saved: Optional[int] = None,
) -> Tuple[List[Dict[str, Any]], bool, List[str], List[str], int, int]:
    _assert_micro_compact_config()
    original_items = items
    # User-provided image parts are expensive; trim them first during micro-compaction.
    items_no_images, image_saved = _strip_images_with_saved_tokens(items)
    image_changed = items_no_images != original_items
    items = items_no_images
    # We track call order once, then decide compaction on two channels:
    # (1) large shell outputs and (2) apply_patch inputs.
    call_order_all, call_seen = [], set()
    shell_order_all, shell_seen = [], set()
    output_tokens, patch_tokens = {}, {}
    patch_order, patch_seen = [], set()
    for it in items:
        if not isinstance(it, dict): continue
        if it.get("type") in ("function_call", "custom_tool_call") and (name := _normalize_tool_name(str(it.get("name") or ""))) in ALLOWED_TOOL_NAMES:
            if (tid := str(it.get("call_id") or "")) and tid not in call_seen:
                call_order_all.append(tid); call_seen.add(tid)
            if name == "shell" and tid and tid not in shell_seen:
                shell_order_all.append(tid); shell_seen.add(tid)
            if name == "apply_patch":
                if (tid := str(it.get("call_id") or it.get("id") or "")) and tid not in already_inputs and tid not in patch_seen:
                    patch_order.append(tid); patch_seen.add(tid)
                    if (input_text := it.get("input")): patch_tokens[tid] = _est_tokens_text(input_text)
        elif it.get("type") in ("function_call_output", "custom_tool_call_output") and (tid := str(it.get("call_id") or "")) in shell_seen and tid not in already_outputs:
            if (text := _output_text_from_raw(it.get("output"))) and (
                MICRO_COMPACT_MIN_TOOL_OUTPUT_CHARS <= 0 or len(text) >= MICRO_COMPACT_MIN_TOOL_OUTPUT_CHARS
            ):
                output_tokens[tid] = _est_tokens_text(text)
    if not shell_order_all and not patch_order and not already_outputs and not already_inputs and not image_changed:
        return items, False, [], [], 0, 0
    shell_order = [tid for tid in shell_order_all if tid not in already_outputs]
    # Keep a recent tail unmodified to preserve immediate local context for the next turn.
    keep_outputs = set(shell_order[-MICRO_COMPACT_KEEP_LAST_TOOL_CALL_OUTPUTS:])
    keep_inputs = set(patch_order[-MICRO_COMPACT_KEEP_LAST_APPLY_PATCH_INPUTS:])
    total = image_saved + sum(output_tokens.values()) + sum(patch_tokens.values())
    saved, compact_outputs, compact_inputs = 0, set(), set()
    for tid in call_order_all:
        if saved >= MICRO_COMPACT_MAX_SAVED: break
        if tid in output_tokens and tid not in keep_outputs:
            compact_outputs.add(tid); saved += output_tokens.get(tid, 0)
            if saved >= MICRO_COMPACT_MAX_SAVED: break
        if tid in patch_tokens and tid not in keep_inputs:
            compact_inputs.add(tid); saved += patch_tokens.get(tid, 0)
    saved += image_saved
    min_saved_required = MICRO_COMPACT_MIN_SAVED
    if min_saved is not None:
        try: min_saved_required = max(int(min_saved), 0)
        except Exception: min_saved_required = 0
    if saved < min_saved_required:
        if image_changed:
            items = original_items
            image_changed = False
        compact_outputs.clear(); compact_inputs.clear(); saved = 0
    # Merge newly selected ids with previously compacted ids (idempotent behavior).
    compact_output_ids = already_outputs | compact_outputs
    compact_input_ids = already_inputs | compact_inputs
    if not compact_output_ids and not compact_input_ids:
        return items, image_changed, [], [], total, saved
    out, changed = [], False
    for it in items:
        if not isinstance(it, dict): out.append(it); continue
        if it.get("type") in ("function_call_output", "custom_tool_call_output") and (tid := str(it.get("call_id") or "")) in compact_output_ids and it.get("output") and not _is_compacted_text(_output_text_from_raw(it.get("output"))):
            new_it = {**it, "output": _compact_output_text(it.get("output"), session_dir)}; out.append(new_it); changed = changed or (new_it["output"] != it.get("output")); continue
        if it.get("type") in ("custom_tool_call", "function_call") and it.get("name") == "apply_patch":
            tid = str(it.get("call_id") or it.get("id") or "")
            if tid in compact_input_ids and it.get("input") and not _is_compacted_text(it.get("input")):
                new_it = {**it, "input": _compact_input_text(it.get("input"), session_dir)}
                out.append(new_it); changed = changed or (new_it["input"] != it.get("input")); continue
        out.append(it)
    return out, changed, [tid for tid in shell_order if tid in compact_outputs], [tid for tid in patch_order if tid in compact_inputs], total, saved


def try_micro_compact_with_stats(
    history: list,
    session_dir: Path,
    min_saved: Optional[int] = None,
) -> tuple[bool, list, list[str], list[str], int]:
    if not isinstance(history, list) or not history:
        return False, history, [], [], 0
    compacted, changed, compact_output_ids, compact_input_ids, _, saved = _micro_compact_items(
        history,
        session_dir,
        set(_compacted_output_ids_from_messages(history)),
        set(_compacted_apply_patch_ids_from_messages(history)),
        min_saved=min_saved,
    )
    if not changed:
        return False, history, [], [], 0
    try:
        saved_tokens = max(int(saved), 0)
    except Exception:
        saved_tokens = 0
    return True, compacted, compact_output_ids, compact_input_ids, saved_tokens


def try_micro_compact(history: list, session_dir: Path, min_saved: Optional[int] = None) -> tuple[bool, list, list[str], list[str]]:
    changed, compacted, compact_output_ids, compact_input_ids, _ = try_micro_compact_with_stats(
        history,
        session_dir,
        min_saved=min_saved,
    )
    if not changed:
        return False, history, [], []
    return True, compacted, compact_output_ids, compact_input_ids
