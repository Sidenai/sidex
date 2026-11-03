//! Built-in default settings — comprehensive VS Code parity.
//!
//! Covers editor, workbench, files, terminal, search, window, debug,
//! explorer, and extension defaults.

use serde_json::{json, Map, Value};

/// Return the complete map of built-in default settings.
pub fn builtin_defaults() -> Value {
    let mut m = Map::new();
    add_editor_defaults(&mut m);
    add_workbench_defaults(&mut m);
    add_file_defaults(&mut m);
    add_terminal_defaults(&mut m);
    add_search_defaults(&mut m);
    add_window_defaults(&mut m);
    add_debug_defaults(&mut m);
    add_explorer_defaults(&mut m);
    add_extension_defaults(&mut m);
    add_git_defaults(&mut m);
    add_scm_defaults(&mut m);
    add_breadcrumb_defaults(&mut m);
    add_output_defaults(&mut m);
    add_notebook_defaults(&mut m);
    add_language_specific_defaults(&mut m);
    Value::Object(m)
}

fn ins(m: &mut Map<String, Value>, key: &str, value: Value) {
    m.insert(key.to_owned(), value);
}

#[allow(clippy::too_many_lines)]
fn add_editor_defaults(m: &mut Map<String, Value>) {
    ins(m, "editor.fontSize", json!(14));
    ins(
        m,
        "editor.fontFamily",
        json!("Consolas, 'Courier New', monospace"),
    );
    ins(m, "editor.fontWeight", json!("normal"));
    ins(m, "editor.fontLigatures", json!(false));
    ins(m, "editor.lineHeight", json!(0));
    ins(m, "editor.letterSpacing", json!(0));
    ins(m, "editor.tabSize", json!(4));
    ins(m, "editor.insertSpaces", json!(true));
    ins(m, "editor.detectIndentation", json!(true));
    ins(m, "editor.trimAutoWhitespace", json!(true));
    ins(m, "editor.largeFileOptimizations", json!(true));
    ins(m, "editor.wordBasedSuggestions", json!("matchingDocuments"));
    ins(
        m,
        "editor.semanticHighlighting.enabled",
        json!("configuredByTheme"),
    );
    ins(m, "editor.stablePeek", json!(false));
    ins(m, "editor.maxTokenizationLineLength", json!(20000));
    ins(m, "editor.wordWrap", json!("off"));
    ins(m, "editor.wordWrapColumn", json!(80));
    ins(m, "editor.wrappingIndent", json!("same"));
    ins(m, "editor.wrappingStrategy", json!("simple"));
    ins(m, "editor.lineNumbers", json!("on"));
    ins(m, "editor.renderWhitespace", json!("selection"));
    ins(m, "editor.renderControlCharacters", json!(true));
    ins(m, "editor.renderLineHighlight", json!("line"));
    ins(m, "editor.renderLineHighlightOnlyWhenFocus", json!(false));
    ins(m, "editor.cursorStyle", json!("line"));
    ins(m, "editor.cursorBlinking", json!("blink"));
    ins(m, "editor.cursorWidth", json!(0));
    ins(m, "editor.cursorSmoothCaretAnimation", json!("off"));
    ins(m, "editor.smoothScrolling", json!(false));
    ins(m, "editor.mouseWheelScrollSensitivity", json!(1));
    ins(m, "editor.fastScrollSensitivity", json!(5));
    ins(m, "editor.mouseWheelZoom", json!(false));
    ins(m, "editor.minimap.enabled", json!(true));
    ins(m, "editor.minimap.side", json!("right"));
    ins(m, "editor.minimap.maxColumn", json!(120));
    ins(m, "editor.minimap.renderCharacters", json!(true));
    ins(m, "editor.minimap.showSlider", json!("mouseover"));
    ins(m, "editor.minimap.scale", json!(1));
    ins(m, "editor.minimap.autohide", json!(false));
    ins(m, "editor.scrollBeyondLastLine", json!(true));
    ins(m, "editor.scrollBeyondLastColumn", json!(5));
    ins(m, "editor.roundedSelection", json!(true));
    ins(m, "editor.overviewRulerBorder", json!(true));
    ins(m, "editor.overviewRulerLanes", json!(3));
    ins(m, "editor.formatOnSave", json!(false));
    ins(m, "editor.formatOnPaste", json!(false));
    ins(m, "editor.formatOnType", json!(false));
    ins(m, "editor.autoClosingBrackets", json!("languageDefined"));
    ins(m, "editor.autoClosingComments", json!("languageDefined"));
    ins(m, "editor.autoClosingQuotes", json!("languageDefined"));
    ins(m, "editor.autoClosingDelete", json!("auto"));
    ins(m, "editor.autoClosingOvertype", json!("auto"));
    ins(m, "editor.autoIndent", json!("full"));
    ins(m, "editor.autoSurround", json!("languageDefined"));
    ins(m, "editor.dragAndDrop", json!(true));
    ins(m, "editor.emptySelectionClipboard", json!(true));
    ins(m, "editor.copyWithSyntaxHighlighting", json!(true));
    ins(m, "editor.multiCursorModifier", json!("alt"));
    ins(m, "editor.multiCursorMergeOverlapping", json!(true));
    ins(m, "editor.multiCursorPaste", json!("spread"));
    ins(m, "editor.accessibilitySupport", json!("auto"));
    ins(m, "editor.suggest.showIcons", json!(true));
    ins(m, "editor.suggest.insertMode", json!("insert"));
    ins(m, "editor.suggest.filterGraceful", json!(true));
    ins(m, "editor.suggest.localityBonus", json!(false));
    ins(m, "editor.suggest.shareSuggestSelections", json!(false));
    ins(m, "editor.suggest.showMethods", json!(true));
    ins(m, "editor.suggest.showFunctions", json!(true));
    ins(m, "editor.suggest.showConstructors", json!(true));
    ins(m, "editor.suggest.showFields", json!(true));
    ins(m, "editor.suggest.showVariables", json!(true));
    ins(m, "editor.suggest.showClasses", json!(true));
    ins(m, "editor.suggest.showStructs", json!(true));
    ins(m, "editor.suggest.showInterfaces", json!(true));
    ins(m, "editor.suggest.showModules", json!(true));
    ins(m, "editor.suggest.showProperties", json!(true));
    ins(m, "editor.suggest.showEvents", json!(true));
    ins(m, "editor.suggest.showOperators", json!(true));
    ins(m, "editor.suggest.showUnits", json!(true));
    ins(m, "editor.suggest.showValues", json!(true));
    ins(m, "editor.suggest.showConstants", json!(true));
    ins(m, "editor.suggest.showEnumMembers", json!(true));
    ins(m, "editor.suggest.showEnums", json!(true));
    ins(m, "editor.suggest.showKeywords", json!(true));
    ins(m, "editor.suggest.showWords", json!(true));
    ins(m, "editor.suggest.showColors", json!(true));
    ins(m, "editor.suggest.showFiles", json!(true));
    ins(m, "editor.suggest.showReferences", json!(true));
    ins(m, "editor.suggest.showSnippets", json!(true));
    ins(m, "editor.suggest.showUsers", json!(true));
    ins(m, "editor.suggest.showIssues", json!(true));
    ins(
        m,
        "editor.quickSuggestions",
        json!({"other": true, "comments": false, "strings": false}),
    );
    ins(m, "editor.quickSuggestionsDelay", json!(10));
    ins(m, "editor.suggestOnTriggerCharacters", json!(true));
    ins(m, "editor.acceptSuggestionOnEnter", json!("on"));
    ins(m, "editor.acceptSuggestionOnCommitCharacter", json!(true));
    ins(m, "editor.snippetSuggestions", json!("inline"));
    ins(m, "editor.tabCompletion", json!("off"));
    ins(
        m,
        "editor.wordBasedSuggestionsMode",
        json!("matchingDocuments"),
    );
    ins(m, "editor.suggestSelection", json!("first"));
    ins(m, "editor.suggestFontSize", json!(0));
    ins(m, "editor.suggestLineHeight", json!(0));
    ins(m, "editor.parameterHints.enabled", json!(true));
    ins(m, "editor.parameterHints.cycle", json!(false));
    ins(m, "editor.hover.enabled", json!(true));
    ins(m, "editor.hover.delay", json!(300));
    ins(m, "editor.hover.sticky", json!(true));
    ins(m, "editor.links", json!(true));
    ins(m, "editor.colorDecorators", json!(true));
    ins(
        m,
        "editor.colorDecoratorsActivatedOn",
        json!("clickAndHover"),
    );
    ins(m, "editor.lightbulb.enabled", json!("on"));
    ins(m, "editor.codeActionsOnSave", json!({}));
    ins(m, "editor.selectionHighlight", json!(true));
    ins(m, "editor.occurrencesHighlight", json!("singleFile"));
    ins(m, "editor.codeLens", json!(true));
    ins(m, "editor.codeLensFontFamily", json!(""));
    ins(m, "editor.codeLensFontSize", json!(0));
    ins(m, "editor.showFoldingControls", json!("mouseover"));
    ins(m, "editor.folding", json!(true));
    ins(m, "editor.foldingStrategy", json!("auto"));
    ins(m, "editor.foldingHighlight", json!(true));
    ins(m, "editor.foldingImportsByDefault", json!(false));
    ins(m, "editor.foldingMaximumRegions", json!(5000));
    ins(m, "editor.unfoldOnClickAfterEndOfLine", json!(false));
    ins(m, "editor.matchBrackets", json!("always"));
    ins(m, "editor.glyphMargin", json!(true));
    ins(m, "editor.rulers", json!([]));
    ins(m, "editor.columnSelection", json!(false));
    ins(
        m,
        "editor.find.seedSearchStringFromSelection",
        json!("always"),
    );
    ins(m, "editor.find.autoFindInSelection", json!("never"));
    ins(m, "editor.find.addExtraSpaceOnTop", json!(true));
    ins(m, "editor.find.loop", json!(true));
    ins(m, "editor.defaultFormatter", Value::Null);
    ins(m, "editor.linkedEditing", json!(false));
    ins(m, "editor.rename.enablePreview", json!(true));
    ins(m, "editor.definitionLinkOpensInPeek", json!(false));
    ins(m, "editor.showDeprecated", json!(true));
    ins(m, "editor.inlayHints.enabled", json!("on"));
    ins(m, "editor.inlayHints.fontSize", json!(0));
    ins(m, "editor.inlayHints.fontFamily", json!(""));
    ins(m, "editor.inlayHints.padding", json!(false));
    ins(m, "editor.bracketPairColorization.enabled", json!(true));
    ins(
        m,
        "editor.bracketPairColorization.independentColorPoolPerBracketType",
        json!(false),
    );
    ins(m, "editor.guides.bracketPairs", json!("active"));
    ins(m, "editor.guides.bracketPairsHorizontal", json!("active"));
    ins(m, "editor.guides.highlightActiveBracketPair", json!(true));
    ins(m, "editor.guides.indentation", json!(true));
    ins(m, "editor.guides.highlightActiveIndentation", json!(true));
    ins(m, "editor.stickyScroll.enabled", json!(true));
    ins(m, "editor.stickyScroll.maxLineCount", json!(5));
    ins(m, "editor.stickyScroll.defaultModel", json!("outlineModel"));
    ins(m, "editor.stickyScroll.scrollWithEditor", json!(true));
    ins(
        m,
        "editor.unicodeHighlight.ambiguousCharacters",
        json!(true),
    );
    ins(
        m,
        "editor.unicodeHighlight.invisibleCharacters",
        json!(true),
    );
    ins(
        m,
        "editor.unicodeHighlight.nonBasicASCII",
        json!("inUntrustedWorkspace"),
    );
    ins(
        m,
        "editor.unicodeHighlight.includeComments",
        json!("inUntrustedWorkspace"),
    );
    ins(
        m,
        "editor.screenReaderAnnounceInlineSuggestion",
        json!(true),
    );
    ins(m, "editor.gotoLocation.multiple", Value::Null);
    ins(m, "editor.gotoLocation.multipleDefinitions", json!("peek"));
    ins(
        m,
        "editor.gotoLocation.multipleTypeDefinitions",
        json!("peek"),
    );
    ins(m, "editor.gotoLocation.multipleDeclarations", json!("peek"));
    ins(
        m,
        "editor.gotoLocation.multipleImplementations",
        json!("peek"),
    );
    ins(m, "editor.gotoLocation.multipleReferences", json!("goto"));
    ins(
        m,
        "editor.wordSeparators",
        json!("`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?"),
    );
    ins(m, "editor.padding.top", json!(0));
    ins(m, "editor.padding.bottom", json!(0));
    ins(m, "editor.lineDecorationsWidth", json!(10));
    ins(m, "editor.experimentalWhitespaceRendering", json!("svg"));
}

#[allow(clippy::too_many_lines)]
fn add_workbench_defaults(m: &mut Map<String, Value>) {
    ins(m, "workbench.colorTheme", json!("Default Dark+"));
    ins(m, "workbench.iconTheme", json!("vs-seti"));
    ins(m, "workbench.productIconTheme", json!("Default"));
    ins(m, "workbench.startupEditor", json!("welcomePage"));
    ins(m, "workbench.sideBar.location", json!("left"));
    ins(m, "workbench.activityBar.visible", json!(true));
    ins(m, "workbench.activityBar.location", json!("top"));
    ins(m, "workbench.statusBar.visible", json!(true));
    ins(m, "workbench.editor.showTabs", json!("multiple"));
    ins(m, "workbench.editor.tabSizing", json!("fit"));
    ins(m, "workbench.editor.tabCloseButton", json!("right"));
    ins(m, "workbench.editor.enablePreview", json!(true));
    ins(
        m,
        "workbench.editor.enablePreviewFromQuickOpen",
        json!(false),
    );
    ins(
        m,
        "workbench.editor.enablePreviewFromCodeNavigation",
        json!(false),
    );
    ins(m, "workbench.editor.highlightModifiedTabs", json!(false));
    ins(m, "workbench.editor.wrapTabs", json!(false));
    ins(m, "workbench.editor.decorations.badges", json!(true));
    ins(m, "workbench.editor.decorations.colors", json!(true));
    ins(m, "workbench.editor.closeOnFileDelete", json!(false));
    ins(m, "workbench.editor.openPositioning", json!("right"));
    ins(
        m,
        "workbench.editor.openSideBySideDirection",
        json!("right"),
    );
    ins(m, "workbench.editor.revealIfOpen", json!(false));
    ins(m, "workbench.editor.splitOnDragAndDrop", json!(true));
    ins(m, "workbench.editor.splitSizing", json!("distribute"));
    ins(m, "workbench.editor.limit.enabled", json!(false));
    ins(m, "workbench.editor.limit.value", json!(10));
    ins(m, "workbench.editor.limit.perEditorGroup", json!(false));
    ins(m, "workbench.editor.labelFormat", json!("default"));
    ins(m, "workbench.editor.untitled.labelFormat", json!("content"));
    ins(m, "workbench.editor.pinnedTabSizing", json!("normal"));
    ins(m, "workbench.tree.indent", json!(8));
    ins(m, "workbench.tree.renderIndentGuides", json!("onHover"));
    ins(m, "workbench.tree.expandMode", json!("singleClick"));
    ins(m, "workbench.list.smoothScrolling", json!(false));
    ins(m, "workbench.list.openMode", json!("singleClick"));
    ins(m, "workbench.list.multiSelectModifier", json!("ctrlCmd"));
    ins(m, "workbench.panel.defaultLocation", json!("bottom"));
    ins(m, "workbench.panel.opensMaximized", json!("never"));
    ins(m, "workbench.colorCustomizations", json!({}));
    ins(m, "workbench.layoutControl.enabled", json!(true));
    ins(m, "workbench.layoutControl.type", json!("both"));
}

#[allow(clippy::too_many_lines)]
fn add_file_defaults(m: &mut Map<String, Value>) {
    ins(m, "files.autoSave", json!("off"));
    ins(m, "files.autoSaveDelay", json!(1000));
    ins(m, "files.encoding", json!("utf8"));
    ins(m, "files.eol", json!("auto"));
    ins(m, "files.trimTrailingWhitespace", json!(false));
    ins(m, "files.insertFinalNewline", json!(false));
    ins(m, "files.trimFinalNewlines", json!(false));
    ins(
        m,
        "files.exclude",
        json!({"**/.git": true, "**/.svn": true, "**/.hg": true, "**/CVS": true, "**/.DS_Store": true, "**/Thumbs.db": true}),
    );
    ins(
        m,
        "files.watcherExclude",
        json!({"**/.git/objects/**": true, "**/.git/subtree-cache/**": true, "**/node_modules/**": true, "**/.hg/store/**": true}),
    );
    ins(m, "files.hotExit", json!("onExit"));
    ins(m, "files.defaultLanguage", json!(""));
    ins(m, "files.maxMemoryForLargeFilesMB", json!(4096));
    ins(m, "files.restoreUndoStack", json!(true));
    ins(m, "files.simpleDialog.enable", json!(false));
    ins(m, "files.associations", json!({}));
}

#[allow(clippy::too_many_lines)]
fn add_terminal_defaults(m: &mut Map<String, Value>) {
    ins(m, "terminal.integrated.fontSize", json!(14));
    ins(m, "terminal.integrated.fontFamily", json!(""));
    ins(m, "terminal.integrated.fontWeight", json!("normal"));
    ins(m, "terminal.integrated.fontWeightBold", json!("bold"));
    ins(m, "terminal.integrated.lineHeight", json!(1));
    ins(m, "terminal.integrated.letterSpacing", json!(0));
    ins(m, "terminal.integrated.cursorBlinking", json!(false));
    ins(m, "terminal.integrated.cursorStyle", json!("block"));
    ins(m, "terminal.integrated.cursorWidth", json!(1));
    ins(m, "terminal.integrated.scrollback", json!(1000));
    ins(m, "terminal.integrated.detectLocale", json!("auto"));
    ins(m, "terminal.integrated.gpuAcceleration", json!("auto"));
    ins(
        m,
        "terminal.integrated.rightClickBehavior",
        json!("selectWord"),
    );
    ins(m, "terminal.integrated.copyOnSelection", json!(false));
    ins(
        m,
        "terminal.integrated.drawBoldTextInBrightColors",
        json!(true),
    );
    ins(m, "terminal.integrated.fastScrollSensitivity", json!(5));
    ins(
        m,
        "terminal.integrated.mouseWheelScrollSensitivity",
        json!(1),
    );
    ins(m, "terminal.integrated.macOptionIsMeta", json!(false));
    ins(
        m,
        "terminal.integrated.macOptionClickForcesSelection",
        json!(false),
    );
    ins(m, "terminal.integrated.altClickMovesCursor", json!(true));
    ins(m, "terminal.integrated.enableBell", json!(false));
    ins(m, "terminal.integrated.commandsToSkipShell", json!([]));
    ins(m, "terminal.integrated.allowChords", json!(true));
    ins(m, "terminal.integrated.allowMnemonics", json!(false));
    ins(m, "terminal.integrated.inheritEnv", json!(true));
    ins(m, "terminal.integrated.env.linux", json!({}));
    ins(m, "terminal.integrated.env.osx", json!({}));
    ins(m, "terminal.integrated.env.windows", json!({}));
    ins(m, "terminal.integrated.showExitAlert", json!(true));
    ins(m, "terminal.integrated.splitCwd", json!("inherited"));
    ins(m, "terminal.integrated.tabs.enabled", json!(true));
    ins(
        m,
        "terminal.integrated.tabs.hideCondition",
        json!("singleTerminal"),
    );
    ins(m, "terminal.integrated.tabs.location", json!("right"));
    ins(m, "terminal.integrated.defaultProfile.linux", Value::Null);
    ins(m, "terminal.integrated.defaultProfile.osx", Value::Null);
    ins(m, "terminal.integrated.defaultProfile.windows", Value::Null);
    ins(m, "terminal.integrated.enableImages", json!(false));
    ins(m, "terminal.integrated.smoothScrolling", json!(false));
    ins(
        m,
        "terminal.integrated.persistentSessionReviveProcess",
        json!("onExitAndWindowClose"),
    );
    ins(
        m,
        "terminal.integrated.enableMultiLinePasteWarning",
        json!("auto"),
    );
    ins(m, "terminal.integrated.minimumContrastRatio", json!(4.5));
}

#[allow(clippy::too_many_lines)]
fn add_search_defaults(m: &mut Map<String, Value>) {
    ins(
        m,
        "search.exclude",
        json!({"**/node_modules": true, "**/bower_components": true, "**/*.code-search": true}),
    );
    ins(m, "search.useIgnoreFiles", json!(true));
    ins(m, "search.useGlobalIgnoreFiles", json!(false));
    ins(m, "search.useParentIgnoreFiles", json!(true));
    ins(m, "search.followSymlinks", json!(true));
    ins(m, "search.smartCase", json!(false));
    ins(m, "search.showLineNumbers", json!(false));
    ins(m, "search.seedOnFocus", json!(false));
    ins(m, "search.seedWithNearestWord", json!(false));
    ins(m, "search.mode", json!("view"));
    ins(m, "search.collapseResults", json!("alwaysExpand"));
    ins(m, "search.searchOnType", json!(true));
    ins(m, "search.searchOnTypeDebouncePeriod", json!(300));
    ins(m, "search.sortOrder", json!("default"));
    ins(m, "search.defaultViewMode", json!("list"));
    ins(m, "search.quickOpen.includeSymbols", json!(false));
    ins(m, "search.quickOpen.includeHistory", json!(true));
}

#[allow(clippy::too_many_lines)]
fn add_window_defaults(m: &mut Map<String, Value>) {
    ins(m, "window.zoomLevel", json!(0));
    ins(
        m,
        "window.title",
        json!("${dirty}${activeEditorShort}${separator}${rootName}${separator}${appName}"),
    );
    ins(m, "window.restoreWindows", json!("all"));
    ins(m, "window.newWindowDimensions", json!("default"));
    ins(m, "window.openFilesInNewWindow", json!("off"));
    ins(m, "window.openFoldersInNewWindow", json!("default"));
    ins(m, "window.closeWhenEmpty", json!(false));
    ins(m, "window.titleBarStyle", json!("custom"));
    ins(m, "window.dialogStyle", json!("native"));
    ins(m, "window.menuBarVisibility", json!("classic"));
    ins(m, "window.enableMenuBarMnemonics", json!(true));
    ins(m, "window.autoDetectColorScheme", json!(false));
    ins(m, "window.autoDetectHighContrast", json!(true));
    ins(m, "window.commandCenter", json!(true));
}

#[allow(clippy::too_many_lines)]
fn add_debug_defaults(m: &mut Map<String, Value>) {
    ins(m, "debug.openDebug", json!("openOnDebugBreak"));
    ins(
        m,
        "debug.internalConsoleOptions",
        json!("openOnFirstSessionStart"),
    );
    ins(m, "debug.openExplorerOnEnd", json!(false));
    ins(m, "debug.inlineValues", json!("auto"));
    ins(m, "debug.toolBarLocation", json!("floating"));
    ins(m, "debug.showBreakpointsInOverviewRuler", json!(false));
    ins(m, "debug.showInlineBreakpointCandidates", json!(true));
    ins(m, "debug.showSubSessionsInToolBar", json!(false));
    ins(m, "debug.allowBreakpointsEverywhere", json!(false));
    ins(m, "debug.console.fontSize", json!(14));
    ins(m, "debug.console.fontFamily", json!(""));
    ins(m, "debug.console.lineHeight", json!(0));
    ins(m, "debug.console.wordWrap", json!(true));
    ins(m, "debug.console.closeOnEnd", json!(false));
    ins(m, "debug.saveBeforeStart", json!("allEditorsInActiveGroup"));
    ins(m, "debug.confirmOnExit", json!("never"));
}

#[allow(clippy::too_many_lines)]
fn add_explorer_defaults(m: &mut Map<String, Value>) {
    ins(m, "explorer.openEditors.visible", json!(9));
    ins(m, "explorer.autoReveal", json!(true));
    ins(m, "explorer.enableDragAndDrop", json!(true));
    ins(m, "explorer.confirmDragAndDrop", json!(true));
    ins(m, "explorer.confirmDelete", json!(true));
    ins(m, "explorer.sortOrder", json!("default"));
    ins(
        m,
        "explorer.sortOrderLexicographicOptions",
        json!("default"),
    );
    ins(m, "explorer.decorations.colors", json!(true));
    ins(m, "explorer.decorations.badges", json!(true));
    ins(m, "explorer.incrementalNaming", json!("simple"));
    ins(m, "explorer.compactFolders", json!(true));
    ins(m, "explorer.fileNesting.enabled", json!(false));
    ins(m, "explorer.fileNesting.expand", json!(true));
}

#[allow(clippy::too_many_lines)]
fn add_extension_defaults(m: &mut Map<String, Value>) {
    ins(m, "extensions.autoUpdate", json!(true));
    ins(m, "extensions.autoCheckUpdates", json!(true));
    ins(m, "extensions.ignoreRecommendations", json!(false));
    ins(
        m,
        "extensions.closeExtensionDetailsOnViewChange",
        json!(false),
    );
    ins(m, "extensions.confirmedUriHandlerExtensionIds", json!([]));
    ins(m, "extensions.supportUntrustedWorkspaces", json!({}));
}

#[allow(clippy::too_many_lines)]
fn add_git_defaults(m: &mut Map<String, Value>) {
    ins(m, "git.enabled", json!(true));
    ins(m, "git.path", Value::Null);
    ins(m, "git.autofetch", json!(false));
    ins(m, "git.autofetchPeriod", json!(180));
    ins(m, "git.confirmSync", json!(true));
    ins(m, "git.enableSmartCommit", json!(false));
    ins(m, "git.smartCommitChanges", json!("all"));
    ins(m, "git.postCommitCommand", json!("none"));
    ins(m, "git.openRepositoryInParentFolders", json!("prompt"));
    ins(m, "git.fetchOnPull", json!(false));
    ins(m, "git.pullTags", json!(true));
    ins(m, "git.pruneOnFetch", json!(false));
    ins(m, "git.branchValidationRegex", json!(""));
    ins(m, "git.branchWhitespaceChar", json!("-"));
    ins(m, "git.inputValidation", json!("warn"));
    ins(m, "git.inputValidationSubjectLength", Value::Null);
    ins(m, "git.inputValidationLength", json!(72));
    ins(m, "git.decorations.enabled", json!(true));
    ins(m, "git.defaultCloneDirectory", Value::Null);
    ins(m, "git.enableStatusBarSync", json!(true));
    ins(m, "git.allowForcePush", json!(false));
    ins(m, "git.allowNoVerifyCommit", json!(false));
    ins(m, "git.confirmForcePush", json!(true));
    ins(m, "git.confirmNoVerifyCommit", json!(true));
    ins(m, "git.closeDiffOnOperation", json!(false));
    ins(m, "git.showPushSuccessNotification", json!(false));
    ins(m, "git.countBadge", json!("all"));
    ins(m, "git.checkoutType", json!(["local", "remote", "tags"]));
    ins(m, "git.ignoreLimitWarning", json!(false));
    ins(m, "git.ignoreSubmodules", json!(false));
    ins(m, "git.ignoreMissingGitWarning", json!(false));
    ins(m, "git.terminalAuthentication", json!(true));
    ins(m, "git.terminalGitEditor", json!(false));
    ins(m, "git.useForcePushWithLease", json!(true));
    ins(m, "git.autoStash", json!(false));
    ins(m, "git.timeline.date", json!("committed"));
    ins(m, "git.timeline.showAuthor", json!(true));
    ins(m, "git.timeline.showUncommitted", json!(false));
}

#[allow(clippy::too_many_lines)]
fn add_scm_defaults(m: &mut Map<String, Value>) {
    ins(m, "scm.alwaysShowActions", json!(false));
    ins(m, "scm.alwaysShowRepositories", json!(false));
    ins(m, "scm.countBadge", json!("all"));
    ins(m, "scm.defaultViewMode", json!("tree"));
    ins(m, "scm.diffDecorations", json!("all"));
    ins(m, "scm.diffDecorationsGutterWidth", json!(3));
    ins(m, "scm.diffDecorationsGutterAction", json!("diff"));
    ins(m, "scm.diffDecorationsIgnoreTrimWhitespace", json!("false"));
    ins(m, "scm.providerCountBadge", json!("hidden"));
    ins(m, "scm.repositories.visible", json!(10));
    ins(m, "scm.inputFontFamily", json!("default"));
    ins(m, "scm.inputFontSize", json!(13));
}

#[allow(clippy::too_many_lines)]
fn add_breadcrumb_defaults(m: &mut Map<String, Value>) {
    ins(m, "breadcrumbs.enabled", json!(true));
    ins(m, "breadcrumbs.filePath", json!("on"));
    ins(m, "breadcrumbs.symbolPath", json!("on"));
    ins(m, "breadcrumbs.symbolSortOrder", json!("position"));
    ins(m, "breadcrumbs.showFiles", json!(true));
    ins(m, "breadcrumbs.showSymbols", json!(true));
    ins(m, "breadcrumbs.showPackages", json!(true));
    ins(m, "breadcrumbs.showModules", json!(true));
    ins(m, "breadcrumbs.showNamespaces", json!(true));
    ins(m, "breadcrumbs.showClasses", json!(true));
    ins(m, "breadcrumbs.showMethods", json!(true));
    ins(m, "breadcrumbs.showFunctions", json!(true));
    ins(m, "breadcrumbs.showEnumMembers", json!(true));
    ins(m, "breadcrumbs.showInterfaces", json!(true));
    ins(m, "breadcrumbs.showStructs", json!(true));
    ins(m, "breadcrumbs.showEvents", json!(true));
    ins(m, "breadcrumbs.showOperators", json!(true));
    ins(m, "breadcrumbs.showTypeParameters", json!(true));
}

#[allow(clippy::too_many_lines)]
fn add_output_defaults(m: &mut Map<String, Value>) {
    ins(m, "output.smartScroll.enabled", json!(true));
}

#[allow(clippy::too_many_lines)]
fn add_notebook_defaults(m: &mut Map<String, Value>) {
    ins(m, "notebook.lineNumbers", json!("off"));
    ins(m, "notebook.showCellStatusBar", json!("visible"));
    ins(m, "notebook.cellToolbarLocation", json!("right"));
    ins(m, "notebook.compactView", json!(true));
    ins(m, "notebook.globalToolbar", json!(true));
    ins(m, "notebook.consolidatedOutputButton", json!(true));
    ins(m, "notebook.insertToolbarLocation", json!("both"));
    ins(m, "notebook.undoRedoPerCell", json!(true));
    ins(m, "notebook.output.textLineLimit", json!(30));
}

#[allow(clippy::too_many_lines)]
fn add_language_specific_defaults(m: &mut Map<String, Value>) {
    ins(
        m,
        "[rust]",
        json!({
            "editor.tabSize": 4,
            "editor.formatOnSave": true,
            "editor.defaultFormatter": "rust-analyzer"
        }),
    );
    ins(
        m,
        "[typescript]",
        json!({
            "editor.tabSize": 2,
            "editor.formatOnSave": false,
            "editor.defaultFormatter": "esbenp.prettier-vscode"
        }),
    );
    ins(
        m,
        "[typescriptreact]",
        json!({
            "editor.tabSize": 2,
            "editor.formatOnSave": false,
            "editor.defaultFormatter": "esbenp.prettier-vscode"
        }),
    );
    ins(
        m,
        "[javascript]",
        json!({
            "editor.tabSize": 2,
            "editor.formatOnSave": false,
            "editor.defaultFormatter": "esbenp.prettier-vscode"
        }),
    );
    ins(
        m,
        "[python]",
        json!({
            "editor.tabSize": 4,
            "editor.formatOnSave": false,
            "editor.insertSpaces": true,
            "editor.wordBasedSuggestions": "off"
        }),
    );
    ins(
        m,
        "[go]",
        json!({
            "editor.tabSize": 4,
            "editor.insertSpaces": false,
            "editor.formatOnSave": true
        }),
    );
    ins(
        m,
        "[json]",
        json!({
            "editor.tabSize": 2,
            "editor.quickSuggestions": {"strings": true}
        }),
    );
    ins(
        m,
        "[jsonc]",
        json!({
            "editor.tabSize": 2,
            "editor.quickSuggestions": {"strings": true}
        }),
    );
    ins(
        m,
        "[yaml]",
        json!({
            "editor.tabSize": 2,
            "editor.insertSpaces": true,
            "editor.autoIndent": "advanced"
        }),
    );
    ins(
        m,
        "[html]",
        json!({
            "editor.tabSize": 2,
            "editor.suggest.insertMode": "replace"
        }),
    );
    ins(
        m,
        "[css]",
        json!({
            "editor.tabSize": 2,
            "editor.suggest.insertMode": "replace"
        }),
    );
    ins(
        m,
        "[markdown]",
        json!({
            "editor.wordWrap": "on",
            "editor.quickSuggestions": {"comments": "off", "strings": "off", "other": "off"}
        }),
    );
    ins(
        m,
        "[makefile]",
        json!({
            "editor.insertSpaces": false
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_is_object() {
        let d = builtin_defaults();
        assert!(d.is_object());
    }

    #[test]
    fn has_editor_font_size() {
        let d = builtin_defaults();
        assert_eq!(d["editor.fontSize"], 14);
    }

    #[test]
    fn has_workbench_theme() {
        let d = builtin_defaults();
        assert_eq!(d["workbench.colorTheme"], "Default Dark+");
    }

    #[test]
    fn has_files_auto_save() {
        let d = builtin_defaults();
        assert_eq!(d["files.autoSave"], "off");
    }

    #[test]
    fn has_terminal_font_size() {
        let d = builtin_defaults();
        assert_eq!(d["terminal.integrated.fontSize"], 14);
    }

    #[test]
    fn has_search_defaults() {
        let d = builtin_defaults();
        assert_eq!(d["search.useIgnoreFiles"], true);
    }

    #[test]
    fn has_window_defaults() {
        let d = builtin_defaults();
        assert_eq!(d["window.zoomLevel"], 0);
    }

    #[test]
    fn has_debug_defaults() {
        let d = builtin_defaults();
        assert_eq!(d["debug.console.fontSize"], 14);
    }

    #[test]
    fn has_explorer_defaults() {
        let d = builtin_defaults();
        assert_eq!(d["explorer.confirmDelete"], true);
    }

    #[test]
    fn has_git_defaults() {
        let d = builtin_defaults();
        assert_eq!(d["git.enabled"], true);
        assert_eq!(d["git.confirmSync"], true);
        assert_eq!(d["git.autofetch"], false);
    }

    #[test]
    fn has_language_overrides() {
        let d = builtin_defaults();
        let rust = &d["[rust]"];
        assert_eq!(rust["editor.tabSize"], 4);
        assert_eq!(rust["editor.formatOnSave"], true);
    }

    #[test]
    fn has_breadcrumb_defaults() {
        let d = builtin_defaults();
        assert_eq!(d["breadcrumbs.enabled"], true);
    }

    #[test]
    fn has_scm_defaults() {
        let d = builtin_defaults();
        assert_eq!(d["scm.alwaysShowActions"], false);
    }

    #[test]
    fn count_defaults() {
        let d = builtin_defaults();
        let count = d.as_object().unwrap().len();
        assert!(count > 350, "Expected 350+ defaults, got {count}");
    }
}
