import { App, Editor, MarkdownView, Modal, Plugin, Menu, Notice, addIcon, MarkdownRenderer, TFile } from 'obsidian';
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

type AnnotationColor = string;

// 定义 HTML 标签的正则结构 (支持多行 + 颜色 class)
const COMMENT_REGEX = /<span class="ob-comment(?:\s+([\w-]+))?" data-note="([\s\S]*?)">([\s\S]*?)<\/span>/g;

const COLOR_OPTIONS: { value: AnnotationColor; label: string; hex: string }[] = [
	{ value: "red", label: "红色", hex: "#e5484d" },
	{ value: "", label: "橙色 (默认)", hex: "#ff9900" }, // Orange is default (empty class)
	{ value: "yellow", label: "黄色", hex: "#e6c229" },
	{ value: "green", label: "绿色", hex: "#2f9d62" },
	{ value: "cyan", label: "青色", hex: "#1abc9c" },
	{ value: "blue", label: "蓝色", hex: "#3498db" },
	{ value: "purple", label: "紫色", hex: "#9b59b6" },
	{ value: "gray", label: "灰色", hex: "#95a5a6" },
];

const DEFAULT_COLOR: AnnotationColor = "";

function buildAnnotationClass(color: AnnotationColor): string {
	return color ? "ob-comment " + color : "ob-comment";
}

// 软性层通用：安全地将手挂内容存入 HTML data-note
function escapeDataNote(note: string): string {
	return note
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/'/g, "&#39;")
		.replace(/`/g, "&#96;")
		.replace(/\r?\n/g, "&#10;");
}

// 解码 data-note 内的常见 HTML 安全转义
function decodeDataNote(note: string): string {
	return note
		.replace(/&#10;/g, "\n")
		.replace(/&#13;/g, "\r")
		.replace(/&#96;/g, "`")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, "\"")
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&");
}

// 校验并标准化批注的 data-note，避免旧版原始换行/特殊字符破坏 HTML
function normalizeAnnotationsInText(text: string): { text: string; changed: boolean } {
	COMMENT_REGEX.lastIndex = 0;
	let result = "";
	let lastIndex = 0;
	let changed = false;
	let match;

	while ((match = COMMENT_REGEX.exec(text)) !== null) {
		const fullMatch = match[0];
		const colorClass = match[1] || "";
		const rawNote = match[2];
		const visibleText = match[3];

		const safeNote = escapeDataNote(decodeDataNote(rawNote));
		const replacement = `<span class="${buildAnnotationClass(colorClass)}" data-note="${safeNote}">${visibleText}</span>`;

		result += text.slice(lastIndex, match.index) + replacement;
		lastIndex = match.index + fullMatch.length;
		if (replacement !== fullMatch) changed = true;
	}

	result += text.slice(lastIndex);
	return { text: changed ? result : text, changed };
}

export default class AnnotationPlugin extends Plugin {
	tooltipEl: HTMLElement | null = null;
	static lastUsedColor: AnnotationColor = DEFAULT_COLOR; // 记忆上次使用的颜色

	onload() {
		// 0. 注册彩色圆点图标 (用于右键菜单)
		COLOR_OPTIONS.forEach(opt => {
			const iconId = opt.value ? `ob-annotation-icon-${opt.value}` : `ob-annotation-icon-default`;
			// 使用实心圆，显式设置 fill/stroke，避免被主题的 fill:none 覆盖导致看不见
			// Adjust cy to 25 per user request and allow overflow to fix clipping
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="66" height="66" viewBox="0 0 24 24" style="overflow: visible"><circle cx="12" cy="20" r="10" style="fill:${opt.hex};stroke:${opt.hex};stroke-width:1;" /></svg>`;
			addIcon(iconId, svg);
		});

		// 1. 注册“添加批注”命令
		this.addCommand({
			id: 'add-annotation-html',
			name: '添加批注 (默认)',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.handleAddCommand(editor);
			}
		});

		// 注册特定颜色命令
		COLOR_OPTIONS.forEach(opt => {
			if (opt.value === "") return;
			this.addCommand({
				id: `add-annotation-${opt.value}`,
				name: `添加批注 (${opt.label})`,
				editorCallback: (editor: Editor) => {
					this.handleAddCommand(editor, opt.value);
				}
			});
		});
		
		// 注册一键开关命令
		this.addCommand({
			id: 'toggle-annotation-visibility',
			name: '显示/隐藏批注样式',
			callback: () => {
				document.body.classList.toggle('ob-hide-annotations');
			}
		});

		// 注册编辑/删除快捷键命令
		this.addCommand({
			id: 'edit-current-annotation',
			name: '编辑当前批注',
			editorCallback: (editor: Editor) => {
				this.handleEditCommand(editor);
			}
		});

		this.addCommand({
			id: 'delete-current-annotation',
			name: '删除当前批注',
			editorCallback: (editor: Editor) => {
				this.handleDeleteCommand(editor);
			}
		});

		// 修复当前文件的批注 data-note 格式
		this.addCommand({
			id: 'normalize-annotation-data-note-current',
			name: '修复当前文件的批注 data-note',
			editorCallback: async (editor: Editor) => {
				await this.normalizeCurrentFileAnnotations(editor);
			}
		});

		// 修复全库所有 Markdown 文件的批注 data-note
		this.addCommand({
			id: 'normalize-annotation-data-note-vault',
			name: '修复所有 Markdown 文件的批注 data-note',
			callback: async () => {
				await this.normalizeAllMarkdownFiles();
			}
		});

		// 2. 注册 CodeMirror 扩展 (Live Preview 渲染)
		this.registerEditorExtension(livePreviewAnnotationPlugin);

		// 3. 初始化全局 Tooltip
		this.createTooltipElement();

		// 4. 注册全局鼠标悬浮事件 (桌面端)
		this.registerDomEvent(document, 'mouseover', (evt: MouseEvent) => {
			// 如果隐藏模式开启，不显示 tooltip
			if (document.body.classList.contains('ob-hide-annotations')) return;

			const target = evt.target as HTMLElement;
			if (target && target.hasClass && target.hasClass('ob-comment')) {
				const note = target.getAttribute('data-note');
				if (note) this.showTooltip(evt, note);
			}
		});

		this.registerDomEvent(document, 'mouseout', (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			if (target && target.hasClass && target.hasClass('ob-comment')) {
				this.hideTooltip();
			}
		});

		// 移动端/点击支持：点击批注显示 Tooltip
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			if (document.body.classList.contains('ob-hide-annotations')) return;
			
			const target = evt.target as HTMLElement;
			if (target && target.hasClass && target.hasClass('ob-comment')) {
				const note = target.getAttribute('data-note');
				if (note) this.showTooltip(evt, note);
			} else {
				// 点击空白处隐藏 (仅当不是 tooltip 本身)
				if (this.tooltipEl && !this.tooltipEl.contains(target)) {
					this.hideTooltip();
				}
			}
		});
		
		// 修正 mousedown: 只有当点击的不是批注时才隐藏，避免跟 click 冲突
		this.registerDomEvent(document, 'mousedown', (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			if (target && target.hasClass && target.hasClass('ob-comment')) {
				return; // 点击的是批注，交给 click 处理
			}
			this.hideTooltip();
		});

		this.registerDomEvent(document, 'keydown', () => {
			this.hideTooltip();
		});

		// 5. [新增] 注册右键菜单事件
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view: MarkdownView) => {
				this.handleContextMenu(menu, editor);
			})
		);
	}

	onunload() {
		if (this.tooltipEl) {
			this.tooltipEl.remove();
		}
	}

	// --- 核心逻辑区 ---

	/**
	 * 命令触发：编辑当前批注
	 */
	handleEditCommand(editor: Editor) {
		const existing = this.findAnnotationAtCursor(editor);
		if (existing) {
			new AnnotationModal(this.app, existing.note, existing.color || DEFAULT_COLOR, (newNote, newColor) => {
				const safeNote = escapeDataNote(newNote);
				const replacement = `<span class="${buildAnnotationClass(newColor)}" data-note="${safeNote}">${existing.text}</span>`;
				editor.replaceRange(replacement, existing.from, existing.to);
			}).open();
		} else {
			new Notice("光标处没有批注");
		}
	}

	/**
	 * 命令触发：删除当前批注
	 */
	handleDeleteCommand(editor: Editor) {
		const existing = this.findAnnotationAtCursor(editor);
		if (existing) {
			editor.replaceRange(existing.text, existing.from, existing.to);
		} else {
			new Notice("光标处没有批注");
		}
	}

	/**
	 * 处理右键菜单逻辑
	 */
	handleContextMenu(menu: Menu, editor: Editor) {
		// 检查光标下是否存在已有的批注
		const existingAnnotation = this.findAnnotationAtCursor(editor);

		if (existingAnnotation) {
			// === 场景 A：光标在批注上 ===
			
			menu.addSeparator();

			// 1. 添加批注
			menu.addItem((item) => {
				item
					.setTitle("添加批注")
					.setIcon("highlighter")
					.onClick(() => {
						const selection = editor.getSelection();
						if(selection) this.performAddAnnotation(editor, selection);
						else new Notice("请先选择文本以添加新批注");
					});
			});

			// 2. 编辑批注
			menu.addItem((item) => {
				item
					.setTitle("编辑批注")
					.setIcon("pencil")
					.onClick(() => {
						this.handleEditCommand(editor);
					});
			});

			// 3. 修改颜色 (子菜单)
			menu.addItem((item) => {
				item.setTitle(" - 修改颜色").setIcon("palette");
				// @ts-ignore
				if (item.setSubmenu) {
					const subMenu = item.setSubmenu();
					COLOR_OPTIONS.forEach(opt => {
						const iconId = opt.value ? `ob-annotation-icon-${opt.value}` : `ob-annotation-icon-default`;
						subMenu.addItem((subItem: any) => {
							subItem.setTitle(opt.label)
								   .setIcon(iconId) // 使用注册的彩色图标
								   .onClick(() => {
									   // 直接修改颜色
									   const replacement = `<span class="${buildAnnotationClass(opt.value)}" data-note="${escapeDataNote(existingAnnotation.note)}">${existingAnnotation.text}</span>`;
									   editor.replaceRange(replacement, existingAnnotation.from, existingAnnotation.to);
								   });
						});
					});
				}
			});

			// 4. 删除批注
			menu.addItem((item) => {
				item
					.setTitle("删除批注")
					.setIcon("trash")
					.onClick(() => {
						this.handleDeleteCommand(editor);
					});
			});

		} else {
			// === 场景 B：光标不在批注上 -> 检查是否有选区 -> 显示 添加 ===
			const selection = editor.getSelection();
			if (selection && selection.trim().length > 0) {
				menu.addSeparator();

				menu.addItem((item) => {
					item
						.setTitle("添加批注")
						.setIcon("highlighter")
						.onClick(() => {
							this.performAddAnnotation(editor, selection);
						});
				});
			}
		}
	}

	/**
	 * 命令触发的添加逻辑
	 */
	handleAddCommand(editor: Editor, forcedColor: AnnotationColor | null = null) {
		const selection = editor.getSelection();
		if (!selection) {
			new Notice("请先选择一段文本");
			return;
		}
		// 检查选区内是否已经包含了 HTML 标签，防止嵌套（可选）
		if (selection.includes('<span class="ob-comment"')) {
			new Notice("不支持在已有批注上嵌套批注，请先删除旧批注");
			return;
		}
		this.performAddAnnotation(editor, selection, forcedColor);
	}

	/**
	 * 执行添加批注动作
	 */
	performAddAnnotation(editor: Editor, selectionText: string, forcedColor: AnnotationColor | null = null) {
		// 优先使用强制颜色(如来自快捷命令)，否则使用记忆的颜色
		const initialColor = forcedColor !== null ? forcedColor : AnnotationPlugin.lastUsedColor;

		new AnnotationModal(this.app, "", initialColor, (noteContent, colorChoice) => {
			// 更新记忆的颜色 (通常即使是强制颜色操作，也更新记忆比较符合直觉，方便连续操作)
			AnnotationPlugin.lastUsedColor = colorChoice;

			const safeNote = escapeDataNote(noteContent);
			const replacement = `<span class="${buildAnnotationClass(colorChoice)}" data-note="${safeNote}">${selectionText}</span>`;
			editor.replaceSelection(replacement);
		}).open();
	}

	/**
	 * [辅助算法] 扫描全文，判断光标是否位于某个批注 HTML 标签内部
	 */
	findAnnotationAtCursor(editor: Editor) {
		const cursor = editor.getCursor();
		const cursorOffset = editor.posToOffset(cursor);
		const docText = editor.getValue();

		// 重置正则索引
		COMMENT_REGEX.lastIndex = 0;
		let match;

		// 遍历全文所有的批注
		while ((match = COMMENT_REGEX.exec(docText)) !== null) {
			const fullMatch = match[0];    // 完整的 <span...>text</span>
			const colorClass = match[1] || "";
			const noteContent = match[2];  // data-note="..."
			const innerText = match[3];    // <span>包裹的文本</span>
			
			const startOffset = match.index;
			const endOffset = startOffset + fullMatch.length;

			// 判断光标位置是否在这个范围内
			if (cursorOffset >= startOffset && cursorOffset <= endOffset) {
				return {
					from: editor.offsetToPos(startOffset),
					to: editor.offsetToPos(endOffset),
					text: innerText, // 原文
					note: decodeDataNote(noteContent), // 笔记内容（解码后）
					color: colorClass
				};
			}
		}
		return null;
	}

	// --- Tooltip 相关逻辑 (保持不变) ---
	createTooltipElement() {
		this.tooltipEl = document.body.createDiv({ cls: 'ob-annotation-tooltip' });
	}

	showTooltip(evt: MouseEvent, text: string) {
		if (!this.tooltipEl) return;
		
		this.tooltipEl.empty();
		// 解码 text 中的 HTML 实体（如 &#10; -> \n），确保 Markdown 表格等语法能正确识别换行
		const decodedText = decodeDataNote(text);
		// 使用当前激活文件的路径作为 sourcePath，以支持相对路径链接等
		const sourcePath = this.app.workspace.getActiveFile()?.path || "";
		MarkdownRenderer.render(this.app, decodedText, this.tooltipEl, sourcePath, this);

		this.tooltipEl.addClass('is-visible');
		const x = evt.pageX;
		const y = evt.pageY - 40;
		this.tooltipEl.style.left = `${x}px`;
		this.tooltipEl.style.top = `${y}px`;
	}

	hideTooltip() {
		if (!this.tooltipEl) return;
		this.tooltipEl.removeClass('is-visible');
	}

	/**
	 * 修复当前文件中所有批注的 data-note（处理旧版直接换行/特殊字符未转义的情况）
	 */
	private async normalizeCurrentFileAnnotations(editor: Editor) {
		const docText = editor.getValue();
		const { text, changed } = normalizeAnnotationsInText(docText);

		if (!changed) {
			new Notice("未发现需要修复的批注");
			return;
		}

		const cursor = editor.getCursor();
		
		// 使用 replaceRange 替代 setValue 以保留撤销历史
		const lastLine = editor.lastLine();
		const lastLineLen = editor.getLine(lastLine).length;
		editor.replaceRange(text, { line: 0, ch: 0 }, { line: lastLine, ch: lastLineLen });
		
		editor.setCursor(cursor);
		new Notice("当前文件的批注已转换为安全格式");
	}

	/**
	 * 扫描并修复库内所有 Markdown 文件的批注 data-note
	 */
	private async normalizeAllMarkdownFiles() {
		new Notice("开始扫描库文件，请稍候...");
		const files = this.app.vault.getMarkdownFiles();
		const filesToFix: TFile[] = [];

		// 1. 扫描阶段
		for (const file of files) {
			const original = await this.app.vault.read(file);
			const { changed } = normalizeAnnotationsInText(original);
			if (changed) {
				filesToFix.push(file);
			}
		}

		if (filesToFix.length === 0) {
			new Notice("未发现需要修复的批注");
			return;
		}

		// 2. 确认阶段
		new BatchFixConfirmModal(this.app, filesToFix, async () => {
			let fixedCount = 0;
			// 3. 执行阶段
			for (const file of filesToFix) {
				const original = await this.app.vault.read(file);
				const { text, changed } = normalizeAnnotationsInText(original);
				if (changed) {
					await this.app.vault.modify(file, text);
					fixedCount++;
				}
			}
			new Notice(`已成功修复 ${fixedCount} 个 Markdown 文件的批注`);
		}).open();
	}
}

// --- 弹窗输入框类 (升级：支持默认值 + 颜色选择) ---
class AnnotationModal extends Modal {
	result: string;
	defaultValue: string;
	defaultColor: AnnotationColor;
	selectedColor: AnnotationColor;
	colorLabelEl: HTMLElement | null = null; // 显示当前选中的颜色名称
	onSubmit: (result: string, color: AnnotationColor) => void;

	constructor(app: App, defaultValue: string, defaultColor: AnnotationColor, onSubmit: (result: string, color: AnnotationColor) => void) {
		super(app);
		this.defaultValue = defaultValue;
		this.defaultColor = defaultColor;
		this.selectedColor = defaultColor || DEFAULT_COLOR; // 确保有选中值
		this.onSubmit = onSubmit;
		this.modalEl.addClass("ob-annotation-modal-container");
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: this.defaultValue ? "编辑批注" : "输入批注内容" });

		const inputEl = contentEl.createEl("textarea", { 
			cls: "annotation-input",
			attr: { rows: "3", style: "width: 100%; margin-bottom: 10px;" } 
		});
		
		// 填入默认值
		inputEl.value = this.defaultValue;
		// 稍微延迟聚焦，确保 UI 渲染完成
		setTimeout(() => {
			inputEl.focus();
			// 如果是编辑模式，全选文本方便修改
			if (this.defaultValue) inputEl.select();
		}, 0);

		// --- 颜色选择区域 ---
		const colorWrapper = contentEl.createDiv({ cls: "annotation-color-field" });
		
		const colorHeader = colorWrapper.createDiv({ 
			cls: "setting-item-name", 
			attr: { style: "margin-bottom: 8px; font-weight: bold; display: flex; justify-content: space-between; align-items: center;" } 
		});
		colorHeader.createSpan({ text: "批注颜色" });
		this.colorLabelEl = colorHeader.createSpan({ 
			cls: "annotation-color-label", 
			attr: { style: "font-weight: normal; font-size: 0.9em; color: var(--text-muted);" } 
		});
		
		const colorContainer = colorWrapper.createDiv({ cls: "annotation-color-container" });
		
		// 渲染颜色选项圆点
		COLOR_OPTIONS.forEach(opt => {
			const colorItem = colorContainer.createDiv({ 
				cls: "annotation-color-item",
				attr: { "aria-label": opt.label, "title": opt.label, "tabindex": "0" } // 支持键盘 Tab 聚焦
			});
			colorItem.style.backgroundColor = opt.hex;

			// 检查是否为当前选中颜色
			if (opt.value === this.selectedColor) {
				colorItem.addClass("is-active");
				this.updateColorLabel(opt.label);
			}

			// 选中逻辑
			const selectAction = () => {
				// 移除其他选中状态
				colorContainer.querySelectorAll(".annotation-color-item").forEach(el => el.removeClass("is-active"));
				// 选中当前
				colorItem.addClass("is-active");
				// 更新状态
				this.selectedColor = opt.value;
				this.updateColorLabel(opt.label);
			};

			// 鼠标点击
			colorItem.addEventListener("click", selectAction);

			// 键盘操作 (Enter 或 Space)
			colorItem.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					selectAction();
				}
			});
		});

		inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && e.shiftKey) {
				// Shift + Enter -> 换行
				return;
			}
			if (e.key === "Enter") {
				e.preventDefault();
				this.submit(inputEl.value);
			}
		});

		const btnContainer = contentEl.createDiv({ cls: "modal-button-container" });
		// 取消按钮
		const cancelBtn = btnContainer.createEl("button", { text: "取消" });
		cancelBtn.addEventListener("click", () => this.close());

		// 确定按钮
		const submitBtn = btnContainer.createEl("button", { text: "确定", cls: "mod-cta" });
		submitBtn.addEventListener("click", () => {
			this.submit(inputEl.value);
		});
	}

	updateColorLabel(label: string) {
		if (this.colorLabelEl) {
			this.colorLabelEl.setText(label);
		}
	}

	submit(value: string) {
		this.onSubmit(value, this.selectedColor);
		this.close();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// --- 批量修复确认弹窗 ---
class BatchFixConfirmModal extends Modal {
	filesToFix: TFile[];
	onConfirm: () => void;

	constructor(app: App, filesToFix: TFile[], onConfirm: () => void) {
		super(app);
		this.filesToFix = filesToFix;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "⚠️ 批量修复确认" });

		contentEl.createEl("p", { 
			text: `扫描发现共有 ${this.filesToFix.length} 个文件包含旧格式或需要规范化的批注。` 
		});
		
		contentEl.createEl("p", { 
			text: "执行修复将更新这些文件中的 HTML 结构（主要是 data-note 属性的安全转义）。建议在执行前对 Vault 进行备份。",
			cls: "mod-warning"
		});

		// 移除了文件列表预览区域

		const btnContainer = contentEl.createDiv({ cls: "modal-button-container", attr: { style: "display: flex; justify-content: flex-end; gap: 10px;" } });
		
		const cancelBtn = btnContainer.createEl("button", { text: "取消" });
		cancelBtn.addEventListener("click", () => this.close());

		const confirmBtn = btnContainer.createEl("button", { text: `确认修复 (${this.filesToFix.length} 个文件)`, cls: "mod-cta" });
		confirmBtn.addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

// --- CodeMirror 6 扩展 (保持不变) ---
const livePreviewAnnotationPlugin = ViewPlugin.fromClass(class {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.buildDecorations(view);
	}

	update(update: ViewUpdate) {
		if (update.docChanged || update.viewportChanged || update.selectionSet) {
			this.decorations = this.buildDecorations(update.view);
		}
	}

	buildDecorations(view: EditorView) {
		const builder = new RangeSetBuilder<Decoration>();
		const text = view.state.doc.toString();
		const selection = view.state.selection.main;
		const cursorFrom = selection.from;
		const cursorTo = selection.to;

		let match;
		COMMENT_REGEX.lastIndex = 0;

		while ((match = COMMENT_REGEX.exec(text)) !== null) {
			const fullMatch = match[0];
			const colorClass = match[1] || "";
			const noteContent = match[2];
			const visibleText = match[3];
			const noteText = decodeDataNote(noteContent);
			
			const startPos = match.index;
			const endPos = startPos + fullMatch.length;

			const openingTagLength = fullMatch.indexOf('>') + 1;
			const openingTagFrom = startPos;
			const openingTagTo = startPos + openingTagLength;
			const contentFrom = openingTagTo;
			const contentTo = contentFrom + visibleText.length;
			const closingTagFrom = contentTo;
			const closingTagTo = endPos;

			const isCursorInside = (cursorFrom >= startPos && cursorFrom <= endPos) || 
								   (cursorTo >= startPos && cursorTo <= endPos);

			if (isCursorInside) continue;

			builder.add(openingTagFrom, openingTagTo, Decoration.replace({}));
			builder.add(contentFrom, contentTo, Decoration.mark({
				class: buildAnnotationClass(colorClass),
				attributes: { "data-note": noteText }
			}));
			builder.add(closingTagFrom, closingTagTo, Decoration.replace({}));
		}

		return builder.finish();
	}
}, {
	decorations: v => v.decorations
});
