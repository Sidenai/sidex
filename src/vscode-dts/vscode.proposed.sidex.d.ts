/*---------------------------------------------------------------------------------------------
 *  Proposed API type stubs for sidex fork.
 *  These types are used by VS Code's extension host but are defined as proposed APIs
 *  that are not yet part of the stable vscode.d.ts.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// #region Browser

	export interface BrowserTab {
		readonly url: string;
		readonly title?: string;
	}

	export interface BrowserTabShowOptions {
		readonly viewColumn?: ViewColumn;
		readonly preserveFocus?: boolean;
	}

	export interface BrowserCDPSession {
		send(method: string, params?: object): Thenable<any>;
		onDidReceiveMessage: Event<any>;
		dispose(): void;
	}

	// #endregion

	// #region Comments

	export enum CommentThreadApplicability {
		Current = 0,
		Outdated = 1
	}

	export interface CommentThreadRevealOptions {
		preserveFocus?: boolean;
		focusReply?: boolean;
	}

	export interface CommentReaction {
		readonly reactors?: readonly string[];
	}

	// #endregion

	// #region Remote / Tunnels

	export interface RemoteAuthorityResolver {
		resolve(authority: string, context: RemoteAuthorityResolverContext): Thenable<ResolverResult>;
		tunnelFactory?: TunnelProvider['forwardPort'];
		showCandidatePort?(host: string, port: number, detail: string): Thenable<boolean>;
	}

	export type ResolverResult = ResolvedAuthority & ResolvedOptions & TunnelInformation;

	export interface ManagedResolvedAuthority {
		readonly makeConnection: () => Thenable<ManagedMessagePassing>;
		readonly connectionToken?: string;
	}

	export interface ManagedMessagePassing {
		onDidReceiveMessage: Event<any>;
		send(data: any): void;
		end(): void;
	}

	export interface MessagePassingProtocol {
		onDidReceiveMessage: Event<any>;
		send(data: any): void;
		drain?(): Thenable<void>;
	}

	export interface TunnelDescription {
		remoteAddress: { port: number; host: string };
		localAddress?: { port: number; host: string } | string;
		privacy?: string;
		protocol?: string;
	}

	export interface Tunnel extends TunnelDescription {
		localAddress: { port: number; host: string } | string;
		dispose(): void;
		onDidDispose: Event<void>;
	}

	export interface TunnelInformation {
		environmentTunnels?: TunnelDescription[];
		features?: { elevation: boolean; privacyOptions: { id: string; label: string; themeIcon: string }[] };
	}

	export interface TunnelProvider {
		forwardPort(tunnelOptions: TunnelOptions, tunnelCreationOptions: TunnelCreationOptions): Thenable<Tunnel | undefined>;
	}

	export interface TunnelOptions {
		remoteAddress: { port: number; host: string };
		localAddressPort?: number;
		label?: string;
		privacy?: string;
		protocol?: string;
	}

	export interface TunnelCreationOptions {
		elevationRequired?: boolean;
	}

	export interface ExecServer {
		readonly pid: number | undefined;
		readonly onData: Event<string>;
		write(data: string): void;
		resize(columns: number, rows: number): void;
		kill(): void;
	}

	// #endregion

	// #region Debug

	export class DebugVisualization {
		iconPath?: Uri | { light: Uri; dark: Uri } | ThemeIcon;
		visualization?: Command | TreeDataProvider<unknown>;
		constructor(name: string);
	}

	export interface DebugVisualizationContext {
		variable: any;
		containerId?: string;
		frameId?: number;
		threadId?: number;
	}

	export interface DebugVisualizationProvider<T extends DebugVisualization = DebugVisualization> {
		provideDebugVisualization(context: DebugVisualizationContext, token: CancellationToken): ProviderResult<T[]>;
		resolveDebugVisualization?(visualization: T, token: CancellationToken): ProviderResult<T>;
	}

	export interface DebugVisualizationTree<T = any> {
		getTreeItem(element: T): TreeItem | Thenable<TreeItem>;
		getChildren(element?: T): ProviderResult<T[]>;
	}

	export interface DebugTreeItem extends TreeItem {
		canEdit?: boolean;
	}

	// #endregion

	// #region Text Search

	export interface TextSearchPreviewOptions {
		matchLines: number;
		charsPerLine: number;
	}

	export interface TextSearchQuery {
		pattern: string;
		isRegExp?: boolean;
		isCaseSensitive?: boolean;
		isWordMatch?: boolean;
	}

	export interface TextSearchQuery2 extends TextSearchQuery {
		surroundingContext?: number;
	}

	export interface TextSearchResult {
		uri: Uri;
		ranges: Range | Range[];
		preview: TextSearchMatch;
	}

	export interface TextSearchResult2 extends TextSearchResult {
		aiConfidence?: number;
	}

	export interface TextSearchMatch {
		uri: Uri;
		ranges: Range | Range[];
		preview: { text: string; matches: Range | Range[] };
	}

	export interface TextSearchContext {
		uri: Uri;
		text: string;
		lineNumber: number;
	}

	export interface TextSearchComplete {
		limitHit?: boolean;
		message?: TextSearchCompleteMessage;
	}

	export interface TextSearchCompleteMessage {
		text: string;
		type: TextSearchCompleteMessageType;
		trusted?: boolean;
	}

	export interface TextSearchProvider {
		provideTextSearchResults(query: TextSearchQuery, options: TextSearchOptions, progress: Progress<TextSearchResult>, token: CancellationToken): ProviderResult<TextSearchComplete>;
	}

	export interface TextSearchProvider2 {
		provideTextSearchResults(query: TextSearchQuery2, options: TextSearchProviderOptions, progress: Progress<TextSearchResult2>, token: CancellationToken): ProviderResult<TextSearchComplete>;
	}

	export interface AITextSearchProvider {
		provideAITextSearchResults(query: string, options: TextSearchProviderOptions, progress: Progress<TextSearchResult2>, token: CancellationToken): ProviderResult<TextSearchComplete>;
	}

	export interface FileSearchProvider {
		provideFileSearchResults(query: FileSearchQuery, options: FileSearchOptions, token: CancellationToken): ProviderResult<Uri[]>;
	}

	export interface FileSearchProvider2 {
		provideFileSearchResults(pattern: string, options: FileSearchProviderOptions, token: CancellationToken): ProviderResult<Uri[]>;
	}

	export interface FindTextInFilesResponse {
		results: TextSearchResult[];
		limitHit: boolean;
	}

	export interface LineChange {
		readonly originalStartLineNumber: number;
		readonly originalEndLineNumber: number;
		readonly modifiedStartLineNumber: number;
		readonly modifiedEndLineNumber: number;
	}

	// #endregion

	// #region Inline Completions extensions

	export enum InlineCompletionDisplayLocationKind {
		Code = 1,
		Label = 2
	}

	export enum InlineCompletionEndOfLifeReason {
		Accepted = 0,
		Rejected = 1,
		Ignored = 2
	}

	export enum InlineCompletionsDisposeReasonKind {
		Other = 0,
		Empty = 1,
		TokenCancellation = 2,
		LostRace = 3,
		NotTaken = 4
	}

	export interface InlineCompletionsDisposeReason {
		kind: InlineCompletionsDisposeReasonKind;
	}

	export interface InlineCompletionItem {
		displayLocation?: InlineCompletionDisplayLocationKind;
		warning?: string;
	}

	export interface InlineCompletionItemProvider {
		handleDidShowCompletionItem?(completionItem: InlineCompletionItem): void;
		handleDidPartiallyAcceptCompletionItem?(completionItem: InlineCompletionItem, acceptedCharacterCount: number): void;
		handleDidRejectCompletionItem?(completionItem: InlineCompletionItem): void;
		handleEndOfLifetime?(completionItem: InlineCompletionItem, reason: InlineCompletionEndOfLifeReason): void;
		handleListEndOfLifetime?(completionList: InlineCompletionList, reason: InlineCompletionsDisposeReason): void;
		readonly modelInfo?: any;
	}

	// #endregion

	// #region Telemetry

	export enum TelemetryConfiguration {
		Off = 0,
		Crash = 1,
		Error = 2,
		Usage = 3
	}

	// #endregion

	// #region Authentication

	export interface AuthenticationConstraint {
		readonly id: string;
		readonly scopes?: readonly string[];
		readonly handleErrors?: boolean;
	}

	export interface AuthenticationGetSessionPresentationOptions {
		learnMore?: Uri;
	}

	export interface AuthenticationGetSessionOptions {
		authorizationServer?: Uri;
	}

	// #endregion

	// #region Data Channels

	export interface DataChannel<T = any> {
		readonly label: string;
		onDidReceiveMessage: Event<T>;
		send(data: T): void;
		dispose(): void;
	}

	export interface DataChannelEvent<T = any> {
		readonly channel: DataChannel<T>;
	}

	// #endregion

	// #region Tasks

	export interface TaskProblemMatcherStartedEvent {
		readonly problemMatcher: any;
	}

	export interface TaskProblemMatcherEndedEvent {
		readonly problemMatcher: any;
	}

	// #endregion

	// #region Symbols

	export enum NewSymbolNameTag {
		AIGenerated = 1
	}

	export enum NewSymbolNameTriggerKind {
		Invoke = 0,
		Automatic = 1
	}

	export interface NewSymbolName {
		readonly newSymbolName: string;
		readonly tags?: readonly NewSymbolNameTag[];
	}

	export interface NewSymbolNamesProvider {
		provideNewSymbolNames(symbol: any, option: any, token: CancellationToken): ProviderResult<NewSymbolName[]>;
	}

	// #endregion

	// #region Terminal

	export interface TerminalDimensionsChangeEvent {
		readonly terminal: Terminal;
		readonly dimensions: TerminalDimensions;
	}

	export interface TerminalExecutedCommand {
		readonly commandLine: string | undefined;
		readonly cwd: Uri | undefined;
		readonly exitCode: number | undefined;
		readonly output: string | undefined;
	}

	// #endregion

	// #region Notebooks

	export interface NotebookKernelSourceAction {
		readonly label: string;
		readonly description?: string;
		readonly detail?: string;
		readonly command?: string | Command;
	}

	export class NotebookRendererScript {
		readonly provides: readonly string[];
		readonly uri: Uri;
		constructor(uri: Uri, provides?: string | readonly string[]);
	}

	// #endregion

	// #region Testing

	export interface TestFollowupProvider {
		provideFollowup(result: TestRunResult, context: TestResultSnapshot, token: CancellationToken): ProviderResult<Command[]>;
	}

	export interface TestRelatedCodeProvider {
		provideRelatedCode(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Location[]>;
		provideRelatedTests?(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Location[]>;
	}

	export interface TestObserver {
		readonly tests: ReadonlyArray<any>;
		readonly onDidChangeTest: Event<any>;
		dispose(): void;
	}

	export interface TestResultSnapshot {
		readonly id: string;
		readonly taskStates: ReadonlyArray<any>;
		readonly completedAt: number | undefined;
	}

	// #endregion

	// #region Token Information

	export interface TokenInformation {
		readonly type: number;
		readonly range: Range;
	}

	// #endregion

	// #region TreeView

	export interface TreeViewActiveItemChangeEvent<T> {
		readonly activeItem: T | undefined;
	}

	// #endregion

	// #region WebviewEditorInset

	export interface WebviewEditorInset {
		readonly editor: TextEditor;
		readonly line: number;
		readonly height: number;
		readonly webview: Webview;
		readonly onDidDispose: Event<void>;
		dispose(): void;
	}

	// #endregion

	// #region Ports

	export interface PortAttributesProvider {
		providePortAttributes(attributes: { port: number; pid?: number; commandLine?: string }, token: CancellationToken): ProviderResult<PortAttributes>;
	}

	export interface PortAttributesSelector {
		portRange?: [number, number];
		commandPattern?: RegExp;
	}

	// #endregion

	// #region Resource Label Formatter

	export interface ResourceLabelFormatter {
		scheme: string;
		authority?: string;
		formatting: ResourceLabelFormatting;
	}

	// #endregion

	// #region Custom Text Editor extensions

	export interface CustomTextEditorProvider {
		moveCustomTextEditor?(newDocument: TextDocument, existingWebviewPanel: WebviewPanel, token: CancellationToken): Thenable<void>;
	}

	// #endregion

	// #region TextDocumentChangeEvent extensions

	export interface TextDocumentChangeEvent {
		readonly detailedReason?: string;
	}

	// #endregion

	// #region env.power

	export namespace env {
		export namespace power {
			export type PowerSaveBlockerType = 'prevent-app-suspension' | 'prevent-display-sleep';
			export interface PowerSaveBlocker {
				readonly id: number;
				dispose(): void;
			}
		}
	}

	// #endregion

	// #region CommentThread2

	export interface CommentThread2 extends CommentThread {
		readonly isTemplate?: boolean;
		readonly applicability?: CommentThreadApplicability;
		state?: CommentThreadState | { resolved?: CommentThreadState; applicability?: CommentThreadApplicability };
		reveal?(options?: CommentThreadRevealOptions): Thenable<void>;
	}

	// #endregion

	// #region FindTextInFiles

	export interface FindTextInFilesOptions {
		include?: GlobPattern;
		exclude?: GlobPattern;
		maxResults?: number;
		useDefaultExcludes?: boolean;
		useDefaultSearchExcludes?: boolean;
		useIgnoreFiles?: boolean;
		useGlobalIgnoreFiles?: boolean;
		useParentIgnoreFiles?: boolean;
		followSymlinks?: boolean;
		encoding?: string;
		previewOptions?: TextSearchPreviewOptions;
		beforeContext?: number;
		afterContext?: number;
	}

	export interface FindTextInFilesOptions2 extends FindTextInFilesOptions {
		surroundingContext?: number;
		useExcludeSettings?: any;
	}

	// #endregion

	// #region InlineCompletionItemProviderMetadata

	export interface InlineCompletionItemProviderMetadata {
		readonly yieldTo?: ReadonlyArray<{ readonly mimeType: string }>;
	}

	// #endregion

	// #region TestRunResult / TestsChangeEvent

	export interface TestRunResult {
		readonly completedAt: number | undefined;
		readonly results: ReadonlyArray<any>;
	}

	export interface TestsChangeEvent {
		readonly added: ReadonlyArray<any>;
		readonly updated: ReadonlyArray<any>;
		readonly removed: ReadonlyArray<any>;
	}

	// #endregion

	// #region DataChannelEvent (generics)

	// DataChannelEvent is already declared in the Data Channels region above

	// #endregion

	// #region TunnelOptions (already partially exists)

	export interface TunnelOptions {
		remoteAddress: { port: number; host: string };
		localAddressPort?: number;
		label?: string;
		privacy?: string;
		protocol?: string;
	}

	// #endregion
}
