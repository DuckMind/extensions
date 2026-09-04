from typing import Optional
import base64
import json
import shlex
from pathlib import Path

INPUT_IMAGE_PART_TYPES = ("input_image", "input_image_url")
SUPPORTED_IMAGE_MIME_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp")
REQUEST_INPUT_STRIP_ITEM_TYPES = ("web_search_call", "image_generation_call", "reasoning")
REQUEST_INPUT_STRIP_ITEM_KEYS = ("id", "status", "phase")
REQUEST_INPUT_STRIP_PART_KEYS = ("id", "status", "annotations", "logprobs")
_IMAGE_EXTENSION_BY_MIME_TYPE = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
}
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_JPEG_SIGNATURE = b"\xff\xd8\xff"
_GIF_SIGNATURES = (b"GIF87a", b"GIF89a")
_RIFF_SIGNATURE = b"RIFF"
_WEBP_SIGNATURE = b"WEBP"


def _nonempty_string(value) -> Optional[str]:
    if not isinstance(value, str): return None
    value = value.strip()
    return value or None


def _detect_image_mime_type(data: bytes) -> Optional[str]:
    head = bytes(data[:32] if isinstance(data, (bytes, bytearray)) else b"")
    if head.startswith(_PNG_SIGNATURE): return "image/png"
    if head.startswith(_JPEG_SIGNATURE): return "image/jpeg"
    if any(head.startswith(sig) for sig in _GIF_SIGNATURES): return "image/gif"
    if head.startswith(_RIFF_SIGNATURE) and head[8:12] == _WEBP_SIGNATURE: return "image/webp"
    return None


def _local_image_meta(path: Path) -> tuple[Path, str]:
    path = path.expanduser()
    path = path.resolve()
    if not path.is_file():
        raise SystemExit(f"Image file not found: {path}")
    mime_type = _detect_image_mime_type(path.read_bytes())
    if mime_type not in SUPPORTED_IMAGE_MIME_TYPES:
        raise SystemExit(
            f"Unsupported image file type: {path}. Supported formats: png, jpeg, gif, webp."
        )
    return path, mime_type


def _is_missing_local_image_error(exc: BaseException) -> bool:
    return str(exc).startswith("Image file not found:")


def _split_image_refs(raw: str) -> list[str]:
    if not (raw := _nonempty_string(raw)): return []
    if raw.startswith("["):
        try:
            parsed = json.loads(raw)
        except Exception as exc:
            raise SystemExit(f"Invalid img JSON array: {exc}")
        if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
            raise SystemExit("img must be a JSON string array when using JSON syntax.")
        return [item.strip() for item in parsed if isinstance(item, str) and item.strip()]
    if "\n" in raw:
        return [line.strip() for line in raw.splitlines() if line.strip()]
    try:
        tokens = [token.strip() for token in shlex.split(raw) if token.strip()]
    except ValueError as exc:
        raise SystemExit(f"Invalid img value: {exc}")
    if len(tokens) > 1: return tokens
    if raw.startswith("data:"): return [raw]
    if "," in raw:
        return [part.strip() for part in raw.split(",") if part.strip()]
    return tokens or [raw]


def input_image_part(image_ref: str, cwd: Path, detail: str = "original") -> dict:
    if not (image_ref := _nonempty_string(image_ref)):
        raise SystemExit("Image value is empty.")
    if image_ref.startswith(("http://", "https://", "data:")):
        return {"type": "input_image", "image_url": image_ref, "detail": detail}
    path = Path(image_ref).expanduser()
    if not path.is_absolute(): path = cwd / path
    path, mime_type = _local_image_meta(path)
    return {
        "type": "input_image",
        "image_path": str(path),
        "mime_type": mime_type,
        "detail": detail,
    }


def input_image_parts(img_value: str, cwd: Path, detail: str = "original") -> list[dict]:
    return [input_image_part(image_ref, cwd, detail=detail) for image_ref in _split_image_refs(img_value)]


def image_refs_from_env(img_value: Optional[str]) -> list[str]:
    return _split_image_refs(img_value) if isinstance(img_value, str) else []


def view_image_output_item(path_ref: str, cwd: Path, detail: Optional[str] = None) -> list[dict]:
    if not (path_ref := _nonempty_string(path_ref)):
        raise SystemExit("view_image.path is required.")
    if path_ref.startswith(("http://", "https://", "data:")):
        raise SystemExit("view_image only supports local filesystem paths.")
    path = Path(path_ref).expanduser()
    if not path.is_absolute(): path = cwd / path
    path, mime_type = _local_image_meta(path)
    item = {"type": "input_image", "image_path": str(path), "mime_type": mime_type}
    if isinstance(detail, str) and detail.strip():
        item["detail"] = detail.strip()
    return [item]


def generated_image_output_path(session_dir: Path, image_id: str, extension: str = "png") -> Path:
    session_dir = Path(session_dir).expanduser()
    safe_id = "".join(
        ch if ch.isalnum() or ch in ("-", "_") else "_"
        for ch in str(image_id or "").strip()
    ).strip("_")
    if not safe_id:
        safe_id = "image"
    ext = str(extension or "png").strip().lower().lstrip(".") or "png"
    return session_dir / "generated_images" / f"{safe_id}.{ext}"


def generated_image_note_item(saved_path: Path, revised_prompt: Optional[str] = None) -> dict:
    saved_path = Path(saved_path).expanduser().resolve()
    lines = [f"Generated image saved to {saved_path}. Use view_image with this path if needed."]
    if (revised_prompt := _nonempty_string(revised_prompt)):
        lines.extend(["Revised prompt used for this image:", revised_prompt])
    return {
        "type": "message",
        "role": "assistant",
        "content": [{"type": "output_text", "text": "\n".join(lines)}],
    }


def save_generated_image(
    image_data: str,
    session_dir: Path,
    image_id: str,
    output_format: str = "png",
) -> Path:
    if not (image_data := _nonempty_string(image_data)):
        raise ValueError("image_generation.result is empty")
    mime_type = None
    encoded = image_data
    if image_data.startswith("data:"):
        header, sep, payload = image_data.partition(",")
        if not sep or not payload:
            raise ValueError("image_generation.result data URL is malformed")
        mime_type = _nonempty_string(header[5:].split(";", 1)[0])
        encoded = payload
    try:
        raw = base64.b64decode(encoded, validate=False)
    except Exception as exc:
        raise ValueError(f"invalid image_generation.result base64: {exc}") from exc
    if not raw:
        raise ValueError("image_generation.result decoded to empty bytes")
    detected_mime_type = _detect_image_mime_type(raw)
    mime_type = mime_type or detected_mime_type
    extension = _IMAGE_EXTENSION_BY_MIME_TYPE.get(
        mime_type or "",
        str(output_format or "png").strip().lower().lstrip(".") or "png",
    )
    output_path = generated_image_output_path(session_dir, image_id, extension=extension)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(raw)
    return output_path.resolve()


def _resolve_input_image_part(part: dict, skip_missing_local: bool = False) -> Optional[dict]:
    if not isinstance(part, dict) or part.get("type") != "input_image": return part
    if _nonempty_string(part.get("image_url")): return part
    if not (image_path := _nonempty_string(part.get("image_path"))): return part
    try:
        path, detected_mime_type = _local_image_meta(Path(image_path))
    except SystemExit as exc:
        if skip_missing_local and _is_missing_local_image_error(exc):
            return None
        raise
    mime_type = _nonempty_string(part.get("mime_type")) or detected_mime_type
    if mime_type not in SUPPORTED_IMAGE_MIME_TYPES:
        raise SystemExit(f"Unsupported image mime type for {path}: {mime_type}")
    resolved = dict(part)
    resolved.pop("image_path", None)
    resolved.pop("mime_type", None)
    resolved["image_url"] = f"data:{mime_type};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"
    return resolved


def _resolve_input_image_parts(parts: list, skip_missing_local: bool = False) -> list:
    out = []
    for part in parts or []:
        if not isinstance(part, dict):
            out.append(part)
            continue
        resolved = _resolve_input_image_part(part, skip_missing_local=skip_missing_local)
        if resolved is not None:
            out.append(resolved)
    return out


def resolve_local_input_images(items: list, skip_missing_local: bool = False) -> list:
    out = []
    for item in items or []:
        if not isinstance(item, dict):
            out.append(item)
            continue
        if item.get("type") == "message" and isinstance((content := item.get("content")), list):
            resolved_content = _resolve_input_image_parts(content, skip_missing_local=skip_missing_local)
            if resolved_content == content:
                out.append(item)
                continue
            if not resolved_content:
                continue
            updated = dict(item)
            updated["content"] = resolved_content
            out.append(updated)
            continue
        if item.get("type") in ("function_call_output", "custom_tool_call_output") and isinstance((output := item.get("output")), list):
            resolved_output = _resolve_input_image_parts(output, skip_missing_local=skip_missing_local)
            if resolved_output == output:
                out.append(item)
                continue
            updated = dict(item)
            updated["output"] = resolved_output if resolved_output else ""
            out.append(updated)
            continue
        out.append(item)
    return out


def _strip_input_image_parts(parts: list) -> list:
    return [
        part for part in parts or []
        if not (isinstance(part, dict) and part.get("type") in INPUT_IMAGE_PART_TYPES)
    ]


def strip_input_images(items: list) -> list:
    out = []
    for item in items or []:
        if not isinstance(item, dict):
            out.append(item)
            continue
        if item.get("type") == "message" and isinstance((content := item.get("content")), list):
            filtered_content = _strip_input_image_parts(content)
            if filtered_content == content:
                out.append(item)
                continue
            if not filtered_content:
                continue
            updated = dict(item)
            updated["content"] = filtered_content
            out.append(updated)
            continue
        if item.get("type") in ("function_call_output", "custom_tool_call_output") and isinstance((output := item.get("output")), list):
            filtered_output = _strip_input_image_parts(output)
            updated = dict(item)
            updated["output"] = filtered_output if filtered_output else ""
            out.append(updated)
            continue
        out.append(item)
    return out


def strip_response_only_request_items(items: list) -> list:
    out = []
    for item in items or []:
        if isinstance(item, dict) and item.get("type") in REQUEST_INPUT_STRIP_ITEM_TYPES:
            continue
        if not isinstance(item, dict):
            out.append(item)
            continue
        updated = dict(item)
        for key in REQUEST_INPUT_STRIP_ITEM_KEYS:
            updated.pop(key, None)
        if updated.get("type") == "message" and isinstance((content := updated.get("content")), list):
            cleaned_content = []
            for part in content:
                if not isinstance(part, dict):
                    cleaned_content.append(part)
                    continue
                cleaned_part = dict(part)
                for key in REQUEST_INPUT_STRIP_PART_KEYS:
                    cleaned_part.pop(key, None)
                cleaned_content.append(cleaned_part)
            updated["content"] = cleaned_content
        out.append(updated)
    return out


def sanitize_request_input_items(items: list, allow_image_inputs: bool) -> list:
    sanitized = (
        resolve_local_input_images(items, skip_missing_local=True)
        if allow_image_inputs
        else strip_input_images(items)
    )
    return strip_response_only_request_items(sanitized)
