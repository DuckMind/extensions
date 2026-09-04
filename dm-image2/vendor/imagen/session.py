#!/usr/bin/env python3
from typing import Callable, List, Optional, Tuple
import atexit, errno, json, os, shutil, tempfile, time, fcntl
from pathlib import Path

import micro_compact as mc

OLD_SESSIONS_MAX_KEEP = 100
SESSION_LOCK = None


def env_flag(name: str, default: str = "0") -> bool:
    value = os.environ.get(name, default)
    if value is None: return False
    return str(value).strip().lower() in ("1", "true", "yes", "y", "on")


def _nonempty_str(value) -> Optional[str]:
    if not isinstance(value, str): return None
    value = value.strip()
    return value or None


def _sanitize_history_item(item):
    if not isinstance(item, dict): return item
    typ = item.get("type")
    data = dict(item)
    if typ in ("function_call", "custom_tool_call"):
        if not (name := _nonempty_str(data.get("name"))): return None
        if not (call_id := _nonempty_str(data.get("call_id"))):
            call_id = _nonempty_str(data.get("id"))
        if not call_id: return None
        data["name"] = name
        data["call_id"] = call_id
        return data
    if typ in ("function_call_output", "custom_tool_call_output"):
        if not (call_id := _nonempty_str(data.get("call_id"))): return None
        data["call_id"] = call_id
    return data


def _json_size(value) -> int:
    try: return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    except Exception: return len(str(value))


def _history_item_key(item):
    if not isinstance(item, dict): return None
    if item_id := _nonempty_str(item.get("id")):
        return ("id", item_id)
    if item.get("type") in ("function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"):
        if call_id := _nonempty_str(item.get("call_id")):
            return (item.get("type"), call_id)
    return None


def _merge_duplicate_history_item(existing, incoming):
    if not isinstance(existing, dict): return incoming
    if not isinstance(incoming, dict): return existing
    merged = dict(existing)
    for key, value in incoming.items():
        if value is None: continue
        current = merged.get(key)
        if isinstance(value, str):
            if key in ("arguments", "input", "output", "encrypted_content"):
                if not isinstance(current, str) or len(value) > len(current): merged[key] = value
            elif not isinstance(current, str) or not current.strip():
                merged[key] = value
            continue
        if isinstance(value, list):
            if not isinstance(current, list) or _json_size(value) > _json_size(current): merged[key] = value
            continue
        if isinstance(value, dict):
            if not isinstance(current, dict) or _json_size(value) > _json_size(current): merged[key] = value
            continue
        if key not in merged or merged.get(key) is None:
            merged[key] = value
    return merged


def dedupe_history_items(items: list) -> list:
    if not isinstance(items, list) or not items: return items
    out = []
    seen = {}
    for item in items:
        if (key := _history_item_key(item)) is None:
            out.append(item)
            continue
        if key not in seen:
            seen[key] = len(out)
            out.append(item)
            continue
        out[seen[key]] = _merge_duplicate_history_item(out[seen[key]], item)
    return out

def release_session_lock() -> None:
    global SESSION_LOCK
    if SESSION_LOCK is None: return
    if fcntl is not None:
        try: fcntl.flock(SESSION_LOCK.fileno(), fcntl.LOCK_UN)
        except Exception: pass
    try: SESSION_LOCK.close()
    except Exception: pass
    SESSION_LOCK = None

def acquire_session_lock(session_file: Path) -> None:
    global SESSION_LOCK
    if SESSION_LOCK is not None: return
    if fcntl is None or env_flag("no_session_lock"): return
    lock_path = session_file.with_suffix(session_file.suffix + ".lock")
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_file = lock_path.open("a+")
    except Exception as exc:
        raise SystemExit(f"Failed to open session lock {lock_path}: {exc}")
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        if exc.errno in (errno.EACCES, errno.EAGAIN):
            try: lock_file.close()
            except Exception: pass
            raise SystemExit(
                f"Session is locked: {lock_path} (another process is using this session)."
            )
        try: lock_file.close()
        except Exception: pass
        raise SystemExit(f"Failed to lock session file {lock_path}: {exc}")
    except Exception as exc:
        try: lock_file.close()
        except Exception: pass
        raise SystemExit(f"Failed to lock session file {lock_path}: {exc}")
    SESSION_LOCK = lock_file
    atexit.register(release_session_lock)

def normalize_history_items(items: list) -> list:
    if not isinstance(items, list) or not items: return items
    items = dedupe_history_items([clean for it in items if (clean := _sanitize_history_item(it)) is not None])
    def ids_of(typ: str) -> set[str]:
        return {it.get("call_id") for it in items if isinstance(it, dict) and it.get("type") == typ and isinstance(it.get("call_id"), str)}
    out_map = {
        "function_call": ("function_call_output", ids_of("function_call_output")),
        "custom_tool_call": ("custom_tool_call_output", ids_of("custom_tool_call_output")),
    }
    out = []
    for it in items:
        out.append(it)
        if isinstance(it, dict) and (t := it.get("type")) in out_map and isinstance((cid := it.get("call_id")), str) and cid and cid not in out_map[t][1]:
            out.append({"type": out_map[t][0], "call_id": cid, "output": "aborted"})
    call_ids = {"function_call": ids_of("function_call"), "custom_tool_call": ids_of("custom_tool_call")}
    out_to_call = {"function_call_output": "function_call", "custom_tool_call_output": "custom_tool_call"}
    return [it for it in out if not (isinstance(it, dict) and (t := it.get("type")) in out_to_call and it.get("call_id") not in call_ids[out_to_call[t]])]

def load_history(path: Path) -> list:
    if not path.is_file(): return []
    items = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not (s := line.strip()): continue
        try: obj = json.loads(s)
        except Exception: continue
        if isinstance(obj, dict) and obj.get("type") == "web_search_call_output": continue
        if isinstance(obj, dict): items.append(obj)
    return normalize_history_items(items)

def append_history(path: Path, items: list) -> None:
    if not items: return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f: f.writelines(json.dumps(item, ensure_ascii=False) + "\n" for item in items)

def rewrite_history(path: Path, items: list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f: f.writelines(json.dumps(item, ensure_ascii=False) + "\n" for item in items)

def prune_old_sessions(old_dir: Path, keep_last: int = OLD_SESSIONS_MAX_KEEP) -> None:
    try: keep_last = int(keep_last)
    except Exception: return
    if keep_last < 1 or not old_dir.is_dir(): return
    try:
        archives = [p for p in old_dir.glob("session-*.jsonl") if p.is_file()]
    except Exception:
        return
    if len(archives) <= keep_last: return
    try:
        archives.sort(key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True)
    except Exception:
        return
    for stale in archives[keep_last:]:
        try: stale.unlink()
        except Exception: pass

def archive_session(path: Path) -> Optional[Path]:
    if not path.is_file(): return None
    old_dir = path.parent / ".old"
    old_dir.mkdir(parents=True, exist_ok=True)
    ts = int(time.time())
    stamp = time.time_ns()
    archived_path = old_dir / f"session-{ts}-{stamp}.jsonl"
    while archived_path.exists():
        stamp += 1
        archived_path = old_dir / f"session-{ts}-{stamp}.jsonl"
    path.replace(archived_path)
    prune_old_sessions(old_dir, keep_last=OLD_SESSIONS_MAX_KEEP)
    return archived_path

def prompt_cache_key_for_session(session_file: Path) -> Optional[str]:
    try:
        session_file.parent.mkdir(parents=True, exist_ok=True)
        session_file.touch(exist_ok=True)
        st = session_file.stat()
        return f"mai-{st.st_dev}-{st.st_ino}"
    except Exception: return None

def resolve_session_path(raw: str, cwd: Path) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute(): path = cwd / path
    if path.exists() and path.is_dir(): return path / "session.jsonl"
    return path


def resolve_fork_paths(raw: str, cwd: Path) -> Tuple[Path, Path]:
    source_raw, sep, dest_raw = str(raw or "").partition("=>")
    source_raw = source_raw.strip()
    dest_raw = dest_raw.strip()
    usage = "Use session=fork:/src=>/dest"
    new2_hint = "If you want to fork the current .m/session.jsonl to /tmp, use n=4."
    if not sep:
        raise SystemExit(f"Old session=fork shorthand was removed. {usage}. {new2_hint}")
    if not source_raw:
        raise SystemExit(f"session=fork is missing the source path before =>. {usage}.")
    if not dest_raw:
        raise SystemExit(f"session=fork is missing the destination path after =>. {usage}.")
    source = resolve_session_path(source_raw, cwd)
    dest = resolve_session_path(dest_raw, cwd)
    if not source.is_file():
        raise SystemExit(f"Fork source session not found: {source}")
    if source.resolve() == dest.resolve():
        raise SystemExit("Fork source and destination must differ.")
    return source, dest

def fork_session_file(source: Path, dest: Optional[Path] = None) -> Path:
    if dest is None:
        tmp_dir = Path(tempfile.mkdtemp(prefix="m-session-", dir="/tmp"))
        dest = tmp_dir / "session.jsonl"
    elif dest.exists() and dest.is_dir():
        dest = dest / "session.jsonl"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if source.is_file(): shutil.copyfile(source, dest)
    return dest

def latest_assistant_text_from_history(history: list) -> Optional[str]:
    if not isinstance(history, list): return None
    for item in reversed(history):
        if not isinstance(item, dict): continue
        if item.get("type") != "message" or item.get("role") != "assistant": continue
        content = item.get("content")
        if isinstance(content, str):
            if (text := content.strip()): return text
            continue
        if not isinstance(content, list): continue
        texts = []
        for part in content:
            if not isinstance(part, dict): continue
            ptype = part.get("type")
            text = part.get("text")
            if ptype != "output_text" or not isinstance(text, str) or not text: continue
            texts.append(text)
        if (merged := "\n".join(texts).strip()): return merged
    return None

def latest_assistant_text_from_session(session_file: Path) -> Optional[str]:
    try:
        history = load_history(session_file)
    except Exception:
        return None
    return latest_assistant_text_from_history(history)

def init_session(new_mode: str, session_opt: str, cwd: Path) -> Tuple[Path, list]:
    session_file = cwd / ".m" / "session.jsonl"
    if session_opt:
        if new_mode != "0": raise SystemExit("Do not combine session= with n=. Use one or the other.")
        session_cmd, _, session_arg = session_opt.partition(":")
        if session_cmd in ("fork", "new", "resume"):
            if session_cmd == "fork":
                source, dest = resolve_fork_paths(session_arg, cwd)
                session_file = fork_session_file(source, dest)
                acquire_session_lock(session_file)
                history = load_history(session_file)
            else:
                raw_path = session_arg.strip()
                target = resolve_session_path(raw_path, cwd) if raw_path else session_file
                if session_cmd == "new":
                    session_file = target
                    acquire_session_lock(session_file)
                    if target.is_file(): archive_session(target)
                    rewrite_history(target, [])
                    history = []
                else:  # resume
                    session_file = target
                    acquire_session_lock(session_file)
                    history = load_history(session_file)
        else:
            session_file = resolve_session_path(session_opt, cwd)
            acquire_session_lock(session_file)
            history = load_history(session_file)
    else:
        if new_mode in ("2", "4"):
            session_file = fork_session_file(session_file)
            acquire_session_lock(session_file)
            history = load_history(session_file)
        elif new_mode == "1":
            acquire_session_lock(session_file)
            if session_file.is_file(): archive_session(session_file)
            rewrite_history(session_file, [])
            history = []
        else:
            acquire_session_lock(session_file)
            history = load_history(session_file)
    return session_file, history

def apply_compaction_result(
    compacted_history: list,
    session_file: Path,
    compact_ids: Optional[Tuple[List[str], List[str]]],
    rebuild_environment_context: Callable[[list], list],
) -> list:
    history = compacted_history
    archived_path = archive_session(session_file)
    if archived_path and compact_ids:
        compact_output_ids, compact_input_ids = compact_ids
        output_refs, input_refs = mc.archived_tool_output_refs(
            archived_path,
            set(compact_output_ids or []),
            set(compact_input_ids or []),
        )
        if output_refs or input_refs:
            history = mc.apply_compacted_output_refs(history, output_refs, input_refs, session_file.parent)
    history = rebuild_environment_context(history)
    rewrite_history(session_file, history)
    return history
