/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import 'mocha';
import * as vscode from 'vscode';
import { DiagnosticComputer, DiagnosticConfiguration, DiagnosticLevel, DiagnosticManager, DiagnosticOptions } from '../languageFeatures/diagnostics';
import { MdLinkProvider } from '../languageFeatures/documentLinkProvider';
import { noopToken } from '../util/cancellation';
import { InMemoryDocument } from '../util/inMemoryDocument';
import { MdWorkspaceContents } from '../workspaceContents';
import { createNewMarkdownEngine } from './engine';
import { InMemoryWorkspaceMarkdownDocuments } from './inMemoryWorkspace';
import { assertRangeEqual, joinLines, workspacePath } from './util';


async function getComputedDiagnostics(doc: InMemoryDocument, workspaceContents: MdWorkspaceContents): Promise<vscode.Diagnostic[]> {
	const engine = createNewMarkdownEngine();
	const linkProvider = new MdLinkProvider(engine);
	const computer = new DiagnosticComputer(engine, workspaceContents, linkProvider);
	return (
		await computer.getDiagnostics(doc, {
			enabled: true,
			validateFilePaths: DiagnosticLevel.warning,
			validateOwnHeaders: DiagnosticLevel.warning,
			validateReferences: DiagnosticLevel.warning,
			skipPaths: [],
		}, noopToken)
	).diagnostics;
}

function createDiagnosticsManager(workspaceContents: MdWorkspaceContents, configuration = new MemoryDiagnosticConfiguration()) {
	const engine = createNewMarkdownEngine();
	const linkProvider = new MdLinkProvider(engine);
	return new DiagnosticManager(new DiagnosticComputer(engine, workspaceContents, linkProvider), configuration);
}

class MemoryDiagnosticConfiguration implements DiagnosticConfiguration {

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	public readonly onDidChange = this._onDidChange.event;

	constructor(
		private readonly enabled: boolean = true,
		private readonly skipPaths: string[] = [],
	) { }

	getOptions(_resource: vscode.Uri): DiagnosticOptions {
		if (!this.enabled) {
			return {
				enabled: false,
				validateFilePaths: DiagnosticLevel.ignore,
				validateOwnHeaders: DiagnosticLevel.ignore,
				validateReferences: DiagnosticLevel.ignore,
				skipPaths: this.skipPaths,
			};
		}
		return {
			enabled: true,
			validateFilePaths: DiagnosticLevel.warning,
			validateOwnHeaders: DiagnosticLevel.warning,
			validateReferences: DiagnosticLevel.warning,
			skipPaths: this.skipPaths,
		};
	}
}


suite('markdown: Diagnostics', () => {
	test('Should not return any diagnostics for empty document', async () => {
		const doc = new InMemoryDocument(workspacePath('doc.md'), joinLines(
			`text`,
		));

		const diagnostics = await getComputedDiagnostics(doc, new InMemoryWorkspaceMarkdownDocuments([doc]));
		assert.deepStrictEqual(diagnostics, []);
	});

	test('Should generate diagnostic for link to file that does not exist', async () => {
		const doc = new InMemoryDocument(workspacePath('doc.md'), joinLines(
			`[bad](/no/such/file.md)`,
			`[good](/doc.md)`,
			`[good-ref]: /doc.md`,
			`[bad-ref]: /no/such/file.md`,
		));

		const diagnostics = await getComputedDiagnostics(doc, new InMemoryWorkspaceMarkdownDocuments([doc]));
		assert.deepStrictEqual(diagnostics.length, 2);
		assertRangeEqual(new vscode.Range(0, 6, 0, 22), diagnostics[0].range);
		assertRangeEqual(new vscode.Range(3, 11, 3, 27), diagnostics[1].range);
	});

	test('Should generate diagnostics for links to header that does not exist in current file', async () => {
		const doc = new InMemoryDocument(workspacePath('doc.md'), joinLines(
			`[good](#good-header)`,
			`# Good Header`,
			`[bad](#no-such-header)`,
			`[good](#good-header)`,
			`[good-ref]: #good-header`,
			`[bad-ref]: #no-such-header`,
		));

		const diagnostics = await getComputedDiagnostics(doc, new InMemoryWorkspaceMarkdownDocuments([doc]));
		assert.deepStrictEqual(diagnostics.length, 2);
		assertRangeEqual(new vscode.Range(2, 6, 2, 21), diagnostics[0].range);
		assertRangeEqual(new vscode.Range(5, 11, 5, 26), diagnostics[1].range);
	});

	test('Should generate diagnostics for links to non-existent headers in other files', async () => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`# My header`,
			`[good](#my-header)`,
			`[good](/doc1.md#my-header)`,
			`[good](doc1.md#my-header)`,
			`[good](/doc2.md#other-header)`,
			`[bad](/doc2.md#no-such-other-header)`,
		));

		const doc2 = new InMemoryDocument(workspacePath('doc2.md'), joinLines(
			`# Other header`,
		));

		const diagnostics = await getComputedDiagnostics(doc1, new InMemoryWorkspaceMarkdownDocuments([doc1, doc2]));
		assert.deepStrictEqual(diagnostics.length, 1);
		assertRangeEqual(new vscode.Range(5, 6, 5, 35), diagnostics[0].range);
	});

	test('Should support links both with and without .md file extension', async () => {
		const doc = new InMemoryDocument(workspacePath('doc.md'), joinLines(
			`# My header`,
			`[good](#my-header)`,
			`[good](/doc.md#my-header)`,
			`[good](doc.md#my-header)`,
			`[good](/doc#my-header)`,
			`[good](doc#my-header)`,
		));

		const diagnostics = await getComputedDiagnostics(doc, new InMemoryWorkspaceMarkdownDocuments([doc]));
		assert.deepStrictEqual(diagnostics.length, 0);
	});

	test('Should generate diagnostics for non-existent link reference', async () => {
		const doc = new InMemoryDocument(workspacePath('doc.md'), joinLines(
			`[good link][good]`,
			`[bad link][no-such]`,
			``,
			`[good]: http://example.com`,
		));

		const diagnostics = await getComputedDiagnostics(doc, new InMemoryWorkspaceMarkdownDocuments([doc]));
		assert.deepStrictEqual(diagnostics.length, 1);
		assertRangeEqual(new vscode.Range(1, 11, 1, 18), diagnostics[0].range);
	});

	test('Should not generate diagnostics when validate is disabled', async () => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`[text](#no-such-header)`,
			`[text][no-such-ref]`,
		));

		const manager = createDiagnosticsManager(new InMemoryWorkspaceMarkdownDocuments([doc1]), new MemoryDiagnosticConfiguration(false));
		const { diagnostics } = await manager.recomputeDiagnosticState(doc1, noopToken);
		assert.deepStrictEqual(diagnostics.length, 0);
	});

	test('Should not generate diagnostics for email autolink', async () => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`a <user@example.com> c`,
		));

		const diagnostics = await getComputedDiagnostics(doc1, new InMemoryWorkspaceMarkdownDocuments([doc1]));
		assert.deepStrictEqual(diagnostics.length, 0);
	});

	test('Should not generate diagnostics for html tag that looks like an autolink', async () => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`a <tag>b</tag> c`,
			`a <scope:tag>b</scope:tag> c`,
		));

		const diagnostics = await getComputedDiagnostics(doc1, new InMemoryWorkspaceMarkdownDocuments([doc1]));
		assert.deepStrictEqual(diagnostics.length, 0);
	});

	test('Should allow ignoring invalid file link using glob', async () => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`[text](/no-such-file)`,
			`![img](/no-such-file)`,
			`[text]: /no-such-file`,
		));

		const manager = createDiagnosticsManager(new InMemoryWorkspaceMarkdownDocuments([doc1]), new MemoryDiagnosticConfiguration(true, ['/no-such-file']));
		const { diagnostics } = await manager.recomputeDiagnosticState(doc1, noopToken);
		assert.deepStrictEqual(diagnostics.length, 0);
	});

	test('skipPaths should allow skipping non-existent file', async () => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`[text](/no-such-file#header)`,
		));

		const manager = createDiagnosticsManager(new InMemoryWorkspaceMarkdownDocuments([doc1]), new MemoryDiagnosticConfiguration(true, ['/no-such-file']));
		const { diagnostics } = await manager.recomputeDiagnosticState(doc1, noopToken);
		assert.deepStrictEqual(diagnostics.length, 0);
	});

	test('skipPaths should not consider link fragment', async () => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`[text](/no-such-file#header)`,
		));

		const manager = createDiagnosticsManager(new InMemoryWorkspaceMarkdownDocuments([doc1]), new MemoryDiagnosticConfiguration(true, ['/no-such-file']));
		const { diagnostics } = await manager.recomputeDiagnosticState(doc1, noopToken);
		assert.deepStrictEqual(diagnostics.length, 0);
	});

	test('skipPaths should support globs', async () => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`![i](/images/aaa.png)`,
			`![i](/images/sub/bbb.png)`,
			`![i](/images/sub/sub2/ccc.png)`,
		));

		const manager = createDiagnosticsManager(new InMemoryWorkspaceMarkdownDocuments([doc1]), new MemoryDiagnosticConfiguration(true, ['/images/**/*.png']));
		const { diagnostics } = await manager.recomputeDiagnosticState(doc1, noopToken);
		assert.deepStrictEqual(diagnostics.length, 0);
	});
});
