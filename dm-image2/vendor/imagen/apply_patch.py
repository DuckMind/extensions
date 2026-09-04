import os
from pathlib import Path

BEGIN_PATCH_MARKER = "*** Begin Patch"
END_PATCH_MARKER = "*** End Patch"
ADD_FILE_MARKER = "*** Add File: "
DELETE_FILE_MARKER = "*** Delete File: "
UPDATE_FILE_MARKER = "*** Update File: "
MOVE_TO_MARKER = "*** Move to: "
EOF_MARKER = "*** End of File"
CHANGE_CONTEXT_MARKER = "@@ "
EMPTY_CHANGE_CONTEXT_MARKER = "@@"

_UNICODE_REPLACEMENTS = {
    # Dashes -> '-'
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-",
    "\u2014": "-", "\u2015": "-", "\u2212": "-",
    # Smart quotes -> ASCII
    "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201B": "'",
    "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u201F": '"',
    # Special spaces -> ' '
    "\u00A0": " ", "\u2002": " ", "\u2003": " ", "\u2004": " ",
    "\u2005": " ", "\u2006": " ", "\u2007": " ", "\u2008": " ",
    "\u2009": " ", "\u200A": " ", "\u202F": " ", "\u205F": " ", "\u3000": " ",
}

class InvalidPatchError(Exception): pass
class ApplyPatchError(Exception): pass
class InvalidHunkError(Exception):
    def __init__(self, message: str, line_number: int): super().__init__(message); self.message, self.line_number = message, line_number

def _normalize_unicode(s): return "".join(_UNICODE_REPLACEMENTS.get(c, c) for c in s.strip())

def seek_sequence(lines, pattern, start, eof=False):
    """[PURE] Find pattern in lines with 4-pass fuzzy matching (codex-rs parity)."""
    if not pattern: return start
    if (n := len(pattern)) > len(lines): return -1
    max_start = len(lines) - n
    search_start = max_start if eof and len(lines) >= n else start
    if search_start > max_start: return -1
    def eq(a, b, t): return a == b if t is None else t(a) == t(b)
    for t in (None, str.rstrip, str.strip, _normalize_unicode):
        for i in range(search_start, max_start + 1):
            if all(eq(lines[i + k], pattern[k], t) for k in range(n)): return i
    return -1

def _check_start_end_lines(lines):
    first, last = (lines[0].strip() if lines else None), (lines[-1].strip() if lines else None)
    if first == BEGIN_PATCH_MARKER and last == END_PATCH_MARKER: return
    if first is not None and first != BEGIN_PATCH_MARKER:
        raise InvalidPatchError("The first line of the patch must be '*** Begin Patch'")
    raise InvalidPatchError("The last line of the patch must be '*** End Patch'")

def _check_start_end_lines_lenient(lines, original_error):
    if len(lines) >= 4 and lines[0] in ("<<EOF", "<<'EOF'", "<<\"EOF\"") and lines[-1].endswith("EOF"):
        inner = lines[1:-1]
        _check_start_end_lines(inner)
        return inner
    raise original_error

def _rust_lines(text): return [] if text == "" else [p[:-1] if p.endswith("\r") else p for p in text.split("\n")]
def _format_os_error(err): return "stream did not contain valid UTF-8" if isinstance(err, UnicodeDecodeError) else (f"{os.strerror(err.errno)} (os error {err.errno})" if isinstance(err, OSError) and err.errno is not None else str(err))

def parse_update_file_chunk(lines, line_number, allow_missing_context):
    if not lines: raise InvalidHunkError("Update hunk does not contain any lines", line_number)
    line0 = lines[0]
    if line0 == EMPTY_CHANGE_CONTEXT_MARKER: change_context, start_index = None, 1
    elif line0.startswith(CHANGE_CONTEXT_MARKER): change_context, start_index = line0[len(CHANGE_CONTEXT_MARKER):], 1
    elif allow_missing_context: change_context, start_index = None, 0
    else: raise InvalidHunkError(f"Expected update hunk to start with a @@ context marker, got: '{line0}'", line_number)
    if start_index >= len(lines): raise InvalidHunkError("Update hunk does not contain any lines", line_number + 1)
    chunk = {"change_context": change_context, "old_lines": [], "new_lines": [], "is_end_of_file": False}
    old, new, parsed_lines = chunk["old_lines"], chunk["new_lines"], 0
    for line in lines[start_index:]:
        if line == EOF_MARKER:
            if parsed_lines == 0: raise InvalidHunkError("Update hunk does not contain any lines", line_number + 1)
            chunk["is_end_of_file"], parsed_lines = True, parsed_lines + 1; break
        if not line: old.append(""); new.append(""); parsed_lines += 1; continue
        ch, rest = line[0], line[1:]
        if ch == " ": old.append(rest); new.append(rest)
        elif ch == "+": new.append(rest)
        elif ch == "-": old.append(rest)
        else:
            if parsed_lines == 0: raise InvalidHunkError(f"Unexpected line found in update hunk: '{line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)", line_number + 1)
            break
        parsed_lines += 1
    return chunk, parsed_lines + start_index

def parse_one_hunk(lines, line_number):
    first_line = lines[0].strip()
    if first_line.startswith(ADD_FILE_MARKER):
        path, contents, parsed_lines = first_line[len(ADD_FILE_MARKER):], [], 1
        for add_line in lines[1:]:
            if add_line.startswith("+"): contents.append(add_line[1:]); parsed_lines += 1
            else: break
        return {"type": "add", "path": path, "contents": "\n".join(contents) + "\n" if contents else ""}, parsed_lines
    if first_line.startswith(DELETE_FILE_MARKER): return {"type": "delete", "path": first_line[len(DELETE_FILE_MARKER):]}, 1
    if first_line.startswith(UPDATE_FILE_MARKER):
        path, remaining, parsed_lines, move_path = first_line[len(UPDATE_FILE_MARKER):], lines[1:], 1, None
        if remaining and remaining[0].startswith(MOVE_TO_MARKER): move_path, remaining, parsed_lines = remaining[0][len(MOVE_TO_MARKER):], remaining[1:], 2
        chunks = []
        while remaining:
            if remaining[0].strip() == "": parsed_lines += 1; remaining = remaining[1:]; continue
            if remaining[0].startswith("***"): break
            chunk, chunk_lines = parse_update_file_chunk(remaining, line_number + parsed_lines, len(chunks) == 0)
            chunks.append(chunk); parsed_lines += chunk_lines; remaining = remaining[chunk_lines:]
        if not chunks: raise InvalidHunkError(f"Update file hunk for path '{path}' is empty", line_number)
        return {"type": "update", "path": path, "move_path": move_path, "chunks": chunks}, parsed_lines
    raise InvalidHunkError(f"'{first_line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {{path}}', '*** Delete File: {{path}}', '*** Update File: {{path}}'", line_number)

def parse_patch(patch):
    lines = _rust_lines(patch.strip())
    try: _check_start_end_lines(lines)
    except InvalidPatchError as e: lines = _check_start_end_lines_lenient(lines, e)
    remaining, line_number, hunks = lines[1:-1], 2, []
    while remaining:
        hunk, consumed = parse_one_hunk(remaining, line_number)
        hunks.append(hunk); line_number += consumed; remaining = remaining[consumed:]
    return hunks, "\n".join(lines)

def _apply_replacements(lines, replacements):
    for start_idx, old_len, new_segment in reversed(replacements): lines[start_idx:start_idx + old_len] = new_segment
    return lines

def _compute_replacements(original_lines, path_display, chunks):
    replacements, line_index = [], 0
    for chunk in chunks:
        if (ctx_line := chunk["change_context"]) is not None:
            if (idx := seek_sequence(original_lines, [ctx_line], line_index, False)) < 0: raise ApplyPatchError(f"Failed to find context '{ctx_line}' in {path_display}")
            line_index = idx + 1
        old_lines, new_lines = chunk["old_lines"], chunk["new_lines"]
        if not old_lines:
            replacements.append((len(original_lines) - (original_lines[-1:] == [""]), 0, list(new_lines))); continue
        pattern, new_slice = old_lines, new_lines
        found = seek_sequence(original_lines, pattern, line_index, chunk["is_end_of_file"])
        if found < 0 and pattern[-1:] == [""]:
            pattern = pattern[:-1]; new_slice = new_slice[:-1] if new_slice[-1:] == [""] else new_slice
            found = seek_sequence(original_lines, pattern, line_index, chunk["is_end_of_file"])
        if found < 0: raise ApplyPatchError(f"Failed to find expected lines in {path_display}:\n" + "\n".join(old_lines))
        replacements.append((found, len(pattern), list(new_slice))); line_index = found + len(pattern)
    return sorted(replacements, key=lambda item: item[0])

def _derive_new_contents_from_chunks(path, chunks, path_display=None):
    path, display = Path(path), path_display if path_display is not None else str(path)
    try: original_contents = path.read_bytes().decode("utf-8")
    except Exception as e: raise ApplyPatchError(f"Failed to read file to update {display}: {_format_os_error(e)}")
    original_lines = original_contents.split("\n")
    if original_lines[-1:] == [""]: original_lines.pop()
    new_lines = _apply_replacements(original_lines, _compute_replacements(original_lines, display, chunks))
    if not new_lines or new_lines[-1] != "": new_lines.append("")
    return "\n".join(new_lines)

def _format_summary(added, modified, deleted):
    return "\n".join(["Success. Updated the following files:"] + [f"A {p}" for p in added] + [f"M {p}" for p in modified] + [f"D {p}" for p in deleted]) + "\n"

def _try(action, message):
    try: return action()
    except Exception: raise ApplyPatchError(message)

def _ensure_parent(path, label):
    if (parent := path.parent) and str(parent) not in ("", "."): _try(lambda: parent.mkdir(parents=True, exist_ok=True), f"Failed to create parent directories for {label}")

def _write_file(path, data, label): _try(lambda: path.write_bytes(data), f"Failed to write file {label}")
def _write_utf8(path, text: str, label): _write_file(path, text.encode("utf-8"), label)
def _unlink(path, message): _try(path.unlink, message)

def _apply_hunks_to_files(hunks, workdir):
    if not hunks: raise ApplyPatchError("No files were modified.")
    added, modified, deleted, base = [], [], [], Path(workdir)
    for hunk in hunks:
        hunk_type, path_str, full_path = hunk["type"], hunk["path"], base / hunk["path"]
        if hunk_type == "add":
            _ensure_parent(full_path, path_str); _write_utf8(full_path, hunk["contents"], path_str); added.append(path_str)
        elif hunk_type == "delete":
            _unlink(full_path, f"Failed to delete file {path_str}"); deleted.append(path_str)
        elif hunk_type == "update":
            new_contents = _derive_new_contents_from_chunks(full_path, hunk["chunks"], path_str)
            if move_path := hunk.get("move_path"):
                dest_full = base / move_path; _ensure_parent(dest_full, move_path); _write_utf8(dest_full, new_contents, move_path)
                _unlink(full_path, f"Failed to remove original {path_str}"); modified.append(move_path)
            else:
                _write_utf8(full_path, new_contents, path_str); modified.append(path_str)
        else: raise ApplyPatchError(f"Unknown hunk type: {hunk_type}")
    return added, modified, deleted

def apply_patch(patch_input, workdir):
    """[IO] Apply patch following codex-rs apply-patch semantics. Returns (output, exit_code)."""
    try: hunks, _ = parse_patch(patch_input or "")
    except InvalidPatchError as e: return f"Invalid patch: {e}", 1
    except InvalidHunkError as e: return f"Invalid patch hunk on line {e.line_number}: {e.message}", 1
    try: added, modified, deleted = _apply_hunks_to_files(hunks, workdir)
    except ApplyPatchError as e: return str(e), 1
    return _format_summary(added, modified, deleted), 0

def format_tool_output(output, exit_code, duration_seconds):
    duration_str = f"{(int(duration_seconds * 10.0 + 0.5) / 10.0):g}"
    return "\n".join([f"Exit code: {exit_code}", f"Wall time: {duration_str} seconds", "Output:", str(output or "")])
