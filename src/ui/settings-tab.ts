import { type App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type NoteSnapshotsPlugin from '@/main';
import { DEFAULT_SETTINGS, type RestoreConfirmPolicy, type SnapshotNameSuggestion } from '@/settings';
import { suggestedSnapshotName } from '@/ui/format';

export class NoteSnapshotsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: NoteSnapshotsPlugin,
	) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Snapshot store folder')
			.setDesc('Vault-relative folder holding the snapshot store. Changing this does not move existing history.')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.storeFolder)
					.setValue(this.plugin.settings.storeFolder)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ storeFolder: value });
					}),
			);

		new Setting(containerEl).setName('Deleted notes').setHeading();

		new Setting(containerEl)
			.setName('Keep history of deleted notes')
			.setDesc(
				'How old a deleted note’s history must be before “Clean up” will remove it, in days — so an accidental delete stays recoverable in the meantime. Set to 0 to keep every deleted note’s history indefinitely.',
			)
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.purgeOrphansAfterDays))
					.setValue(String(this.plugin.settings.purgeOrphansAfterDays))
					.onChange(async (value) => {
						await this.plugin.updateSettings({ purgeOrphansAfterDays: Number.parseInt(value, 10) });
					}),
			);

		new Setting(containerEl)
			.setName('Clean up now')
			.setDesc('Permanently removes the history of notes deleted longer ago than the window above.')
			.addButton((button) =>
				button.setButtonText('Clean up').onClick(async () => {
					const removed = await this.plugin.purgeOrphans();
					new Notice(
						removed === 0
							? 'Nothing to clean up.'
							: `Removed history for ${removed} deleted note${removed === 1 ? '' : 's'}.`,
					);
				}),
			);

		new Setting(containerEl).setName('Snapshots').setHeading();

		new Setting(containerEl)
			.setName('Suggested name for new snapshots')
			.setDesc('Prefills the name box when you save a named snapshot. Quick unnamed snapshots are unaffected.')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						none: 'No suggestion',
						date: 'Date',
						datetime: 'Date and time',
						custom: 'Custom template',
					} satisfies Record<SnapshotNameSuggestion, string>)
					.setValue(this.plugin.settings.snapshotNameSuggestion)
					.onChange(async (value) => {
						await this.plugin.updateSettings({
							snapshotNameSuggestion: value as SnapshotNameSuggestion,
						});
						// The template field below only exists for the custom preset.
						this.display();
					}),
			);

		if (this.plugin.settings.snapshotNameSuggestion === 'custom') this.renderTemplateSetting(containerEl);

		new Setting(containerEl).setName('Confirmations').setHeading();

		new Setting(containerEl)
			.setName('Confirm before restoring')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						always: 'Always',
						'when-unsaved': 'Only when a restore will overwrite unsaved work',
						never: 'Never',
					} satisfies Record<RestoreConfirmPolicy, string>)
					.setValue(this.plugin.settings.confirmRestore)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ confirmRestore: value as RestoreConfirmPolicy });
					}),
			);

		new Setting(containerEl)
			.setName('Confirm before deleting a snapshot')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.confirmDelete).onChange(async (value) => {
					await this.plugin.updateSettings({ confirmDelete: value });
				}),
			);
	}

	/** The custom template field, with a live example of what it produces. */
	private renderTemplateSetting(containerEl: HTMLElement): void {
		const setting = new Setting(containerEl)
			.setName('Name template')
			.setDesc('Available tokens: {{date}}, {{time}}, {{datetime}}, {{timestamp}}, {{iso}}, {{note}}.');

		const preview = setting.descEl.createDiv({ cls: 'ns-setting-preview' });
		const showPreview = (template: string): void => {
			const example = suggestedSnapshotName(
				{ ...this.plugin.settings, snapshotNameSuggestion: 'custom', snapshotNameTemplate: template },
				{ note: this.app.workspace.getActiveFile()?.basename ?? 'My note' },
			);
			preview.setText(example ? `Example: ${example}` : 'This template suggests nothing.');
		};
		showPreview(this.plugin.settings.snapshotNameTemplate);

		setting.addText((text) =>
			text
				.setPlaceholder(DEFAULT_SETTINGS.snapshotNameTemplate)
				.setValue(this.plugin.settings.snapshotNameTemplate)
				.onChange(async (value) => {
					showPreview(value);
					await this.plugin.updateSettings({ snapshotNameTemplate: value });
				}),
		);
	}
}
