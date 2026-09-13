import { type App, Modal, Setting } from 'obsidian';
import { buildDiffRows, type DiffRow } from '@/ui/diff';

/**
 * A snapshot's label and note in one dialog — used both to save a new snapshot and to
 * edit an existing one. Resolves to null when cancelled.
 */
export class SnapshotModal extends Modal {
	private name: string;
	private message: string;
	private submitted = false;

	constructor(
		app: App,
		private readonly options: {
			title: string;
			cta: string;
			namePlaceholder?: string;
			initialName?: string;
			initialMessage?: string;
			notice?: string;
		},
		private readonly resolve: (value: { name: string; message: string } | null) => void,
	) {
		super(app);
		this.name = options.initialName ?? '';
		this.message = options.initialMessage ?? '';
	}

	override onOpen(): void {
		this.titleEl.setText(this.options.title);

		if (this.options.notice) {
			this.contentEl.createEl('p', { cls: 'ns-modal-notice', text: this.options.notice });
		}

		new Setting(this.contentEl).setName('Name').addText((text) => {
			text.setValue(this.name).onChange((next) => {
				this.name = next;
			});
			if (this.options.namePlaceholder) text.setPlaceholder(this.options.namePlaceholder);
			text.inputEl.addClass('ns-prompt-input');
			text.inputEl.addEventListener('keydown', (event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					this.submit();
				}
			});
			window.setTimeout(() => {
				text.inputEl.focus();
				text.inputEl.select();
			}, 0);
		});

		new Setting(this.contentEl).setName('Note').addTextArea((area) => {
			area.setValue(this.message).onChange((next) => {
				this.message = next;
			});
			area.setPlaceholder('Optional note about this snapshot');
			area.inputEl.addClass('ns-prompt-input');
			area.inputEl.rows = 4;
		});

		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(this.options.cta)
					.setCta()
					.onClick(() => this.submit()),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
		if (!this.submitted) this.resolve(null);
	}

	private submit(): void {
		this.submitted = true;
		this.resolve({ name: this.name, message: this.message });
		this.close();
	}
}

/** Yes/no confirmation. Resolves false when dismissed. */
export class ConfirmModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly options: { title: string; message: string; cta: string; destructive?: boolean },
		private readonly resolve: (confirmed: boolean) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.options.title);
		this.contentEl.createEl('p', { text: this.options.message, cls: 'ns-confirm-message' });

		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) => {
				button.setButtonText(this.options.cta).onClick(() => {
					this.answered = true;
					this.resolve(true);
					this.close();
				});
				if (this.options.destructive) button.setWarning();
				else button.setCta();
			});
	}

	override onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.resolve(false);
	}
}

/** One button in a {@link ChoiceModal}. */
export interface ModalChoice {
	label: string;
	/** Marks the recommended action. */
	cta?: boolean;
}

/**
 * A prompt with more than two outcomes. Resolves the chosen choice's index, or null
 * when dismissed. Cancel is always offered and is the dismissal.
 */
export class ChoiceModal extends Modal {
	private chosen: number | null = null;

	constructor(
		app: App,
		private readonly options: { title: string; body: string | string[]; list?: string[]; choices: ModalChoice[] },
		private readonly resolve: (index: number | null) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.options.title);
		const paragraphs = Array.isArray(this.options.body) ? this.options.body : [this.options.body];
		for (const text of paragraphs) {
			this.contentEl.createEl('p', { text, cls: 'ns-confirm-message' });
		}

		if (this.options.list && this.options.list.length > 0) {
			const list = this.contentEl.createEl('ul', { cls: 'ns-choice-list' });
			for (const item of this.options.list) list.createEl('li', { text: item });
		}

		const row = new Setting(this.contentEl);
		row.settingEl.addClass('ns-choice-buttons');

		const addChoice = (choice: ModalChoice, index: number, gapAfter = false): void => {
			row.addButton((button) => {
				button.setButtonText(choice.label).onClick(() => {
					this.chosen = index;
					this.resolve(index);
					this.close();
				});
				if (choice.cta) button.setCta();
				if (gapAfter) button.buttonEl.addClass('ns-choice-gap-after');
			});
		};

		// Non-recommended choices are pinned to the far left, with a gap before Cancel
		// and the recommended action on the right — so a stray click lands on the safe
		// cluster, not on the one choice that's easy to pick by mistake.
		const nonCta = this.options.choices.filter((choice) => !choice.cta);
		this.options.choices.forEach((choice, index) => {
			if (!choice.cta) addChoice(choice, index, choice === nonCta[nonCta.length - 1]);
		});
		row.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()));
		this.options.choices.forEach((choice, index) => {
			if (choice.cta) addChoice(choice, index);
		});
	}

	override onClose(): void {
		this.contentEl.empty();
		if (this.chosen === null) this.resolve(null);
	}
}

/** An unchanged run longer than this is folded to a single click-to-expand stub. */
const FOLD_THRESHOLD = 8;
/** Unchanged lines kept visible on each side of a fold, as context around a change. */
const FOLD_CONTEXT = 3;

/** Line-level diff between two texts, with word-level emphasis inside changed lines. */
export class DiffModal extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly before: string,
		private readonly after: string,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.title);
		this.modalEl.addClass('ns-wide-modal');

		const { rows, addedLines, removedLines, identical } = buildDiffRows(this.before, this.after);
		const summary = this.contentEl.createEl('p', { cls: 'ns-diff-summary' });

		if (identical) {
			summary.setText('Identical.');
			return;
		}

		summary.setText(`+${addedLines} / −${removedLines} lines`);
		const body = this.contentEl.createDiv({ cls: 'ns-diff' });
		this.renderRows(body, rows);
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	/** Appends every row, folding long unchanged runs down to an expandable stub. */
	private renderRows(body: HTMLElement, rows: DiffRow[]): void {
		let i = 0;
		while (i < rows.length) {
			if (rows[i]!.kind !== 'ctx') {
				body.append(buildRowEl(rows[i]!));
				i++;
				continue;
			}
			let end = i;
			while (end < rows.length && rows[end]!.kind === 'ctx') end++;
			const run = rows.slice(i, end);
			if (run.length > FOLD_THRESHOLD) {
				run.slice(0, FOLD_CONTEXT).forEach((row) => body.append(buildRowEl(row)));
				this.appendFold(body, run.slice(FOLD_CONTEXT, run.length - FOLD_CONTEXT));
				run.slice(run.length - FOLD_CONTEXT).forEach((row) => body.append(buildRowEl(row)));
			} else {
				run.forEach((row) => body.append(buildRowEl(row)));
			}
			i = end;
		}
	}

	private appendFold(body: HTMLElement, hidden: DiffRow[]): void {
		const count = hidden.length;
		const fold = body.createDiv({
			cls: 'ns-diff-fold',
			text: `⋯ ${count} unchanged line${count === 1 ? '' : 's'}`,
		});
		fold.addEventListener('click', () => {
			fold.before(...hidden.map(buildRowEl));
			fold.remove();
		});
	}
}

/** Builds one `<div>` row: two line-number gutters, a marker, then the diffed text. */
function buildRowEl(row: DiffRow): HTMLDivElement {
	const kind = row.kind;
	const el = document.createElement('div');
	el.className = `ns-diff-line ns-diff-${kind}`;

	const oldGutter = el.createDiv({ cls: 'ns-diff-gutter' });
	oldGutter.setText(row.oldNumber === null ? '' : String(row.oldNumber));
	const newGutter = el.createDiv({ cls: 'ns-diff-gutter' });
	newGutter.setText(row.newNumber === null ? '' : String(row.newNumber));

	el.createDiv({ cls: 'ns-diff-marker', text: kind === 'add' ? '+' : kind === 'del' ? '−' : ' ' });

	const text = el.createDiv({ cls: 'ns-diff-text' });
	for (const segment of row.segments) {
		if (segment.emphasis) text.createSpan({ cls: 'ns-diff-emph', text: segment.text });
		else text.appendText(segment.text);
	}
	return el;
}
