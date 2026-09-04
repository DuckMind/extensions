---
name: image-generation
version: 0.1.0
description: Generate real image artifacts with dm-image2 via the bundled image_generation tool backed by the imagen.py lane. Use when the user asks to create, render, illustrate, or regenerate an image instead of just discussing or writing a prompt.
---

# Image Generation

Use this skill whenever the user wants an actual image artifact, not just a prompt.

This skill includes a pattern-only prompt cookbook distilled from public GPT image prompt/reference-case collections. Use the patterns as reusable visual workflows, but **do not call external image APIs** and do not depend on external image-generation skill archives. DM image creation must route through the local `image_generation` tool.

Examples:
- "Tạo ảnh một chú mèo dễ thương"
- "Generate a poster for my event"
- "Make a logo mockup"
- "Create an illustration of a busy street in Hanoi"
- "Render a portrait / product shot / diagram / cover image"

## Primary rule

When the user asks for an image, you should **call `image_generation`** instead of stopping at a text-only answer.
Do not just provide a prompt unless the user explicitly asks for a prompt.
Do not dump raw SVG or base64 in the final answer.
The goal is to save a real image artifact to disk and return its path.

## What tool to use

Use the dedicated `image_generation` tool from `dm-image2`.

This tool is designed to:
- generate a saved image artifact on disk
- prefer the bundled `imagen.py` lane for PNG output
- use the active DM Ultradex / Codex credentials
- return a saved file path and inline preview when available

Default save behavior:
- `save=project` → `<cwd>/.dm/generated-images/`
- `save=global` → `~/.dm/agent/generated-images/`
- `save=custom` → `saveDir`

## Supported parameters

- `prompt` — required, detailed visual direction
- `aspectRatio` — optional: `1:1`, `4:5`, `16:9`
- `model` — optional; Ultra image generation always uses `gpt-5.5`
- `outputFormat` — optional: `png`, `svg`
- `save` — optional: `project`, `global`, `custom`
- `saveDir` — required only when `save=custom`

## Default behavior you should prefer

Unless the user says otherwise:
- use `outputFormat: "png"`
- use `aspectRatio: "1:1"` for general images
- use `save: "project"`
- keep the prompt concrete and production-ready

Suggested aspect ratios:
- `1:1` for avatars, icons, stickers, square illustrations
- `4:5` for posters, portraits, social posts
- `16:9` for landscapes, banners, slides, cinematic scenes

## Prompt construction rules

Build the `prompt` as art direction, not as chatty prose.
Include the information that matters for the final image:
- main subject
- pose or action
- setting/background
- style
- mood
- lighting
- color palette
- composition / camera framing when relevant
- important constraints to preserve

Good prompt shape:
1. Subject
2. Scene and action
3. Style and visual treatment
4. Lighting and mood
5. Composition / framing
6. Quality or production notes

Example:
- "A cute fluffy puppy with large sparkling eyes, sitting on green grass in a sunny park, soft golden fur, warm morning light, pastel colors, wholesome and charming mood, clean composition, highly polished illustration"

## Reusable prompt pattern library

Choose one pattern family before writing the final tool prompt. Combine at most two families unless the user explicitly asks for a complex board or exploration.

### 1. Product hero / e-commerce

Use for products, food, packaging, gadgets, bottles, apparel, or marketplace images.

Prompt recipe:
1. single hero product with exact material, label, finish, and scale
2. commercial setting: studio surface, lifestyle table, miniature diorama, or outdoor context
3. sensory detail: condensation, gloss, steam, texture, fabric, glass refraction, crumbs, foam, splash
4. controlled lighting and palette: premium studio, warm side light, high-key clean, moody luxury, or fresh daylight
5. restrained typography only when the user asks for ad copy

Quality notes:
- keep product identity locked and avoid extra products
- specify no watermark/logos unless user supplied brand text
- use `1:1` for marketplace hero shots, `4:5` for social commerce posters

Template:
- "`[product]` as the single hero subject, `[material/label/finish]`, placed in `[setting]`, surrounded by `[supporting props/effects]`, `[lighting]`, `[palette]`, commercial product photography, realistic texture, clean composition, no unrelated objects, no watermark."

### 2. Ad creative / campaign storyboard

Use for campaign concepts, launch ads, multi-panel storyboards, merch boards, and social ads.

Prompt recipe:
1. campaign goal and audience
2. visual system: hero frame, grid, panels, stickers, badges, icons, or motion arrows
3. brand world: palette, typography mood, props, setting, and tone
4. exact panel count when needed
5. copy constraints: short labels only; avoid paragraphs in the image

Quality notes:
- make layout explicit: "9-panel grid", "2x2 editorial board", "hero frame plus three detail callouts"
- ask for consistent product/character identity across panels
- reserve readable text for a few large labels only

Template:
- "Create a `[panel count/layout]` campaign board for `[brand/product/event]`, with `[hero scene]`, `[detail panels]`, `[palette]`, `[typography style]`, concise labels, consistent identity, premium advertising finish."

### 3. Editorial portrait / photography

Use for portraits, fashion, lifestyle, cinematic people scenes, and personal branding.

Prompt recipe:
1. subject identity constraints that are safe and relevant
2. pose, gaze, expression, gesture, wardrobe
3. location and environmental story
4. camera language: lens feel, crop, depth of field, film grain, motion blur
5. skin/rendering constraints: natural texture, no plastic skin, no over-sharpening

Quality notes:
- for public figures or real people, research first and preserve known visual facts without inventing claims
- mention lighting direction and color grade
- include "no watermark, no extra limbs, no distorted hands/faces" when useful

Template:
- "Ultra-realistic editorial portrait of `[subject]`, `[pose/expression]`, wearing `[wardrobe]` in `[setting]`, `[lens/framing]`, `[lighting/color grade]`, natural skin texture, cinematic but believable, no watermark."

### 4. Poster / illustration / map

Use for city posters, travel art, food maps, fantasy scenes, vintage prints, and stylized illustration.

Prompt recipe:
1. central concept and subject
2. poster layout: centered, diagonal, symmetrical, split-era, map-like, or collage
3. illustration language: vintage travel, botanical print, crayon, manga, cinematic concept art, risograph
4. palette and typography constraints
5. negative space and border behavior

Quality notes:
- if text is needed, specify exact short words and placement
- if text is not needed, say "no text"
- for culture/city details, research first and name landmarks, local objects, signage style, or food accurately

Template:
- "`[poster type]` of `[subject/place]`, `[layout]`, `[style]`, `[palette]`, `[local details/props]`, crisp composition, production-ready print art, `[text rule]`."

### 5. Character design / reference sheet

Use for mascots, game characters, anime conversions, model sheets, costumes, and worldbuilding visuals.

Prompt recipe:
1. character role, silhouette, age range if relevant, personality
2. outfit, props, symbols, color palette
3. pose set or sheet format: front/back/side, expressions, accessories, action pose
4. background or world context
5. consistency constraints across views

Quality notes:
- request clean separation between panels
- keep same face, costume, palette, and proportions across the sheet
- use `16:9` or `4:5` depending on sheet density

Template:
- "Character reference sheet for `[character]`, consistent design across `[views/poses]`, `[outfit/props]`, `[palette]`, expression callouts, clean panel layout, high detail, no random costume changes."

### 6. UI / social mockup / infographic

Use for app screens, social posts, dashboards, presentation boards, labels, and comparison graphics.

Prompt recipe:
1. device or canvas type
2. information architecture: header, cards, feed, chart, side-by-side comparison, annotations
3. style system: material, dark mode, playful notebook, luxury minimal, neon cyberpunk
4. readable short labels and hierarchy
5. realistic screenshot or designed mockup behavior

Quality notes:
- keep text short and high contrast
- state the number of cards/screens/panels
- if exact UI copy matters, include it as a short list

Template:
- "Design a `[device/canvas]` UI mockup for `[topic]`, with `[layout]`, `[components]`, `[style system]`, readable short labels, polished product-design presentation, no clutter."

### 7. Prompt exploration / comparison board

Use when the user asks to explore styles, compare variants, or generate a visual test set.

Prompt recipe:
1. one stable subject or concept
2. 2–6 variants with explicit axes: lighting, era, medium, palette, camera, composition, texture
3. consistent grid layout
4. concise variant labels if needed
5. evaluation goal: pick strongest brand fit, realism, mood, or composition

Quality notes:
- keep the base subject unchanged between variants
- vary only the declared axes
- prefer `16:9` for wide boards and `1:1` for compact grids

Template:
- "Create a `[grid size]` comparison board of `[stable subject]`, each panel varying only `[axis list]`, consistent framing, concise labels, useful for choosing `[goal]`."

## Prompt exploration workflow

When the user gives a vague image request:
1. infer the likely deliverable: product, ad, portrait, poster, character, UI, or exploration
2. choose the pattern family and aspect ratio
3. expand the prompt with concrete subject, setting, style, lighting, composition, and constraints
4. call `image_generation`
5. return the saved path and ask whether to iterate on one clear axis

When the user asks for "three options" or "random cases", generate three distinct pattern families instead of three minor wording variants.

Safe random case set:
- product hero: premium drink or gadget ad, `4:5`
- poster/illustration: city/culture print or cinematic scene, `16:9`
- UI/comparison board: compact design system or variant grid, `1:1` or `16:9`

## Research-before-render rule

If the image must reflect real facts, public figures, specific products, landmarks, or culturally specific details, do lightweight research first when possible.
Then pass the researched facts into `prompt` so the final image preserves the important details.

Use this especially for:
- real cities and landmarks
- public people
- branded products
- historically or culturally specific scenes
- diagrams that must match real systems

## Natural language interpretation rule

When the user says things like:
- "tạo ảnh"
- "sinh ảnh"
- "vẽ cho tôi"
- "generate an image"
- "make me a picture"

you should interpret that as a request to produce an actual artifact and call `image_generation`.
Do not force the user to ask for a "prompt" first.

## Failure handling

If `image_generation` fails:
1. explain briefly that image generation failed
2. include the main failure reason
3. do not pretend the image was created
4. offer one concrete retry path only if useful

Do not silently replace a failed image request with a text description.

## Final answer format

After a successful tool call, answer briefly with:
- what was created
- the saved file path
- any key output details only if helpful

Example:
- "Đã tạo ảnh và lưu tại: `.dm/generated-images/image-...png`"

## Example tool calls

### 1. Simple cute animal

```json
{
  "prompt": "A cute fluffy puppy with big sparkling eyes, soft golden fur, sitting happily on green grass in a sunny park, warm soft light, pastel color palette, ultra adorable polished illustration",
  "aspectRatio": "1:1",
  "outputFormat": "png",
  "save": "project"
}
```

### 2. Hanoi street scene

```json
{
  "prompt": "A lively street in Hanoi, Vietnam, dense motorbike traffic, narrow shopfronts, colorful Vietnamese signage, street food stalls, humid afternoon atmosphere, realistic local details, cinematic composition, production-ready travel editorial image",
  "aspectRatio": "16:9",
  "outputFormat": "png",
  "save": "project"
}
```

### 3. Poster-style portrait

```json
{
  "prompt": "A presentation-ready portrait poster of a young woman, confident pose, clean studio background, soft dramatic lighting, elegant color palette, polished editorial style, sharp composition",
  "aspectRatio": "4:5",
  "outputFormat": "png",
  "save": "project"
}
```

## Anti-patterns

Do not:
- stop at "I cannot generate images" when the tool is available
- reply with only a prompt when the user asked for an image
- emit raw SVG markup in the final answer unless the user explicitly asked for SVG source
- ignore aspect ratio when the use case clearly implies one
- invent success when the tool failed
- over-explain the tool internals unless the user asks

## Success criteria

You succeeded when:
1. the user asked for an image
2. you called `image_generation`
3. a real artifact was saved to disk
4. you returned the saved path clearly
