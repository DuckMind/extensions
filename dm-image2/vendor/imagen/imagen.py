#!/usr/bin/env python3
from itertools import chain
from pathlib import Path
from typing import Optional
import base64
import json
import os
import re
import sys
import time

from context_init import ctx_messages_from_env, load_view_image_tool_spec
from formatting import format_thinking, render_markdown, truncate_middle_line
from input_images import (
    generated_image_output_path,
    generated_image_note_item,
    image_refs_from_env,
    input_image_part,
    save_generated_image,
    sanitize_request_input_items,
    view_image_output_item,
)
from orchestrator import (
    CTX_ENV_VAR,
    CYAN,
    GRAY,
    IMAGE_DETAIL_ORIGINAL,
    IMAGE_GENERATION_OUTPUT_FORMAT,
    IMG_ENV_VAR,
    LLM_REQUEST_TIMEOUT_SECONDS,
    NC,
    PURPLE,
    RED,
    TAN,
    UNDERLINE,
    UNDERLINE_OFF,
    VIEW_IMAGE_TOOL_NAME,
    YELLOW,
    env_flag,
    env_float,
    env_int,
    extract_output_text,
    iter_tool_calls,
    json_loads,
    load_auth,
    merge_tool_calls,
    model_supports_original_image_input,
    normalize_output_items,
    reject_legacy_image_env_vars,
)
from retry_policy import error_code_from_payload, error_status_from_payload, retry_delay
from session import append_history, init_session, prompt_cache_key_for_session
from streaming import run_stream

DEFAULT_MODEL = "gpt-5.5"
DEFAULT_REASONING_EFFORT = "xhigh"
SUPPORTED_MODELS = ("gpt-5.5",)
EXPLICIT_GENERATION_PHRASES = (
    "new image",
    "new version",
    "edit this",
    "turn this into",
    "make this into",
)
GENERATION_SIGNAL_PATTERNS = (
    re.compile(r"\b(generate|draw|paint|illustrate|render|refine|redo|regenerate|edit)\b"),
    re.compile(
        r"\b(make|create)\b(?:\s+me)?\s+(?:an?|the|this|that|new)\s+"
        r"(?!list\b|bullet(?:s)?\b|critique\b|review\b|analysis\b|summary\b|"
        r"suggestion(?:s)?\b|recommendation(?:s)?\b|note(?:s)?\b|comment(?:s)?\b|"
        r"observation(?:s)?\b|feedback\b)"
    ),
    re.compile(
        r"\b(make|create)\b(?:\s+me)?\s+(?:an?\s+|the\s+|new\s+)?"
        r"(image|photo|picture|icon|logo|poster|banner|flyer|cover|illustration|"
        r"scene|portrait|graphic|wallpaper|meme|mockup|design|brochure|comic|"
        r"infographic|layout)\b"
    ),
    re.compile(
        r"\b(modify|change|update|retouch)\b.+\b"
        r"(image|photo|picture|logo|poster|design|illustration|icon)\b"
    ),
    re.compile(
        r"\b(add|remove|replace|erase)\b.+\b(to|on|from|in)\s+"
        r"(this|that|the|latest|previous)\s+"
        r"(image|photo|picture|logo|poster|design|illustration|icon)\b"
    ),
)
DEFAULT_INSTRUCTIONS = "\n".join(
    (
        "You are IMAGen 2.0 running as an image generation agent: an image-first specialist.",
        "Your job is to reason visually, research when useful, inspect images when needed, and choose the strongest response mode for the user's request.",
        "Reason first, then decide whether the job is best handled as a new image, an edit of images already in context, or a coherent multi-image set.",
        "Use your strongest Images 2.0 capabilities on purpose: accurate text rendering, structured design, multilingual typography, polished editorial layout, high coherence, photorealism when requested, strong image editing, and rich micro-detail.",
        "Treat every request as image creation, image editing, or a coherent image set.",
        "Operate like a careful art director and prompt rewriter, not a generic chat model. Prefer explicit generation verbs like draw, render, or edit when you rewrite the prompt. For complex tasks, think longer, plan the output, and only then generate.",
        "Revised prompts should usually follow this order: intended use → background/scene → subject → key details → constraints. For complex requests, prefer short labeled segments or line breaks instead of one vague paragraph.",
        "Use concrete visual facts instead of empty hype. Prefer materials, shapes, textures, lens feel, lighting, framing, spacing, hierarchy, and placement over vague praise like masterpiece or stunning. When layout matters, specify viewpoint, camera angle, focal framing, and placement explicitly, for example logo top-right or subject centered with negative space on left.",
        "If the user provides one or more reference images, inspect them carefully and treat them as high-fidelity constraints. Preserve the requested identity, subject, likeness, composition, palette, wardrobe, materials, logos, style, geometry, layout, brand elements, and constraints unless the user explicitly asks for change. If reference images conflict, prioritize explicit user instructions first, then the most fidelity-critical or base image, then supporting references.",
        "If the task is an edit, composite, or reference-driven transformation, prefer editing from the provided images instead of needlessly redrawing from scratch. Use change-only language, keep everything else the same, and restate what must stay unchanged and what must not appear, such as no extra text, no extra logos, or no extra objects, on each refinement turn to reduce drift.",
        "When combining multiple references, reference each input by index and role, for example Image 1: base scene or identity anchor, Image 2: style reference or donor object. Put the most fidelity-critical face, logo, product, or base image first when possible, and phrase the revised prompt in explicit draw/edit language. For composites, prefer wording like edit the first image by adding this element from the second image.",
        "When the current user turn includes an attached prior generated image, treat that attached image as the base image for editing or finalization unless the user clearly asks for a fresh redraw.",
        "When previously generated local image paths are available in prior assistant notes, you may use view_image on those files to inspect them before deciding how to refine the next image.",
        "If the request asks for posters, magazines, infographics, recipes, branding, logos, diagrams, math proofs, manga or comic pages, fashion boards, renovation plans, brochures, grids, or other explainer visuals, prioritize information architecture: hierarchy, spacing, labels, typography, margins, and layout, not just a generic picture. If the result will contain dense text or a structured layout that must stay readable, prefer a cleaner composition and usually quality=high for the final render.",
        "For website, landing page, hero, editorial, or UI-heavy requests, act like an art director producing implementation-friendly section references, not a tiny unreadable moodboard. Prefer large analyzable section images, generate enough images for readability, and do not be lazy with image count when extra section renders or detail views would improve extraction quality.",
        "For visually important website/UI work, one clear section per image is usually better than one compressed board. If a section, button cluster, or typography block is still unclear, generate a fresh dedicated image instead of cropping an older board. Keep the multi-image set in one coherent design system.",
        "For hero sections, keep the opening scene clean and intentional: one strong focal point, generous negative space, concise supporting copy, and a headline that ideally stays within 1-3 lines instead of turning into paragraph slop.",
        "If the user asks for photorealism, use plausible lenses, framing, lighting, materials, scale, shadows, subtle imperfections, and natural scene logic. Favor grounded realism over cinematic exaggeration unless the user explicitly asks for stylization.",
        "Support multilingual text faithfully. When a language is specified, keep visible text in that language and render it clearly and intentionally. For translation or localization edits, preserve layout, spacing, hierarchy, logos, icons, and imagery while changing only the text, translating verbatim, with no extra words and no reflow unless necessary.",
        "If visible text matters, put literal text in quotes or ALL CAPS, specify typography details like style, weight, size, color, and placement, and use exact or verbatim language when needed. For tricky spellings or brand names, spell them out letter-by-letter. When copy must be exact, say EXACT, verbatim, no extra characters, no duplicate text, appears once, and perfectly legible. Keep text concise enough to render cleanly, organize longer copy into headline, subheads, captions, labels, and short blocks, and mentally proofread spelling, numerals, and line breaks before generating.",
        "For QR codes or other scannable elements, make them large, high-contrast, uncluttered, and easy to scan.",
        "For tall, wide, panoramic, poster, cover, spread, or grid-based requests, compose to fit the intended aspect ratio and use the canvas deliberately.",
        "Use image_generation tool options deliberately when the request needs them: choose size, quality, background, and action with intent. Keep action on auto unless you have a clear reason to force generate or edit.",
        "When exact dimensions or aspect ratios matter, carry them through cleanly in both the revised prompt and tool options, preferably with exact pixel dimensions, and keep them within the current GPT Image constraints: maximum edge 3840px, both edges multiples of 16px, long-to-short ratio no more than 3:1, and total pixels between 655,360 and 8,294,400. Treat outputs above 2560x1440 total pixels as experimental. Use quality=low for fast drafts and quick iterations, then move to medium or high for finals.",
        "GPT Image 2 processes image inputs at high fidelity automatically, so preserve meaningful details from references instead of casually redrawing them. GPT Image 2 also does not support transparent backgrounds, so do not request a transparent background with that model.",
        "If the backend emits partial image previews while generating, use them as intermediate evidence. Inspect the preview mentally before the final result and tighten the next turn when obvious issues appear, especially text mistakes, crowded layout, weak spacing, wrong crop, or drift from the requested reference.",
        "When current, factual, research-heavy, social, cultural, geographic, or product-specific details would improve the image, use web_search before generating. When you use web_search, gather only the facts, names, dates, labels, short quotes, design cues, or cultural details that materially improve the image, then translate them into clear visual structure instead of dumping raw research into the canvas.",
        "For simple purely creative prompts that do not benefit from current information, skip web_search and generate directly.",
        "If the request calls for multiple outputs, options, pages, angles, variants, storyboard beats, or a coherent series, plan the whole set first and generate distinct images that stay consistent in character, style, story, palette, layout rhythm, and design system. Give each image a clear role and avoid near-duplicate variants unless the user explicitly wants close alternatives.",
        "When a request is likely to benefit from draft-then-final iteration, prefer fast preview-friendly drafts first, then a higher-quality final once composition, text, and fidelity are proven. Use low or auto quality for early drafts when speed helps, then medium or high for the final pass.",
        "You may call image_generation multiple times when variants, pages, staged refinement, section-specific website renders, or follow-up generations will improve the result. Prefer a clean base prompt plus small single-change follow-ups over one overloaded correction pass, and re-state the preserve list if identity, layout, or text fidelity starts to drift.",
        "For refinement turns, inspect the latest relevant image with view_image before editing when the requested change depends on actual layout, spacing, text placement, crop, or reference fidelity. Base the revised prompt on what the image actually shows, not just the prior text prompt.",
        "If the user asks to verify whether the image already meets the spec, treat the image itself as the source of truth. Review it, call out concrete mismatches, and either stop because it is already correct or launch a narrowly scoped follow-up generation.",
        "When the request is complex or underspecified, think before generating, make strong visual decisions, and write a revised prompt that reads like concrete, production-ready art direction.",
        "Before each final generation, mentally check for text mistakes, extra characters, duplicate text, layout hierarchy, aspect ratio mistakes, preserve-vs-change mistakes, reference-image fidelity, consistency breaks, factual grounding, QR scannability, missed constraints, and whether a stronger variant set or extra detail image would help.",
        "Be decisive and generate the strongest production-ready image result you can.",
    )
)
BASE_URL = "https://chatgpt.com/backend-api/codex"
IMAGE_AGENT_TIMEOUT_SECONDS = max(float(LLM_REQUEST_TIMEOUT_SECONDS), 900.0)
SUPPORTED_NEW_MODES = ("0", "1", "2", "3", "4")


def _nonempty_string(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _print_help(argv0: Optional[str] = None) -> int:
    name = os.path.basename(argv0 or "imagen.py")
    sys.stdout.write(
        f"Usage: [session='resume[:/path/to/session.jsonl]|new[:/path/to/session.jsonl]|fork:/path/to/src.jsonl=>/path/to/dest.jsonl'] "
        f"[ctx='/path/a.py,README.md'] [img='/path/a.png,/path/b.png'] {name} \"prompt\"\n"
        "\n"
        "Shared session:\n"
        "  imagen.py uses the same .m/session.jsonl format as m.py so you can switch agents on one thread.\n"
        "  Default mode resumes .m/session.jsonl in the current directory.\n"
        "  Use session=resume/new/fork to control the shared thread explicitly.\n"
        "\n"
        "This CLI runs in agentic image mode.\n"
        "It can use view_image to inspect saved local images from the shared session before refining.\n"
        "If your prompt clearly asks to generate or edit an image, imagen.py will still force image generation.\n"
        "Long image tool runs may take up to 15 minutes.\n"
        "\n"
        "Defaults:\n"
        f"  model={DEFAULT_MODEL}\n"
        f"  effort={DEFAULT_REASONING_EFFORT}\n"
        "\n"
        "Env:\n"
        "  ctx=...      preload text files as extra user messages\n"
        "  img=...      attach one or more input images\n"
        "  session=...  reuse or fork a shared .m/session.jsonl thread\n"
        "  model=...    override model (gpt-5.5)\n"
        "  quiet=1      print saved image paths only\n"
    )
    return 0


def _prompt_from_argv(argv: list[str]) -> str:
    if argv:
        return " ".join(argv).strip()
    if not sys.stdin.isatty():
        return sys.stdin.read().strip()
    return ""


def _reject_legacy_refine_env() -> None:
    raw = _nonempty_string(os.environ.get("refine"))
    if raw and raw != "0":
        raise SystemExit(
            "refine= was removed. Resume the shared session and use view_image to review/refine generated images."
        )


def _prompt_requests_generation(prompt: str) -> bool:
    text = str(prompt or "").strip().lower()
    if not text:
        return False
    if any(phrase in text for phrase in EXPLICIT_GENERATION_PHRASES):
        return True
    # Keep the forced-generation gate narrow: it should catch clear create/edit asks
    # without hijacking review prompts like "make 3 suggestions".
    return any(pattern.search(text) for pattern in GENERATION_SIGNAL_PATTERNS)


def _prompt_requests_review(prompt: str) -> bool:
    text = str(prompt or "").strip().lower()
    if not text:
        return False
    review_phrases = (
        "review this image",
        "review the previous image",
        "review the latest image",
        "inspect the latest image",
        "inspect this image",
        "critique it",
        "critique this image",
        "suggest improvements",
        "analyze this image",
        "describe this image",
        "proofread the image",
        "verify the image",
    )
    return any(phrase in text for phrase in review_phrases)


def _instructions_for_mode(image_generation_required: bool) -> str:
    if image_generation_required:
        suffix = (
            " This prompt clearly asks to create, edit, regenerate, or refine an image. "
            "Final success requires image_generation. Do not end with review-only text."
        )
    else:
        suffix = (
            " If existing images are available in context or through view_image, you may inspect them and answer in text when review or analysis is enough. "
            "Otherwise generate if that is the best response."
        )
    return f"{DEFAULT_INSTRUCTIONS}{suffix}"


def _request_tools(view_image_tool: dict, allow_image_input: bool) -> list[dict]:
    tools: list[dict] = []
    if allow_image_input:
        tools.append(view_image_tool)
    tools.append({"type": "image_generation", "output_format": IMAGE_GENERATION_OUTPUT_FORMAT})
    tools.append({"type": "web_search"})
    return tools


def _local_review_path(path_ref, cwd: Path) -> Optional[str]:
    if not (path_ref := _nonempty_string(path_ref)):
        return None
    if path_ref.startswith(("http://", "https://", "data:")):
        return None
    path = Path(path_ref).expanduser()
    if not path.is_absolute():
        path = cwd / path
    try:
        path = path.resolve()
    except Exception:
        path = path.absolute()
    if not path.is_file():
        return None
    return str(path)


def _saved_path_from_note_text(text: str) -> Optional[str]:
    if not isinstance(text, str):
        return None
    prefix = "Generated image saved to "
    marker = ". Use view_image"
    if not text.startswith(prefix):
        return None
    remainder = text[len(prefix):]
    marker_index = remainder.find(marker)
    if marker_index == -1:
        return None
    return remainder[:marker_index].strip() or None


def _history_review_image_paths(history: list, cwd: Path, max_items: int = 8) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []

    def add(path_ref) -> None:
        if len(out) >= max_items:
            return
        if not (resolved := _local_review_path(path_ref, cwd)):
            return
        if resolved in seen:
            return
        seen.add(resolved)
        out.append(resolved)

    for item in reversed(history or []):
        if len(out) >= max_items:
            break
        if not isinstance(item, dict):
            continue
        if item.get("type") == "image_generation_call":
            add(item.get("saved_path"))
        if item.get("type") == "message" and isinstance((content := item.get("content")), list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                if isinstance((text := part.get("text")), str):
                    add(_saved_path_from_note_text(text))
        if item.get("type") in ("function_call_output", "custom_tool_call_output") and isinstance((output := item.get("output")), list):
            for part in output:
                if isinstance(part, dict) and part.get("type") == "input_image":
                    add(part.get("image_path"))
    return out


def _current_local_image_paths(image_refs: list[str], cwd: Path, max_items: int = 8) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for image_ref in image_refs or []:
        if len(out) >= max_items:
            break
        if not (resolved := _local_review_path(image_ref, cwd)):
            continue
        if resolved in seen:
            continue
        seen.add(resolved)
        out.append(resolved)
    return out


def _review_paths_for_request(image_generation_required: bool, history: list, image_refs: list[str], cwd: Path) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    current_paths = []
    if not image_generation_required:
        current_paths = _current_local_image_paths(image_refs, cwd, max_items=6)
    for path in chain(
        current_paths,
        _history_review_image_paths(history, cwd, max_items=6),
    ):
        if path in seen:
            continue
        seen.add(path)
        out.append(path)
        if len(out) >= 6:
            break
    return out


def _review_paths_message(review_paths: list[str]) -> dict:
    lines = [
        "Recent local images available for inspection with view_image:",
        *[f"- {path}" for path in review_paths],
        "Use view_image on the relevant file if you need a closer review before answering.",
    ]
    return {
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": "\n".join(lines)}],
    }


def _attached_base_image_message(path_ref: str, cwd: Path, note: str) -> dict:
    content = [{"type": "input_text", "text": str(note or "").strip()}]
    content.extend(view_image_output_item(path_ref, cwd, detail=IMAGE_DETAIL_ORIGINAL))
    return {"type": "message", "role": "user", "content": content}


def _direct_edit_message() -> dict:
    text = (
        "Base image is already attached for this turn.\n"
        "- Do not call view_image again unless a different image is truly required.\n"
        "- Launch one narrow image_generation edit from the attached base image now.\n"
        "- Keep the preserve list strict and change only what the user asked for."
    )
    return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}


def _request_input(
    history: list,
    allow_image_input: bool,
    review_paths: Optional[list[str]] = None,
    extra_items: Optional[list[dict]] = None,
) -> list[dict]:
    items = list(history or [])
    if extra_items:
        items.extend(extra_items)
    if review_paths:
        insert_at = len(items)
        if items and isinstance(items[-1], dict) and items[-1].get("type") == "message" and items[-1].get("role") == "user":
            insert_at = len(items) - 1
        items.insert(insert_at, _review_paths_message(review_paths))
    return sanitize_request_input_items(items, allow_image_inputs=allow_image_input)


AUTO_REVIEW_TRIGGER_PHRASES = (
    "verbatim",
    "verify",
    "check whether",
    "already meets",
    "already correct",
    "proofread",
)


def _should_auto_review(prompt: str, image_refs: list[str]) -> bool:
    text = str(prompt or "").strip().lower()
    return any(phrase in text for phrase in AUTO_REVIEW_TRIGGER_PHRASES)


def _should_preview_then_final(prompt: str) -> bool:
    text = str(prompt or "").strip().lower()
    if not text:
        return False
    preview_terms = ("preview first", "draft first", "preview", "draft")
    final_terms = ("final", "final render", "higher-quality", "higher quality", "high-res", "high quality")
    return any(term in text for term in preview_terms) and any(term in text for term in final_terms)


def _auto_review_message() -> dict:
    text = (
        "Quality checkpoint for the active image task:\n"
        "- Inspect the latest relevant generated image with view_image if the decision depends on actual text, spacing, crop, composition, or preserve-vs-change fidelity.\n"
        "- If the image already satisfies the user request closely, approve it internally and stop.\n"
        "- If there is a concrete mismatch, perform exactly one narrow follow-up image_generation edit that fixes only that mismatch.\n"
        "- Prefer evidence from the image over assumptions from the prior prompt."
    )
    return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}


def _draft_phase_message() -> dict:
    text = (
        "Draft phase for this image task:\n"
        "- Generate one fast preview image first.\n"
        "- Prefer low or auto quality, and a lighter-weight canvas if that helps speed.\n"
        "- Focus on composition, text placement, spacing, crop, and reference fidelity.\n"
        "- Do not spend the full budget on polish yet."
    )
    return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}


def _final_phase_message() -> dict:
    text = (
        "Final phase for this image task:\n"
        "- Inspect the latest draft image with view_image before deciding.\n"
        "- If the draft already has the right composition and text, generate one higher-quality final that preserves it.\n"
        "- If the draft has concrete mismatches, generate one higher-quality final that fixes only those mismatches.\n"
        "- Use medium or high quality for this final pass."
    )
    return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}


def _force_generation_decision_message() -> dict:
    text = (
        "You have already inspected the relevant local image enough times for this turn.\n"
        "- Do not call view_image again on the same file unless a different image is required.\n"
        "- Either launch one narrow image_generation edit now, or state clearly that no pixel change is needed."
    )
    return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}


def _assistant_accepts_current_image(text: str) -> bool:
    lowered = str(text or "").strip().lower()
    if not lowered:
        return False
    acceptance_phrases = (
        "approved",
        "matches the requested",
        "already satisfies",
        "already meets",
        "already correct",
        "looks correct",
        "looks good",
        "meets the requested spec",
        "satisfies the requested spec",
    )
    return any(phrase in lowered for phrase in acceptance_phrases)


def _prompt_wants_prior_generated_image(prompt: str) -> bool:
    text = str(prompt or "").strip().lower()
    if not text:
        return False
    phrases = (
        "previous image",
        "latest image",
        "this image",
        "review the previous image",
        "review the latest image",
        "refine it",
        "keep everything else the same",
        "same style",
    )
    return any(phrase in text for phrase in phrases)


def _persist_generated_images(
    output_items: list[dict],
    session_dir: Path,
    quiet: bool,
) -> tuple[list[dict], list[dict], list[Path]]:
    persisted_items: list[dict] = []
    note_items: list[dict] = []
    saved_paths: list[Path] = []
    for item in output_items or []:
        if not isinstance(item, dict) or item.get("type") != "image_generation_call":
            persisted_items.append(item)
            continue
        image_id = _nonempty_string(item.get("id")) or f"image_{len(saved_paths) + 1}"
        result = item.get("result")
        if not isinstance(result, str) or not result.strip():
            persisted_items.append(item)
            continue
        saved_path = save_generated_image(
            result,
            session_dir,
            image_id,
            output_format=IMAGE_GENERATION_OUTPUT_FORMAT,
        )
        revised_prompt = _nonempty_string(item.get("revised_prompt"))
        persisted_item = dict(item)
        persisted_item["result"] = ""
        persisted_item["saved_path"] = str(saved_path)
        persisted_items.append(persisted_item)
        note_items.append(generated_image_note_item(saved_path, revised_prompt=revised_prompt))
        saved_paths.append(saved_path)
        if quiet:
            continue
        print(f"{CYAN}[image]{NC} saved {saved_path}", file=sys.stderr)
        if revised_prompt:
            print(f"{CYAN}[image]{NC} revised_prompt:", file=sys.stderr)
            print(revised_prompt, file=sys.stderr)
        sys.stderr.flush()
    return persisted_items, note_items, saved_paths


def _partial_image_output_path(session_dir: Path, image_id: str, sequence_number=None, output_format: str = "png") -> Path:
    session_dir = Path(session_dir).expanduser()
    stem = generated_image_output_path(session_dir, image_id, extension=output_format).stem
    suffix = f"_partial_{int(sequence_number)}" if isinstance(sequence_number, int) else "_partial"
    return session_dir / "generated_images" / f"{stem}{suffix}.{str(output_format or 'png').strip().lower().lstrip('.') or 'png'}"


def _save_partial_image_event(event: dict, session_dir: Path) -> Optional[Path]:
    if not isinstance(event, dict):
        return None
    encoded = _nonempty_string(event.get("partial_image_b64"))
    if not encoded:
        return None
    image_id = _nonempty_string(event.get("item_id")) or "image"
    output_format = _nonempty_string(event.get("output_format")) or IMAGE_GENERATION_OUTPUT_FORMAT
    sequence_number = event.get("sequence_number")
    try:
        raw = base64.b64decode(encoded, validate=False)
    except Exception:
        return None
    if not raw:
        return None
    output_path = _partial_image_output_path(
        session_dir,
        image_id,
        sequence_number=(int(sequence_number) if isinstance(sequence_number, int) else None),
        output_format=output_format,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(raw)
    return output_path.resolve()


def _emit_image_partial(event: dict, session_dir: Path) -> None:
    if not isinstance(event, dict):
        return
    saved_path = _save_partial_image_event(event, session_dir)
    if not saved_path:
        return
    item_id = _nonempty_string(event.get("item_id")) or "image"
    sys.stderr.write(f"{CYAN}[image-partial]{NC} {item_id} {saved_path}\n")
    sys.stderr.flush()


def _emit_thinking(text: str) -> None:
    formatted = format_thinking(text, UNDERLINE, UNDERLINE_OFF)
    sys.stderr.write(f"{PURPLE}[think]{NC} {TAN}{formatted}{NC}\n")
    sys.stderr.flush()


def _emit_web_search(query: str) -> None:
    text = f"Web search: {str(query or '').strip()}"
    if not text.strip():
        return
    sys.stderr.write(f"{PURPLE}[think]{NC} {TAN}{text}{NC}\n")
    sys.stderr.flush()


def _emit_assist(text: str) -> None:
    cleaned = str(text or "").strip()
    if not cleaned:
        return
    sys.stderr.write(f"{PURPLE}[assist]{NC}\n{render_markdown(cleaned)}\n")
    sys.stderr.flush()


def _assistant_text_item(text: str) -> dict:
    return {
        "type": "message",
        "role": "assistant",
        "content": [{"type": "output_text", "text": str(text or "").strip()}],
    }


def _stream_has_valid_response(payload) -> bool:
    dbg = payload.get("_stream_debug") if isinstance(payload, dict) else None
    if not isinstance(dbg, dict):
        return False
    try:
        return int(dbg.get("valid_event_count") or 0) > 0
    except Exception:
        return False


def _retry_error_info(payload) -> str:
    status = error_status_from_payload(payload)
    code = error_code_from_payload(payload)
    if isinstance(code, str):
        code = code.strip()
    else:
        code = ""
    if status and code:
        return f" [{status}] {code}"
    if status:
        return f" [{status}]"
    if code:
        return f" [{code}]"
    return ""


def _tool_items(call: dict, cwd: Path, allow_image_input: bool):
    if not isinstance(call, dict):
        return None
    name = _nonempty_string(call.get("name"))
    call_id = _nonempty_string(call.get("id")) or _nonempty_string(call.get("call_id"))
    if not name or not call_id:
        return None
    raw_arguments = call.get("arguments", "{}")
    arguments_text = (
        raw_arguments
        if isinstance(raw_arguments, str)
        else json.dumps(raw_arguments, ensure_ascii=False, separators=(",", ":"))
    )
    if name != VIEW_IMAGE_TOOL_NAME:
        call_item = {"type": "function_call", "call_id": call_id, "name": name, "arguments": arguments_text}
        return call_item, {"type": "function_call_output", "call_id": call_id, "output": f"Error: Unknown tool: {name}"}
    call_item = {"type": "function_call", "call_id": call_id, "name": name, "arguments": arguments_text}
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
                output = view_image_output_item(path_arg or "", cwd, detail=detail_arg)
            except SystemExit as exc:
                output = f"Error: {exc}"
    return call_item, {"type": "function_call_output", "call_id": call_id, "output": output}


def main(argv=None) -> int:
    argv = list(argv) if argv is not None else sys.argv[1:]
    if argv and argv[0] in ("-h", "--help"):
        return _print_help(argv0=sys.argv[0])

    reject_legacy_image_env_vars()
    _reject_legacy_refine_env()
    prompt = _prompt_from_argv(argv)
    if not prompt:
        print(f'No prompt provided. Usage: ./imagen.py "your prompt"', file=sys.stderr)
        return 1

    model = str(os.environ.get("model") or DEFAULT_MODEL).strip()
    if model not in SUPPORTED_MODELS:
        raise SystemExit(f"Invalid model: {model}. Allowed: {', '.join(SUPPORTED_MODELS)}")
    effort = DEFAULT_REASONING_EFFORT
    quiet = env_flag("quiet")
    debug_level = 0 if quiet else env_int("debug", 0)
    new_mode = str(os.environ.get("n") or "0").strip()
    if new_mode not in SUPPORTED_NEW_MODES:
        raise SystemExit(f"Invalid n: {new_mode}. Allowed: {', '.join(SUPPORTED_NEW_MODES)}")
    stream_max_retries = env_int("stream_max_retries", 9)
    stream_retry_delay = env_float("stream_retry_delay", "0.2")
    stream_retry_delay_rate_limit = env_float("stream_retry_delay_rate_limit", "1.0")
    stream_retry_max_delay = env_float("stream_retry_max_delay", "30")
    if stream_retry_delay_rate_limit <= 0:
        stream_retry_delay_rate_limit = stream_retry_delay
    if stream_retry_max_delay <= 0:
        stream_retry_max_delay = None
    cwd = Path.cwd().resolve()
    session_opt = str(os.environ.get("session") or "")
    session_file, history = init_session(new_mode, session_opt, cwd)
    allow_image_input = model_supports_original_image_input(model)
    auth_file = Path(os.environ.get("auth_file") or "~/.codex/auth.json").expanduser().resolve()
    token, account_id = load_auth(auth_file)
    image_refs = image_refs_from_env(os.environ.get(IMG_ENV_VAR))
    script_dir = Path(__file__).resolve().parent
    view_image_tool = load_view_image_tool_spec(script_dir)
    image_generation_required = _prompt_requests_generation(prompt)
    review_prompt = _prompt_requests_review(prompt)

    if not quiet:
        print(f"{GRAY}Auth: {auth_file.name}{NC}", file=sys.stderr)
        print(f"{GRAY}Model: {model} | {effort}{NC}", file=sys.stderr)
        print(f"{GRAY}Session: {truncate_middle_line(str(session_file), 120)}{NC}", file=sys.stderr)
        if (ctx_value := _nonempty_string(os.environ.get(CTX_ENV_VAR))):
            print(f"{GRAY}Ctx: {truncate_middle_line(ctx_value, 120)}{NC}", file=sys.stderr)
        if (img_value := _nonempty_string(os.environ.get(IMG_ENV_VAR))):
            print(f"{GRAY}Img: {truncate_middle_line(img_value, 120)}{NC}", file=sys.stderr)

    ctx_items = ctx_messages_from_env(os.environ.get(CTX_ENV_VAR), cwd, history=history)
    if ctx_items:
        history.extend(ctx_items)
        append_history(session_file, ctx_items)

    user_content = [{"type": "input_text", "text": prompt}]
    if image_refs and allow_image_input:
        user_content.extend(
            input_image_part(image_ref, cwd, detail=IMAGE_DETAIL_ORIGINAL)
            for image_ref in image_refs
        )
    user_item = {"type": "message", "role": "user", "content": user_content}
    history.append(user_item)
    append_history(session_file, [user_item])
    review_paths = _review_paths_for_request(image_generation_required, history, image_refs, cwd) if (image_generation_required or review_prompt) else []
    pinned_base_paths = review_paths[:1] if image_generation_required and _prompt_wants_prior_generated_image(prompt) else []

    def _ephemeral_with_base(extra_items: list[dict]) -> list[dict]:
        items = list(extra_items or [])
        if not pinned_base_paths:
            return items
        base_item = _attached_base_image_message(
            pinned_base_paths[0],
            cwd,
            "Base image attached for this turn. Treat it as Image 1 and edit or finalize from it unless the user asks for a fresh redraw.",
        )
        return [base_item, _direct_edit_message(), *items]

    request = {
        "model": model,
        "instructions": _instructions_for_mode(image_generation_required),
        "input": _request_input(history, allow_image_input, review_paths=review_paths),
        "reasoning": {"effort": effort, "summary": "detailed"},
        "tools": _request_tools(view_image_tool, allow_image_input),
        "tool_choice": "auto",
        "parallel_tool_calls": True,
        "store": False,
        "stream": True,
    }
    if image_generation_required and pinned_base_paths:
        request["tool_choice"] = {"type": "image_generation"}
    if (cache_key := prompt_cache_key_for_session(session_file)):
        request["prompt_cache_key"] = cache_key

    latest_saved_paths: list[Path] = []
    final_saved_paths: list[Path] = []
    review_only_allowed = bool(review_paths) and review_prompt
    preview_then_final_remaining = 1 if image_generation_required and _should_preview_then_final(prompt) else 0
    auto_review_remaining = 0 if preview_then_final_remaining else (1 if image_generation_required and _should_auto_review(prompt, image_refs) else 0)
    auto_review_accept_text = False
    ephemeral_items: list[dict] = [_draft_phase_message()] if preview_then_final_remaining else []
    consecutive_view_only_turns = 0
    request["input"] = _request_input(
        history,
        allow_image_input,
        review_paths=review_paths,
        extra_items=_ephemeral_with_base(ephemeral_items),
    )
    while True:
        retry_streak = 0
        while True:
            status, payload, stream_calls = run_stream(
                request,
                debug_level=debug_level,
                token=token,
                account_id=account_id,
                base_url=BASE_URL,
                timeout=IMAGE_AGENT_TIMEOUT_SECONDS,
                quiet=quiet,
                on_thinking=(None if quiet else _emit_thinking),
                on_web_search=(None if quiet else _emit_web_search),
                on_image_partial=(None if quiet else (lambda event: _emit_image_partial(event, session_file.parent))),
            )
            if status == "failed" and _stream_has_valid_response(payload):
                retry_streak = 0
            current_attempt = retry_streak + 1
            if status == "failed":
                delay = retry_delay(
                    payload,
                    current_attempt,
                    stream_retry_delay,
                    stream_retry_delay_rate_limit,
                    max_seconds=stream_retry_max_delay,
                )
                if delay is not None and retry_streak < stream_max_retries:
                    next_streak = current_attempt
                    err_info = _retry_error_info(payload)
                    if not quiet:
                        print(
                            f"{YELLOW}WARN retryable error{err_info}; retrying ({next_streak}/{stream_max_retries}) in {delay:.2f}s{NC}",
                            file=sys.stderr,
                        )
                        sys.stderr.flush()
                    retry_streak = next_streak
                    if delay > 0:
                        time.sleep(delay)
                    continue
            break

        if status != "completed":
            print(f"{RED}{json.dumps(payload, ensure_ascii=False)}{NC}", file=sys.stderr)
            return 1

        response = payload.get("response") if isinstance(payload, dict) else {}
        output_items = normalize_output_items(response.get("output")) if isinstance(response, dict) else []
        persisted_output_items = output_items
        if output_items:
            persisted_output_items, note_items, saved_paths = _persist_generated_images(
                output_items,
                session_file.parent,
                quiet=quiet,
            )
            if saved_paths:
                latest_saved_paths = saved_paths
            history.extend(persisted_output_items)
            append_history(session_file, persisted_output_items)
            if note_items:
                history.extend(note_items)
                append_history(session_file, note_items)
            review_paths = _review_paths_for_request(image_generation_required, history, image_refs, cwd)
            if not (image_generation_required or review_prompt):
                review_paths = []
            review_only_allowed = bool(review_paths) and review_prompt
            request["input"] = _request_input(
                history,
                allow_image_input,
                review_paths=review_paths,
                extra_items=_ephemeral_with_base(ephemeral_items),
            )

        assistant_text = ""
        if isinstance(payload, dict) and isinstance(payload.get("assistant_text"), str):
            assistant_text = payload.get("assistant_text") or ""
        if not assistant_text and isinstance(response, dict):
            assistant_text = extract_output_text(response)
        if not latest_saved_paths and not auto_review_accept_text:
            final_saved_paths = []
            ephemeral_items = []
        output_has_assistant_message = any(
            isinstance(item, dict) and item.get("type") == "message" and item.get("role") == "assistant"
            for item in persisted_output_items
        )
        if assistant_text and not output_has_assistant_message:
            assistant_item = _assistant_text_item(assistant_text)
            history.append(assistant_item)
            append_history(session_file, [assistant_item])
            review_paths = _review_paths_for_request(image_generation_required, history, image_refs, cwd)
            if not (image_generation_required or review_prompt):
                review_paths = []
            review_only_allowed = bool(review_paths) and review_prompt
            request["input"] = _request_input(
                history,
                allow_image_input,
                review_paths=review_paths,
                extra_items=_ephemeral_with_base(ephemeral_items),
            )
        assistant_emitted = False
        if assistant_text and not quiet:
            _emit_assist(assistant_text)
            assistant_emitted = True

        calls = merge_tool_calls(chain(stream_calls or [], iter_tool_calls(response or {})))
        if calls:
            if all(_nonempty_string(call.get("name")) == VIEW_IMAGE_TOOL_NAME for call in calls if isinstance(call, dict)):
                consecutive_view_only_turns += 1
            else:
                consecutive_view_only_turns = 0
            pairs = [pair for pair in map(lambda call: _tool_items(call, cwd, allow_image_input), calls) if pair is not None]
            tool_call_items, tool_output_items = map(list, zip(*pairs)) if pairs else ([], [])
            existing = {
                (item.get("type"), item.get("call_id"))
                for item in persisted_output_items
                if isinstance(item, dict)
            }
            if tool_call_items:
                tool_call_items = [
                    item
                    for item in tool_call_items
                    if (item.get("type"), item.get("call_id")) not in existing
                ]
            if tool_call_items:
                history.extend(tool_call_items)
                append_history(session_file, tool_call_items)
            if tool_output_items:
                history.extend(tool_output_items)
                append_history(session_file, tool_output_items)
            review_paths = _review_paths_for_request(image_generation_required, history, image_refs, cwd)
            if not (image_generation_required or review_prompt):
                review_paths = []
            review_only_allowed = bool(review_paths) and review_prompt
            if image_generation_required and consecutive_view_only_turns >= 2:
                ephemeral_items = [_force_generation_decision_message()]
            if image_generation_required and consecutive_view_only_turns > 4:
                print("Model kept re-inspecting images without generating a new result.", file=sys.stderr)
                return 1
            request["input"] = _request_input(
                history,
                allow_image_input,
                review_paths=review_paths,
                extra_items=_ephemeral_with_base(ephemeral_items),
            )
            continue

        if latest_saved_paths and auto_review_remaining > 0:
            consecutive_view_only_turns = 0
            auto_review_remaining -= 1
            auto_review_accept_text = True
            final_saved_paths = list(latest_saved_paths)
            latest_saved_paths = []
            ephemeral_items = [_auto_review_message()]
            request["input"] = _request_input(
                history,
                allow_image_input,
                review_paths=review_paths,
                extra_items=_ephemeral_with_base(ephemeral_items),
            )
            continue

        if latest_saved_paths and preview_then_final_remaining > 0:
            consecutive_view_only_turns = 0
            preview_then_final_remaining -= 1
            latest_saved_paths = []
            ephemeral_items = [_final_phase_message()]
            request["input"] = _request_input(
                history,
                allow_image_input,
                review_paths=review_paths,
                extra_items=_ephemeral_with_base(ephemeral_items),
            )
            continue

        if latest_saved_paths:
            consecutive_view_only_turns = 0
            for path in latest_saved_paths:
                sys.stdout.write(f"{path}\n")
            sys.stdout.flush()
            return 0
        if assistant_text and auto_review_accept_text and final_saved_paths and _assistant_accepts_current_image(assistant_text):
            consecutive_view_only_turns = 0
            for path in final_saved_paths:
                sys.stdout.write(f"{path}\n")
            sys.stdout.flush()
            return 0
        if assistant_text and not image_generation_required and review_only_allowed:
            if quiet:
                sys.stdout.write(f"{assistant_text.strip()}\n")
                sys.stdout.flush()
            return 0
        if assistant_text:
            print("Model returned text instead of image_generation output:", file=sys.stderr)
            if quiet:
                print(assistant_text, file=sys.stderr)
            elif not assistant_emitted:
                _emit_assist(assistant_text)
        else:
            print("No image was generated.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
