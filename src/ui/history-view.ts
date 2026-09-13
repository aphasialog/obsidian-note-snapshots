import { debounce, ItemView, Menu, Notice, setIcon, TFile, type WorkspaceLeaf } from 'obsidian';
import type { SnapshotRow, WorkingState } from '@/types';
import type NoteSnapshotsPlugin from '@/main';
import { DiffModal } from '@/ui/modals';
import { formatAbsolute, formatBytes, formatRelative, formatSnapshotLabel } from '@/ui/format';

export const VIEW_TYPE_HISTORY = 'ns-snapshot-history';

export class HistoryView extends ItemView {
	private file: TFile | null = null;
	private noteId: string | null = null;
	private rows: SnapshotRow[] = [];
	private working: WorkingState = { kind: 'untracked' };

	private readonly scheduleRefresh = debounce(() => void this.refresh(), 300, true);

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: NoteSnapshotsPlugin,
	) {
		super(leaf);
	}

	override getViewType(): string {
		return VIEW_TYPE_HISTORY;
	}

	override getDisplayText(): string {
		return 'Snapshot history';
	}

	override getIcon(): string {
		return 'history';
	}

	override async onOpen(): Promise<void> {
		this.contentEl.addClass('ns-view');
		this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleRefresh()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleRefresh()));
		this.registerEvent(
			this.app.vault.on('modify', (changed) => {
				if (this.file && changed.path === this.file.path) this.scheduleRefresh();
			}),
		);
		await this.refresh();
	}

	override async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	/** Reloads state for the active note and repaints. */
	async refresh(): Promise<void> {
		const active = this.app.workspace.getActiveFile();
		this.file =
			active && active.extension === 'md' && !this.plugin.paths.isInternal(active.path) ? active : null;

		if (!this.file) {
			this.noteId = null;
			this.rows = [];
			this.working = { kind: 'untracked' };
			this.render();
			return;
		}

		try {
			this.noteId = await this.plugin.identity.resolveNoteId(this.file);
			this.rows = this.noteId ? await this.plugin.snapshots.listSnapshots(this.noteId) : [];
			this.working = await this.plugin.snapshots.getWorkingState(this.file);
		} catch (error) {
			console.error('Note Snapshots: could not load history.', error);
			this.rows = [];
			this.working = { kind: 'untracked' };
		}
		this.render();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();

		if (!this.file) {
			root.createDiv({ cls: 'ns-empty', text: 'Open a markdown note to see its snapshots.' });
			return;
		}

		const header = root.createDiv({ cls: 'ns-header' });
		header.createDiv({ cls: 'ns-file-name', text: this.file.basename });
		header.createDiv({ cls: `ns-state ns-state-${this.working.kind}`, text: this.formatWorkingLabel() });

		const actions = root.createDiv({ cls: 'ns-actions' });
		const save = actions.createEl('button', { cls: 'ns-save', text: 'Save snapshot' });
		save.addEventListener('click', () => void this.plugin.snapshotWithPrompt(this.file));

		const overflow = actions.createEl('button', { cls: 'ns-icon-button', attr: { 'aria-label': 'More' } });
		setIcon(overflow, 'more-vertical');
		overflow.addEventListener('click', (event) => this.showViewMenu(event));

		if (this.rows.length === 0) {
			root.createDiv({
				cls: 'ns-empty',
				text: 'No snapshots yet. Save one to start tracking this note.',
			});
			return;
		}

		const list = root.createDiv({ cls: 'ns-list' });
		this.rows.forEach((row, index) => this.renderRow(list, row, this.rows[index + 1]));
	}

	private renderRow(parent: HTMLElement, row: SnapshotRow, older: SnapshotRow | undefined): void {
		const isCurrent = this.working.kind === 'clean' && this.working.snapshotId === row.snapshotId;
		const element = parent.createDiv({ cls: `ns-row${isCurrent ? ' ns-row-current' : ''}` });

		const main = element.createDiv({ cls: 'ns-row-main' });
		const title = main.createDiv({ cls: 'ns-row-title' });
		title.createSpan({ text: formatSnapshotLabel(row.n, row.name) });
		if (row.locked) {
			const lockIcon = title.createSpan({ cls: 'ns-row-lock-icon', attr: { 'aria-label': 'Locked' } });
			setIcon(lockIcon, 'lock');
		}
		main.createDiv({
			cls: 'ns-row-meta',
			text: `${formatRelative(row.ts)} · ${formatBytes(row.size)}`,
		});
		if (row.message) {
			main.createDiv({ cls: 'ns-row-message', text: row.message, attr: { title: row.message } });
		}
		main.createDiv({ cls: 'ns-row-created', text: `Created ${formatAbsolute(row.ts)}` });

		// Single click diffs against the current note; double click restores. The click
		// action waits briefly so a double click can cancel it and take over.
		let pendingClick: number | null = null;
		main.addEventListener('click', () => {
			if (pendingClick !== null) return;
			pendingClick = window.setTimeout(() => {
				pendingClick = null;
				void this.diffAgainstCurrent(row);
			}, 250);
		});
		main.addEventListener('dblclick', () => {
			if (pendingClick !== null) {
				window.clearTimeout(pendingClick);
				pendingClick = null;
			}
			void this.plugin.restoreSnapshot(this.file, row);
		});

		const menuButton = element.createEl('button', {
			cls: 'ns-icon-button',
			attr: { 'aria-label': `Actions for ${formatSnapshotLabel(row.n, row.name)}` },
		});
		setIcon(menuButton, 'more-vertical');
		menuButton.addEventListener('click', (event) => {
			event.stopPropagation();
			this.showRowMenu(event, row, older);
		});
	}

	private showRowMenu(event: MouseEvent, row: SnapshotRow, older: SnapshotRow | undefined): void {
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle('Restore')
				.setIcon('rotate-ccw')
				.onClick(() => void this.plugin.restoreSnapshot(this.file, row)),
		);
		menu.addItem((item) =>
			item
				.setTitle('Diff against current')
				.setIcon('git-compare')
				.onClick(() => void this.diffAgainstCurrent(row)),
		);
		if (older) {
			menu.addItem((item) =>
				item
					.setTitle(`Diff against V${older.n}`)
					.setIcon('git-compare-arrows')
					.onClick(() => void this.diffAgainstSnapshot(older, row)),
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle('Annotate')
				.setIcon('pencil')
				.onClick(() => void this.plugin.annotateSnapshot(this.noteId, row)),
		);
		menu.addItem((item) =>
			item
				.setTitle(row.locked ? 'Unlock' : 'Lock')
				.setIcon(row.locked ? 'unlock' : 'lock')
				.onClick(() => void this.plugin.toggleLockSnapshot(this.noteId, row)),
		);
		menu.addItem((item) => {
			item
				.setTitle('Delete')
				.setIcon('trash-2')
				.onClick(() => void this.plugin.deleteSnapshot(this.noteId, row));
			if (row.locked) item.setDisabled(true);
		});

		menu.showAtMouseEvent(event);
	}

	private showViewMenu(event: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('Refresh')
				.setIcon('refresh-cw')
				.onClick(() => void this.refresh()),
		);
		if (this.rows.length > 0) {
			menu.addSeparator();
			menu.addItem((item) => {
				item
					.setTitle('Delete all snapshots')
					.setIcon('trash-2')
					.onClick(() => void this.plugin.deleteAllSnapshots(this.noteId, this.file));
				if (this.rows.every((row) => row.locked)) item.setDisabled(true);
			});
		}
		menu.showAtMouseEvent(event);
	}

	private async diffAgainstCurrent(row: SnapshotRow): Promise<void> {
		if (!this.file) return;
		const stored = await this.loadContent(row);
		if (stored === null) return;
		const current = await this.plugin.readContent(this.file);
		new DiffModal(this.app, `V${row.n} → current`, stored, current).open();
	}

	private async diffAgainstSnapshot(older: SnapshotRow, newer: SnapshotRow): Promise<void> {
		const before = await this.loadContent(older);
		const after = await this.loadContent(newer);
		if (before === null || after === null) return;
		new DiffModal(this.app, `V${older.n} → V${newer.n}`, before, after).open();
	}

	private async loadContent(row: SnapshotRow): Promise<string | null> {
		if (!this.noteId) return null;
		const content = await this.plugin.snapshots.readSnapshot(this.noteId, row.snapshotId);
		if (content === null) {
			new Notice(`V${row.n} content is missing from the store.`);
			void this.refresh();
		}
		return content;
	}

	private formatWorkingLabel(): string {
		const working = this.working;
		switch (working.kind) {
			case 'clean':
				return `Matches V${working.n}`;
			case 'unsaved':
				return 'Unsaved changes';
			case 'untracked':
				return 'Not tracked yet';
		}
	}
}
