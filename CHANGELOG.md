## v1.3.0 – Color Revolution & UX Renewal (Dec 10, 2025)

### Feature 1: New Color System & Visual Interaction
- **Summary**: Expanded annotation colors to 8, introduced a new visual color picker and colorful icons in the right-click menu.
- **Problem Solved**: The old dropdown menu was cumbersome and lacked visual feedback.
- **Feature Details**:
  - New Colors: Red, Orange (Default), Yellow, Green, Cyan, Blue, Purple, Gray.
  - Modal: Replaced dropdown with circular color swatches, supporting keyboard navigation (Tab/Enter) and remembering the last used color.
  - Context Menu: Submenu displays real colored dot icons for intuitive preview.
  - New Commands: Independent commands registered for each color (e.g., "Add Annotation (Red)") for easy hotkey binding.
- **Technical Implementation**:
  - `main.ts`: Implemented dynamic SVG registration via `addIcon`.
  - `styles.css`: Rewrote `.annotation-color-item` styles for hover/active/focus states.

### Feature 2: Native UI & Mobile Support
- **Summary**: Overhauled the tooltip and modal styles to seamlessly blend with Obsidian's native look, added mobile support.
- **Problem Solved**: The old black tooltip looked out of place; modal width was restrictive; no mobile support.
- **Feature Details**:
  - Tooltip: Uses native CSS variables (`--background-secondary`, etc.) for theme adaptability; added slide-up animation; widened to 800px; increased font size.
  - Modal: Inputs use native Obsidian form styles with larger font.
  - Mobile: Supports clicking annotations to show tooltips.
  - Toggle Switch: New command "Toggle Annotation Visibility" to switch clean reading mode on/off.
- **Technical Implementation**:
  - `styles.css`: Extensive use of `var(--...)` replacing hardcoded colors; added `transition` animations.
  - `main.ts`: Added `click` event listeners; implemented `toggle-annotation-visibility`.

### Feature 3: Context Menu Refactoring
- **Summary**: Optimized the structure, order, and visual feedback of the right-click menu.
- **Problem Solved**: Menu items lacked hierarchy and were scattered.
- **Feature Details**:
  - Order adjusted to: Add -> Edit -> Change Color -> Delete.
  - All items now have icons (highlighter, pencil, palette, trash).
  - Used separators to distinguish plugin functions from other menu items.
- **Technical Implementation**:
  - `main.ts`: Used `menu.addSeparator()` and `setIcon`.

## v1.2.0 — Multi-line Annotations & UX Refinements (2025-12-09)

### Feature 1: Multi-line annotations with safe storage
- **Summary**: Support cross-line annotations with safe encode/decode of note content.
- **Problem Solved**: Previously multi-line annotations failed to render/operate, and special characters could break the HTML attribute.
- **Feature Details**: Multi-line selections stay recognizable for hover, context-menu edit/delete, and Live Preview hiding; note text keeps its line breaks and symbols intact.
- **Technical Implementation**: 
  - COMMENT_REGEX now spans lines via `[\s\S]*?` and uses `posToOffset/offsetToPos` to locate ranges across the whole doc.
  - Added `escapeDataNote`/`decodeDataNote` to fully escape `&`, `<`, `>`, quotes, backticks, and newlines in `data-note`, decoding before edit and re-encoding on save.
  - Live Preview decorations use decoded note text so hover/context-menu shows the correct content.

### Feature 2: Modal input & tooltip behavior polish
- **Summary**: Refine submit/newline handling in the annotation modal and auto-hide the tooltip after interactions.
- **Problem Solved**: Enter only inserted newlines and the tooltip could block text after clicks/keystrokes.
- **Feature Details**: Enter submits the note; Shift+Enter inserts a newline; any mouse click or key press hides the tooltip.
- **Technical Implementation**: 
  - Modal keydown logic updated: Enter submits, Shift+Enter keeps newline insertion.
  - Tooltip now listens to `mousedown`/`keydown` to call `hideTooltip`, alongside the existing mouseout behavior.

## v1.1.0 — Initial Public Release (2025-11-20)

### Feature 1: Insert annotations plus right-click edit/delete
- **Summary**: Command and context-menu flow to add, edit, or remove annotations quickly.
- **Problem Solved**: Needed a fast way to mark text in the editor and adjust or remove it later.
- **Feature Details**: Selected text is wrapped in `<span class="ob-comment" data-note="...">`; when the cursor is on an annotation, right-click shows edit/delete to replace the content directly.
- **Technical Implementation**: 
  - `add-annotation-html` command plus `handleContextMenu` with `findAnnotationAtCursor` to locate annotations and `replaceRange` updates.
  - `AnnotationModal` gathers note text and writes it into `data-note` while preserving the original visible text.

### Feature 2: Hover display and Live Preview HTML hiding
- **Summary**: Show annotation notes on hover while hiding verbose HTML in edit mode.
- **Problem Solved**: Raw HTML tags cluttered the writing/reading experience.
- **Feature Details**: Hovering shows a tooltip in reading and preview; edit mode hides `<span>` tags and only highlights annotated text.
- **Technical Implementation**: 
  - Global `mouseover`/`mouseout` to show/hide tooltip.
  - CodeMirror `ViewPlugin` uses `Decoration.replace/mark` to hide tags and mark content, skipping annotations containing the active cursor.