from typing import Optional
import glob
import json
import os
import re
import shlex
import subprocess
from pathlib import Path


def read_text(path: Path) -> str: return path.read_text(encoding="utf-8", errors="replace")


def chrome_user_data_dir() -> str:
    home = Path.home()
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            return str(Path(local_app_data) / "Google" / "Chrome" / "User Data")
        return r"%LOCALAPPDATA%\Google\Chrome\User Data"
    if os.uname().sysname == "Darwin":
        return str(home / "Library" / "Application Support" / "Google" / "Chrome")
    return str(home / ".config" / "google-chrome")


def _chrome_profile_dir_sort_key(dirname: str) -> tuple[int, object]:
    if dirname == "Default": return 0, 0
    if match := re.match(r"^Profile (\d+)$", str(dirname or "").strip()):
        return 1, int(match.group(1))
    return 2, str(dirname or "").lower()


def _clean_prompt_label(value: object) -> str:
    if not isinstance(value, str): return ""
    return " ".join(value.split()).strip()


def chrome_profile_dir_map_text(max_items: int = 30) -> str:
    local_state_path = Path(chrome_user_data_dir()) / "Local State"
    try:
        local_state = json.loads(read_text(local_state_path))
    except Exception:
        return f"- unavailable (Chrome Local State not found at {local_state_path})"

    info_cache = ((local_state.get("profile") or {}).get("info_cache") or {})
    if not isinstance(info_cache, dict) or not info_cache:
        return f"- unavailable (no Chrome profiles found in {local_state_path})"

    records = []
    for dirname in sorted(info_cache, key=_chrome_profile_dir_sort_key):
        info = info_cache.get(dirname)
        if not isinstance(info, dict):
            continue
        user_name = _clean_prompt_label(info.get("user_name"))
        visible_name = (
            _clean_prompt_label(info.get("name"))
            or _clean_prompt_label(info.get("gaia_name"))
            or user_name
            or str(dirname)
        )
        records.append((str(dirname), visible_name, user_name))

    if not records:
        return f"- unavailable (no Chrome profiles found in {local_state_path})"

    parts = []
    for dirname, visible_name, user_name in records[: max(int(max_items or 0), 0) or 0]:
        label = visible_name
        if user_name and user_name.casefold() != visible_name.casefold():
            label = f"{visible_name} ({user_name})"
        parts.append(f"{dirname} -> {label}")
    hidden = len(records) - len(parts)
    if hidden > 0:
        parts.append(f"... còn {hidden} profile nữa")
    return ", ".join(parts)


def load_system_prompt(script_dir: Path) -> str:
    prompt = read_text(script_dir / "templates" / "instructions.md")
    replacements = {
        "M_PATH": str(script_dir.resolve()),
        "CHROME_USER_DATA_DIR": chrome_user_data_dir(),
        "CHROME_PROFILE_DIR_MAP": chrome_profile_dir_map_text(),
    }
    for src, dst in replacements.items():
        prompt = prompt.replace(src, dst)
    return prompt


def _tool_spec(script_dir: Path, name: str, txt_file: str, lark_file: str) -> dict:
    return {
        "type": "custom",
        "name": name,
        "description": read_text(script_dir / "templates" / txt_file),
        "format": {
            "type": "grammar",
            "syntax": "lark",
            "definition": read_text(script_dir / "templates" / lark_file),
        },
    }


def _function_tool_spec(script_dir: Path, name: str, txt_file: str, schema_file: str) -> dict:
    return {
        "type": "function",
        "name": name,
        "description": read_text(script_dir / "templates" / txt_file),
        "strict": False,
        "parameters": json.loads(read_text(script_dir / "templates" / schema_file)),
    }


def load_tool_specs(script_dir: Path) -> tuple[dict, dict]:
    shell_tool = _function_tool_spec(script_dir, "shell", "tool-shell.txt", "tool-shell.schema.json")
    apply_patch_tool = _tool_spec(script_dir, "apply_patch", "tool-apply_patch.txt", "tool-apply_patch.lark")
    return shell_tool, apply_patch_tool


def load_view_image_tool_spec(script_dir: Path) -> dict:
    return _function_tool_spec(
        script_dir,
        "view_image",
        "tool-view_image.txt",
        "tool-view_image.schema.json",
    )


def parse_xml_tag(text: str, tag: str) -> Optional[str]:
    open_tag = f"<{tag}>"
    close_tag = f"</{tag}>"
    start = text.find(open_tag)
    if start == -1: return None
    start += len(open_tag)
    end = text.find(close_tag, start)
    if end == -1: return None
    return text[start:end].strip()


def is_tag_wrapped_text(text: str, tag: str) -> bool:
    if not isinstance(text, str): return False
    normalized = str(tag or "").strip().lower()
    if not normalized: return False
    stripped = text.strip()
    lowered = stripped.lower()
    return lowered.startswith(f"<{normalized}>") and lowered.endswith(f"</{normalized}>")


def _message_input_text_parts(item: dict) -> list[dict]:
    if not (isinstance(item, dict) and item.get("type") == "message" and item.get("role") == "user"): return []
    content = item.get("content")
    if not isinstance(content, list): return []
    return [part for part in content if isinstance(part, dict) and part.get("type") == "input_text"]


def _first_message_input_text(item: dict) -> Optional[str]:
    parts = _message_input_text_parts(item)
    if not parts: return None
    text = parts[0].get("text")
    return text if isinstance(text, str) else None


def message_has_wrapped_tag(item: dict, tag: str) -> bool:
    return is_tag_wrapped_text(_first_message_input_text(item), tag)


def prune_tag_context_messages(history: list, tag: str) -> tuple[list, int]:
    if not isinstance(history, list): return history, 0
    out = []
    removed = 0
    for item in history:
        if message_has_wrapped_tag(item, tag):
            removed += 1
            continue
        out.append(item)
    return out, removed


def latest_environment_context_text(history: list) -> Optional[str]:
    return latest_tag_context_text(history, "environment_context")


def latest_environment_workdir(history: list) -> Optional[str]:
    if not (text := latest_environment_context_text(history)): return None
    return parse_xml_tag(text, "workdir") or parse_xml_tag(text, "cwd")


def latest_tag_context_text(history: list, tag: str) -> Optional[str]:
    for item in reversed(history):
        if is_tag_wrapped_text((text := _first_message_input_text(item)), tag):
            return text
    return None


def latest_keywords_context_text(history: list) -> Optional[str]:
    return latest_tag_context_text(history, "KEYWORDS")


def latest_flows_context_text(history: list) -> Optional[str]:
    return latest_tag_context_text(history, "FLOWS")


_CONTEXT_FILE_OPEN_RE = re.compile(r"<context_file\b([^>]*)>", flags=re.IGNORECASE | re.DOTALL)


def _context_file_attr(text: Optional[str], attr: str) -> Optional[str]:
    if not isinstance(text, str):
        return None
    match = _CONTEXT_FILE_OPEN_RE.search(text.strip())
    if not match:
        return None
    attrs = match.group(1) or ""
    attr_match = re.search(rf'\b{re.escape(attr)}\s*=\s*"([^"]*)"', attrs)
    if not attr_match:
        return None
    value = attr_match.group(1).strip()
    return value or None


def _existing_context_filepaths(history: Optional[list]) -> set[str]:
    seen = set()
    if not isinstance(history, list):
        return seen
    for item in history:
        if filepath := _context_file_attr(_first_message_input_text(item), "filepath"):
            try:
                seen.add(str(Path(filepath).expanduser().resolve()))
            except Exception:
                seen.add(filepath)
    return seen


def _split_ctx_refs(raw: Optional[str]) -> list[str]:
    if not isinstance(raw, str) or not raw.strip():
        return []
    raw = raw.strip()
    if raw.startswith("["):
        try:
            parsed = json.loads(raw)
        except Exception as exc:
            raise SystemExit(f"Invalid ctx JSON array: {exc}")
        if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
            raise SystemExit("ctx must be a JSON string array when using JSON syntax.")
        return [item.strip() for item in parsed if isinstance(item, str) and item.strip()]
    if "\n" in raw:
        return [line.strip() for line in raw.splitlines() if line.strip()]
    try:
        tokens = [token.strip() for token in shlex.split(raw) if token.strip()]
    except ValueError as exc:
        raise SystemExit(f"Invalid ctx value: {exc}")
    parts = []
    if tokens:
        for token in tokens:
            parts.extend(part.strip() for part in token.split(",") if part.strip())
    elif "," in raw:
        parts.extend(part.strip() for part in raw.split(",") if part.strip())
    return parts or [raw]


def _ctx_has_glob(path_ref: str) -> bool:
    return any(ch in str(path_ref or "") for ch in "*?[")


def _ctx_sort_key(path: Path, cwd: Path) -> tuple[int, str]:
    try:
        rel = path.relative_to(cwd)
        return 0, rel.as_posix()
    except ValueError:
        return 1, str(path)


def _is_probably_text_file(path: Path, sample_size: int = 4096) -> bool:
    try:
        with path.open("rb") as handle:
            sample = handle.read(sample_size)
    except Exception as exc:
        raise SystemExit(f"Failed to read context file {path}: {exc}")
    return b"\0" not in sample


def _iter_ctx_directory_files(directory: Path, cwd: Path) -> list[Path]:
    files = []
    for root, dirnames, filenames in os.walk(str(directory)):
        dirnames[:] = sorted(name for name in dirnames if not name.startswith("."))
        for name in sorted(filename for filename in filenames if not filename.startswith(".")):
            path = Path(root) / name
            if path.is_file() and _is_probably_text_file(path):
                files.append(path.resolve())
    return sorted(files, key=lambda path: _ctx_sort_key(path, cwd))


def _resolve_ctx_paths(path_ref: str, cwd: Path) -> list[Path]:
    ref = str(path_ref or "").strip()
    if not ref:
        return []
    if _ctx_has_glob(ref):
        pattern = Path(ref).expanduser()
        if not pattern.is_absolute():
            pattern = cwd / pattern
        candidates = [Path(match).resolve() for match in glob.glob(str(pattern), recursive=True)]
        if not candidates:
            raise SystemExit(f"ctx ref matched nothing: {ref}")
    else:
        base = Path(ref).expanduser()
        if not base.is_absolute():
            base = cwd / base
        candidate = base.resolve()
        if not candidate.exists():
            raise SystemExit(f"Context path not found: {candidate}")
        candidates = [candidate]

    files = []
    for candidate in sorted(candidates, key=lambda path: _ctx_sort_key(path, cwd)):
        if candidate.is_dir():
            files.extend(_iter_ctx_directory_files(candidate, cwd))
            continue
        if candidate.is_file() and _is_probably_text_file(candidate):
            files.append(candidate.resolve())
            continue
        if not _ctx_has_glob(ref):
            raise SystemExit(f"Context file looks binary: {candidate}")

    deduped = []
    seen = set()
    for path in files:
        path_text = str(path)
        if path_text in seen:
            continue
        seen.add(path_text)
        deduped.append(path)
    if not deduped:
        raise SystemExit(f"ctx ref resolved to no text files: {ref}")
    return deduped


def _numbered_file_text(text: str) -> str:
    lines = text.splitlines()
    if not lines:
        return ""
    width = len(str(len(lines)))
    return "\n".join(f"{idx:>{width}} | {line}" for idx, line in enumerate(lines, start=1))


def ctx_messages_from_env(ctx_value: Optional[str], cwd: Path, history: Optional[list] = None) -> list[dict]:
    refs = _split_ctx_refs(ctx_value)
    if not refs:
        return []
    messages = []
    seen_filepaths = _existing_context_filepaths(history)
    for ref in refs:
        for path in _resolve_ctx_paths(ref, cwd):
            path_text = str(path)
            if path_text in seen_filepaths:
                continue
            seen_filepaths.add(path_text)
            content = _numbered_file_text(path.read_text(encoding="utf-8", errors="replace"))
            text = f'<context_file filename="{path.name}" filepath="{path}">\n{content}\n</context_file>'
            messages.append({
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": text}],
            })
    return messages


def repo_root_for(cwd: Path) -> Path:
    repo_root = Path("/")
    try:
        proc = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=str(cwd), capture_output=True, text=True)
        if proc.returncode == 0 and (out := (proc.stdout or "").strip()): repo_root = Path(out)
    except Exception: pass
    return repo_root


def load_layered_md(cwd: Path, file_name: str, override_name: str) -> str:
    repo_root = repo_root_for(cwd)
    sections = []
    current = cwd
    while True:
        if (override := current / override_name).is_file(): sections.append(read_text(override))
        elif (base := current / file_name).is_file(): sections.append(read_text(base))
        if current == repo_root or current == current.parent: break
        current = current.parent
    return "\n\n".join(c for c in reversed(sections) if c)


def load_keywords_md(cwd: Path) -> str:
    return load_layered_md(cwd, "KEYWORDS.md", "KEYWORDS.override.md")


TOP_FLOWS_START = "<!-- TOP_FLOWS_START -->"
TOP_FLOWS_END = "<!-- TOP_FLOWS_END -->"
TOP_FLOWS_START_RE = re.compile(r"(?m)^<!--\s*TOP_FLOWS_START\s*-->\s*$")
TOP_FLOWS_END_RE = re.compile(r"(?m)^<!--\s*TOP_FLOWS_END\s*-->\s*$")
TOP_FLOW_HEADING = re.compile(r"(?m)^###\s+WF-\d+\s*$")
TOP_FLOW_ENTRY = re.compile(r"(?ms)^###\s+WF-\d+\s*\n.*?(?=^###\s+WF-\d+\s*\n|\Z)")
FULL_FLOWS_FALLBACK_MAX_LINES = 100


def extract_top_flows(markdown: str, max_items: int = 3) -> str:
    if not markdown: return ""
    if not (start_m := TOP_FLOWS_START_RE.search(markdown)): return ""
    if not (end_m := TOP_FLOWS_END_RE.search(markdown, start_m.end())): return ""
    block = markdown[start_m.end():end_m.start()].strip()
    if not block: return ""
    entries = [m.group(0).strip() for m in TOP_FLOW_ENTRY.finditer(block)]
    if entries:
        kept = max(int(max_items or 0), 0)
        body = "\n\n".join(entries[:kept]) if kept > 0 else ""
    elif TOP_FLOW_HEADING.search(block):
        body = ""
    else:
        body = block
    fallback_line = ""
    for line in block.splitlines():
        s = line.strip()
        if s and s.lower().startswith("if the task "):
            fallback_line = s
            break
    if fallback_line and fallback_line in body:
        fallback_line = ""
    parts = [p for p in (body.strip(), fallback_line) if p]
    return "\n\n".join(parts)


def _line_count(text: str) -> int:
    if not text: return 0
    return len(text.splitlines())


def load_flows_md(cwd: Path, max_items: int = 3) -> str:
    if (env := os.environ.get("flows_max_items")):
        try: max_items = int(env)
        except Exception: pass
    flows_md = load_layered_md(cwd, "FLOWS.md", "FLOWS.override.md")
    top_flows = extract_top_flows(flows_md, max_items=max_items)
    if (
        flows_md.strip()
        and not TOP_FLOW_HEADING.search(top_flows)
        and _line_count(flows_md) < FULL_FLOWS_FALLBACK_MAX_LINES
    ):
        # If shortlist extraction yields no flows, include the full FLOWS.md when it's small enough.
        return flows_md.strip()
    return top_flows


def keywords_context_item(cwd: Path, keywords_content: str) -> dict:
    text = "\n".join(
        [
            "<KEYWORDS>",
            "",
            f"# KEYWORDS.md for {cwd}",
            keywords_content,
            "</KEYWORDS>",
        ]
    )
    return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}


def flows_context_item(cwd: Path, flows_content: str) -> dict:
    text = "\n".join(
        [
            "<FLOWS>",
            "",
            "After finishing all work, re-read FLOWS.md and update it with improvements from this session.",
            "",
            f"# FLOWS.md for {cwd}",
            flows_content,
            "</FLOWS>",
        ]
    )
    return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}


def _du_path_rank(path: str) -> int:
    if "/" not in path: return 0
    if path.startswith("src/"): return 1
    if path.startswith("doc/"): return 2
    if path.startswith("docs/"): return 3
    if path.startswith("scripts/"): return 4
    if path.startswith("tests/"): return 5
    return 6


def _sort_du_lines(lines: list[str]) -> list[str]:
    return sorted(
        lines,
        key=lambda line: _du_path_rank(line.split("\t", 1)[-1].lstrip("./")),
    )


def du_ah_summary(workdir: Path, timeout_seconds: float = 8.0, max_depth: int = 2, max_files: int = 200) -> Optional[str]:
    if (env := os.environ.get("du_max_files")):
        try: max_files = int(env)
        except Exception: pass
    try:
        git_du_cmd = "git ls-files -co --exclude-standard -z | du -ah --files0-from=-"
        res = subprocess.run(git_du_cmd, cwd=str(workdir), shell=True, executable="/bin/bash", capture_output=True, text=True, errors="replace", timeout=timeout_seconds)
        if res.returncode == 0 and (output := (res.stdout or "").strip()):
            lines = output.splitlines()
            if max_depth is not None:
                filtered = []
                for line in lines:
                    p = line.split("\t", 1)[-1].lstrip("./")
                    if (p.count("/") + 1) <= max_depth:
                        filtered.append(line)
                lines = filtered
            lines = _sort_du_lines(lines)
            if max_files is not None: lines = lines[:max_files]
            header = [
                f"# cmd: {git_du_cmd} (cwd={workdir})",
                "# note: file list = tracked + untracked (non-ignored); similar to ls -la minus ignored/permission/owner fields.",
            ]
            output = "\n".join(header + lines)
            return output
    except Exception: pass
    try:
        du_cmd = ["du", "-ah", f"--max-depth={max_depth}", "--exclude=.git", "--exclude=.git/*"] + ([f"--exclude-from={workdir / '.gitignore'}"] if (workdir / ".gitignore").is_file() else []) + ["--", "."]
        output = (subprocess.run(du_cmd, cwd=str(workdir), capture_output=True, text=True, errors="replace", timeout=timeout_seconds).stdout or "").strip()
        if output:
            lines = output.splitlines()
            lines = _sort_du_lines(lines)
            if max_files is not None: lines = lines[:max_files]
            output = "\n".join(lines)
        if output:
            cmd_str = " ".join(shlex.quote(c) for c in du_cmd)
            output = "\n".join(
                [
                    f"# cmd: {cmd_str} (cwd={workdir})",
                    output,
                ]
            )
        return output if output else None
    except Exception: return None


def ls_la_summary(workdir: Path, timeout_seconds: float = 4.0) -> Optional[str]:
    cmd = ["ls", "-la"]
    try:
        res = subprocess.run(cmd, cwd=str(workdir), capture_output=True, text=True, errors="replace", timeout=timeout_seconds)
        if res.returncode != 0: return None
        if not (output := (res.stdout or "").strip()): return None
        header = [f"# cmd: {' '.join(shlex.quote(c) for c in cmd)} (cwd={workdir})"]
        return "\n".join(header + output.splitlines())
    except Exception: return None


def environment_context_item(
    workdir: Path,
    shell_name: str = "bash",
    du_output: Optional[str] = None,
    ls_output: Optional[str] = None,
) -> dict:
    lines = ["<environment_context>", f"  <workdir>{workdir}</workdir>", f"  <shell>{shell_name}</shell>"]
    if ls_output:
        lines.append("  <ls_la>")
        lines.extend(f"    {line}" for line in ls_output.splitlines())
        lines.append("  </ls_la>")
    if du_output:
        lines.append("  <du_ah>")
        lines.extend(f"    {line}" for line in du_output.splitlines())
        lines.append("  </du_ah>")
    lines.append("</environment_context>")
    text = "\n".join(lines)
    return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}


def build_context_updates(history: list, cwd: Path, shell_name: str = "bash") -> tuple[list, str, str]:
    updates = []
    if not latest_keywords_context_text(history):
        if (keywords_content := load_keywords_md(cwd)):
            updates.append(keywords_context_item(cwd, keywords_content))
    if not latest_flows_context_text(history):
        if (flows_content := load_flows_md(cwd)):
            updates.append(flows_context_item(cwd, flows_content))
    prev_workdir = latest_environment_workdir(history)
    fixed_workdir = prev_workdir or str(cwd)
    fixed_shell = shell_name
    if not prev_workdir:
        du_output = du_ah_summary(Path(fixed_workdir))
        ls_output = ls_la_summary(Path(fixed_workdir))
        updates.append(
            environment_context_item(
                Path(fixed_workdir),
                fixed_shell,
                du_output=du_output,
                ls_output=ls_output,
            )
        )
    return updates, fixed_workdir, fixed_shell
