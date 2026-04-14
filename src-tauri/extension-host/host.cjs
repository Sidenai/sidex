'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { EventEmitter } = require('events');
const crypto = require('crypto');

process.on('uncaughtException', (err) => {
  try {
    process.stderr.write(`[ext-host] uncaught exception: ${err?.stack || err?.message || String(err)}\n`);
  } catch {}
});

const _isWin = process.platform === 'win32';

function uriPathToFsPath(uriPath) {
  if (!uriPath) return uriPath;
  if (_isWin && /^\/[A-Za-z]:/.test(uriPath)) {
    return uriPath.slice(1).replace(/\//g, '\\');
  }
  return uriPath;
}

const VSCODE_RESOURCE_RE = /https:\/\/file\+[^.]*\.vscode-resource\.vscode-cdn\.net(\/[^"')\s]*)/g;

function extractResourcePath(url) {
  const m = /https:\/\/file\+[^.]*\.vscode-resource\.vscode-cdn\.net(\/[^"')\s]*)/.exec(url);
  return m ? uriPathToFsPath(decodeURIComponent(m[1])) : null;
}

function inlineWebviewResources(html) {
  if (!html || typeof html !== 'string') return html;
  let result = html;

  result = result.replace(
    /<link[^>]+href=["'](https:\/\/file\+[^.]*\.vscode-resource\.vscode-cdn\.net\/[^"']+\.css)["'][^>]*\/?>/gi,
    (_match, url) => {
      const p = extractResourcePath(url);
      if (!p) return _match;
      try {
        let css = fs.readFileSync(p, 'utf8');
        css = inlineCssUrls(css);
        return `<style>${css}</style>`;
      } catch { return _match; }
    }
  );

  result = result.replace(
    /<script[^>]+src=["'](https:\/\/file\+[^.]*\.vscode-resource\.vscode-cdn\.net\/[^"']+\.js)["'][^>]*><\/script>/gi,
    (_match, url) => {
      const p = extractResourcePath(url);
      if (!p) return _match;
      try {
        const content = fs.readFileSync(p, 'utf8').replace(/<\/script/gi, '<\\/script');
        return `<script>${content}<\/script>`;
      } catch { return _match; }
    }
  );

  const binaryMimes = {
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  };
  result = result.replace(VSCODE_RESOURCE_RE, (_match, rawPath) => {
    const p = decodeURIComponent(rawPath);
    const ext = path.extname(p).toLowerCase();
    const mime = binaryMimes[ext];
    if (mime) {
      try { return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`; } catch { return _match; }
    }
    try {
      const content = fs.readFileSync(p, 'utf8');
      const guessedMime = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'text/plain';
      return `data:${guessedMime};base64,${Buffer.from(content).toString('base64')}`;
    } catch { return _match; }
  });

  result = result.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');

  return result;
}

function inlineCssUrls(css) {
  const binaryMimes = {
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  };
  return css.replace(/url\(["']?(https:\/\/file\+[^.]*\.vscode-resource\.vscode-cdn\.net\/[^"')\s]+)["']?\)/gi, (_match, url) => {
    const p = extractResourcePath(url);
    if (!p) return _match;
    const mime = binaryMimes[path.extname(p).toLowerCase()];
    if (!mime) return _match;
    try { return `url(data:${mime};base64,${fs.readFileSync(p).toString('base64')})`; } catch { return _match; }
  });
}

process.on('unhandledRejection', (reason) => {
  try {
    process.stderr.write(`[ext-host] unhandled rejection: ${reason?.stack || reason?.message || String(reason)}\n`);
  } catch {}
});

process.env.VSCODE_NLS_CONFIG = JSON.stringify({
  userLocale: 'en',
  osLocale: 'en',
  resolvedLanguage: 'en',
  locale: 'en',
  availableLanguages: {},
});

class ExtensionHost extends EventEmitter {
  constructor() {
    super();
    this._extensions = new Map();
    this._diagnostics = new Map();
    this._commands = new Map();
    this._providers = {
      completion: [],
      hover: [],
      definition: [],
      references: [],
      documentSymbol: [],
      codeAction: [],
      codeLens: [],
      formatting: [],
      rangeFormatting: [],
      signatureHelp: [],
      documentHighlight: [],
      rename: [],
      documentLink: [],
      foldingRange: [],
      selectionRange: [],
      inlayHint: [],
      typeDefinition: [],
      implementation: [],
      declaration: [],
      color: [],
      onTypeFormatting: [],
      semanticTokens: [],
      workspaceSymbol: [],
    };
    this._reqId = 0;
    this._pendingRequests = new Map();
    this._disposables = [];
    this._extensionPaths = [];
    this._outputChannels = new Map();
    this._textDocuments = new Map();
    this._editors = new Map();
    this._activeEditorId = null;
    this._editorValues = new Map();
    this._nextDecorationTypeId = 0;
    this._decorationTypes = new Map();
    this._workspaceFolders = [];
    this._configuration = new Map();
    this._languageConfigurations = new Map();
    this._fileWatchers = new Map();
    this._nextWatcherId = 1;
    this._activationPromises = new Map();
    this._failedExtensions = new Set();
  }

  initialize() {
    this._registerBuiltinCommands();
    log('host initialized');
  }

  shutdown() {
    for (const [id, ext] of this._extensions) {
      try {
        if (ext.exports && typeof ext.exports.deactivate === 'function') {
          const result = ext.exports.deactivate();
          if (result && typeof result.then === 'function') {
            result.catch((e) => log(`deactivate error (${id}): ${e.message}`));
          }
        }
      } catch (e) {
        log(`deactivate error (${id}): ${e.message}`);
      }
    }
    this._extensions.clear();
    log('host shut down');
  }


  handleMessage(msg) {
    const { id, type, method, params } = msg;

    switch (type || method) {
      case 'ping':
        return { id, type: 'pong' };
      case 'initialize':
        return this._handleInitialize(id, params);
      case 'discoverExtensions':
        return this._handleDiscoverExtensions(id, params);
      case 'loadExtension':
        return this._handleLoadExtension(id, params);
      case 'activateExtension':
        return this._handleActivateExtension(id, params);
      case 'deactivateExtension':
        return this._handleDeactivateExtension(id, params);
      case 'executeCommand':
        return this._handleExecuteCommand(id, params);
      case 'documentOpened':
        return this._handleDocumentOpened(id, params);
      case 'documentChanged':
        return this._handleDocumentChanged(id, params);
      case 'documentClosed':
        return this._handleDocumentClosed(id, params);
      case 'provideCompletionItems':
        return this._handleProvideCompletionItems(id, params);
      case 'provideHover':
        return this._handleProvideHover(id, params);
      case 'provideDefinition':
        return this._handleProvideDefinition(id, params);
      case 'provideReferences':
        return this._handleProvideReferences(id, params);
      case 'provideDocumentSymbols':
        return this._handleProvideDocumentSymbols(id, params);
      case 'provideCodeActions':
        return this._invokeProviders('codeAction', id, params);
      case 'provideCodeLenses':
        return this._invokeProviders('codeLens', id, params);
      case 'provideFormatting':
        return this._invokeProviders('formatting', id, params);
      case 'provideRangeFormatting':
        return this._invokeProviders('rangeFormatting', id, params);
      case 'provideSignatureHelp':
        return this._invokeProviders('signatureHelp', id, params);
      case 'provideDocumentHighlight':
        return this._invokeProviders('documentHighlight', id, params);
      case 'provideRename':
        return this._handleProvideRename(id, params);
      case 'prepareRename':
        return this._handlePrepareRename(id, params);
      case 'provideDocumentLinks':
        return this._invokeProviders('documentLink', id, params);
      case 'provideFoldingRanges':
        return this._invokeProviders('foldingRange', id, params);
      case 'provideSelectionRanges':
        return this._invokeProviders('selectionRange', id, params);
      case 'provideInlayHints':
        return this._invokeProviders('inlayHint', id, params);
      case 'provideTypeDefinition':
        return this._invokeProviders('typeDefinition', id, params);
      case 'provideImplementation':
        return this._invokeProviders('implementation', id, params);
      case 'provideDeclaration':
        return this._invokeProviders('declaration', id, params);
      case 'provideDocumentColors':
        return this._invokeProviders('color', id, params);
      case 'provideSemanticTokens':
        return this._invokeProviders('semanticTokens', id, params);
      case 'provideWorkspaceSymbols':
        return this._invokeProviders('workspaceSymbol', id, params);
      case 'documentSaved':
        return this._handleDocumentSaved(id, params);
      case 'activeEditorChanged':
        return this._handleActiveEditorChanged(id, params);
      case 'editorsDelta':
        return this._handleEditorsDelta(id, params);
      case 'editorPropertiesChanged':
        return this._handleEditorPropertiesChanged(id, params);
      case 'messageResponse':
        return this._handleMessageResponse(id, params);
      case 'setLanguageConfiguration':
        return this._handleSetLanguageConfiguration(id, params);
      case 'fileWatchEvent':
        return this._handleFileWatchEvent(id, params);
      case 'listExtensions':
        return this._handleListExtensions(id);
      case 'getDiagnostics':
        return this._handleGetDiagnostics(id, params);
      case 'setConfiguration':
        return this._handleSetConfiguration(id, params);
      case 'getProviderCapabilities':
        return this._handleGetProviderCapabilities(id);
      case 'getExtensionState':
        return this._handleGetExtensionState(id);
      case 'resetPanels':
        return this._handleResetPanels(id);
      case 'activateByEvent':
        this._checkActivationEvents(params?.event || '');
        return { id, result: true };
      case 'viewOpened':
        this._checkActivationEvents(`onView:${params?.viewId || ''}`);
        return { id, result: true };
      case 'handleUri':
        this._checkActivationEvents('onUri');
        if (this._uriHandler && typeof this._uriHandler.handleUri === 'function') {
          try { this._uriHandler.handleUri(params?.uri); } catch {}
        }
        return { id, result: true };
      case 'debugStarted':
        this._checkActivationEvents('onDebug');
        if (params?.type) this._checkActivationEvents(`onDebugResolve:${params.type}`);
        return { id, result: true };
      case 'resolveWebviewView':
        return this._handleResolveWebviewView(id, params);
      case 'webviewViewMessage':
        return this._handleWebviewViewMessage(id, params);
      case 'webviewViewVisible':
        return this._handleWebviewViewVisible(id, params);
      case 'webviewViewDispose':
        return this._handleWebviewViewDispose(id, params);
      case 'webviewMessage':
        return this._handleWebviewMessage(id, params);
      case 'webviewPanelClosed':
        return this._handleWebviewPanelClosed(id, params);
      case 'workbenchCommandResult':
        if (params?.editorState && this._activeEditorId) {
          const ed = this._editors.get(this._activeEditorId);
          if (ed && params.editorState.selections) {
            ed.selections = params.editorState.selections;
            ed._vscSelections = params.editorState.selections.map(
              s => new VscSelection(s.anchor?.line ?? 0, s.anchor?.character ?? 0, s.active?.line ?? 0, s.active?.character ?? 0)
            );
          }
        }
        this.emit('inbound', { type: 'workbenchCommandResult', reqId: params?.reqId, result: params?.result, error: params?.error });
        return { id, result: true };
      default:
        return { id, error: `unknown method: ${type || method}` };
    }
  }


  _handleInitialize(id, params) {
    if (params && params.extensionPaths) {
      this._extensionPaths = params.extensionPaths;
    }
    if (params && params.workspaceFolders) {
      this._workspaceFolders = params.workspaceFolders;
    }
    return {
      id,
      result: {
        capabilities: [
          'completionProvider',
          'hoverProvider',
          'definitionProvider',
          'referencesProvider',
          'documentSymbolProvider',
          'diagnostics',
          'commands',
          'codeActionProvider',
          'codeLensProvider',
          'formattingProvider',
          'signatureHelpProvider',
          'renameProvider',
          'documentHighlightProvider',
          'typeDefinitionProvider',
          'implementationProvider',
          'foldingRangeProvider',
          'inlayHintProvider',
        ],
      },
    };
  }

  _handleDiscoverExtensions(id, params) {
    const searchPaths = (params && params.paths) || this._extensionPaths;
    const discovered = [];
    for (const searchPath of searchPaths) {
      try {
        if (!fs.existsSync(searchPath)) continue;
        const entries = fs.readdirSync(searchPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const extDir = path.join(searchPath, entry.name);
          const pkgPath = path.join(extDir, 'package.json');
          if (!fs.existsSync(pkgPath)) continue;
          try {
            const manifest = this._readManifest(extDir);
            discovered.push({
              id: manifest.id,
              name: manifest.name,
              path: extDir,
              activationEvents: manifest.activationEvents,
            });
          } catch (e) {
            log(`skip ${entry.name}: ${e.message}`);
          }
        }
      } catch (e) {
        log(`scan error ${searchPath}: ${e.message}`);
      }
    }
    return { id, result: discovered };
  }

  _handleLoadExtension(id, params) {
    try {
      const { extensionPath } = params;
      const manifest = this._readManifest(extensionPath);
      const existing = this._extensions.get(manifest.id);
      if (existing && existing.activated) {
        return { id, result: { extensionId: manifest.id, name: manifest.name, alreadyActive: true } };
      }
      this._extensions.set(manifest.id, {
        manifest,
        extensionPath,
        module: null,
        context: null,
        exports: null,
        activated: false,
      });
      return { id, result: { extensionId: manifest.id, name: manifest.name } };
    } catch (e) {
      return { id, error: e.message };
    }
  }

  _handleActivateExtension(id, params) {
    try {
      const { extensionId } = params;
      this._activateExtension(extensionId).catch((e) => {
        log(`activation error (${extensionId}): ${e.message}`);
      });
      return { id, result: { activated: true } };
    } catch (e) {
      return { id, error: e.message };
    }
  }

  _handleDeactivateExtension(id, params) {
    try {
      const { extensionId } = params;
      const ext = this._extensions.get(extensionId);
      if (!ext) throw new Error(`extension not found: ${extensionId}`);
      if (ext.exports && typeof ext.exports.deactivate === 'function') {
        ext.exports.deactivate();
      }
      ext.activated = false;
      return { id, result: { deactivated: true } };
    } catch (e) {
      return { id, error: e.message };
    }
  }

  async _handleExecuteCommand(id, params) {
    const { command, args } = params;
    let handler = this._commands.get(command);
    if (!handler) {
      this._checkActivationEvents(`onCommand:${command}`);
      await new Promise((r) => setTimeout(r, 100));
      handler = this._commands.get(command);
    }
    if (!handler) return { id, error: `unknown command: ${command}` };
    try {
      const result = handler(...(args || []));
      if (result && typeof result.then === 'function') {
        result
          .then((r) => this.emit('event', { id, result: r ?? null }))
          .catch((e) => this.emit('event', { id, error: e.message }));
        return undefined;
      }
      return { id, result: result ?? null };
    } catch (e) {
      return { id, error: e.message };
    }
  }

  _handleDocumentOpened(id, params) {
    const { uri, languageId, version, text } = params;
    this._textDocuments.set(uri, { uri, languageId, version, text: text || '' });
    this._onDocumentEvent.fire(this._makeDocumentProxy(uri));
    this._checkActivationEvents(`onLanguage:${languageId}`);
    return { id, result: true };
  }

  _handleDocumentChanged(id, params) {
    const { uri, version, text, changes } = params;
    const doc = this._textDocuments.get(uri);
    if (doc) {
      doc.version = version;
      if (text !== undefined) {
        doc.text = text;
      } else if (changes && changes.length && changes[0].text !== undefined && !changes[0].range) {
        doc.text = changes[0].text;
      }
    }
    this._onDocumentChangeEvent.fire({
      document: this._makeDocumentProxy(uri),
      contentChanges: (changes || []).map((c) => ({
        range: c.range
          ? new VscRange(c.range.start.line, c.range.start.character, c.range.end.line, c.range.end.character)
          : undefined,
        rangeOffset: c.rangeOffset,
        rangeLength: c.rangeLength,
        text: c.text || '',
      })),
      reason: undefined,
    });
    return { id, result: true };
  }

  _handleDocumentClosed(id, params) {
    const { uri } = params;
    const proxy = this._textDocuments.has(uri) ? this._makeDocumentProxy(uri) : null;
    this._textDocuments.delete(uri);
    if (proxy) this._onDocumentCloseEvent.fire(proxy);
    return { id, result: true };
  }

  _handleDocumentSaved(id, params) {
    const { uri } = params;
    const doc = this._textDocuments.get(uri);
    if (doc) {
      this._onDocumentSaveEvent.fire(this._makeDocumentProxy(uri));
    }
    return { id, result: true };
  }

  _handleActiveEditorChanged(id, params) {
    const { uri, languageId } = params;
    let editorId = null;
    for (const [eid, ed] of this._editors) {
      if (ed.uri === uri) { editorId = eid; break; }
    }
    if (uri && !editorId) {
      editorId = `legacy-${uri}`;
      this._editors.set(editorId, {
        id: editorId, uri, selections: [], options: { tabSize: 4, insertSpaces: true, cursorStyle: 1, lineNumbers: 1 }, visibleRanges: [], viewColumn: 1,
        _vscSelections: [new VscSelection(0, 0, 0, 0)]
      });
      this._editorValues.set(editorId, this._createEditorValue(editorId));
    }
    const oldActiveId = this._activeEditorId;
    this._activeEditorId = editorId;
    if (oldActiveId !== editorId) {
      this._onActiveEditorChangeEvent?.fire(editorId ? this._editorValues.get(editorId) : undefined);
    }
    return { id, result: true };
  }

  _handleEditorsDelta(id, params) {
    const { removedEditors, addedEditors, newActiveEditor } = params || {};

    if (removedEditors && Array.isArray(removedEditors)) {
      for (const edId of removedEditors) {
        this._editors.delete(edId);
        this._editorValues.delete(edId);
      }
    }

    if (addedEditors && Array.isArray(addedEditors)) {
      for (const added of addedEditors) {
        const sels = (added.selections || []).map(
          s => new VscSelection(s.anchor?.line ?? 0, s.anchor?.character ?? 0, s.active?.line ?? 0, s.active?.character ?? 0)
        );
        if (!sels.length) sels.push(new VscSelection(0, 0, 0, 0));
        this._editors.set(added.id, {
          id: added.id,
          uri: added.documentUri,
          selections: added.selections || [],
          options: added.options || { tabSize: 4, insertSpaces: true, cursorStyle: 1, lineNumbers: 1 },
          visibleRanges: added.visibleRanges || [],
          viewColumn: added.viewColumn || 1,
          _vscSelections: sels
        });
        this._editorValues.set(added.id, this._createEditorValue(added.id));
      }
    }

    if (removedEditors?.length || addedEditors?.length) {
      this._onVisibleEditorsChangeEvent?.fire([...this._editorValues.values()]);
    }

    if (newActiveEditor !== undefined) {
      const oldActiveId = this._activeEditorId;
      this._activeEditorId = newActiveEditor;
      if (oldActiveId !== newActiveEditor) {
        this._onActiveEditorChangeEvent?.fire(newActiveEditor ? this._editorValues.get(newActiveEditor) : undefined);
      }
    }

    return { id, result: true };
  }

  _handleEditorPropertiesChanged(id, params) {
    const { editorId, selections, options, visibleRanges } = params || {};
    const ed = this._editors.get(editorId);
    if (!ed) return { id, result: true };

    if (selections) {
      ed.selections = selections.selections || [];
      ed._vscSelections = (selections.selections || []).map(
        s => new VscSelection(s.anchor?.line ?? 0, s.anchor?.character ?? 0, s.active?.line ?? 0, s.active?.character ?? 0)
      );
      if (!ed._vscSelections.length) ed._vscSelections.push(new VscSelection(0, 0, 0, 0));
      this._onSelectionChangeEvent?.fire({
        textEditor: this._editorValues.get(editorId),
        selections: ed._vscSelections,
        kind: selections.source === 'keyboard' ? 1 : selections.source === 'mouse' ? 2 : selections.source === 'api' ? 3 : undefined
      });
    }

    if (options) {
      Object.assign(ed.options, options);
      this._onOptionsChangeEvent?.fire({
        textEditor: this._editorValues.get(editorId),
        options: ed.options
      });
    }

    if (visibleRanges) {
      ed.visibleRanges = visibleRanges;
      this._onVisibleRangesChangeEvent?.fire({
        textEditor: this._editorValues.get(editorId),
        visibleRanges: visibleRanges.map(r => new VscRange(r.start.line, r.start.character, r.end.line, r.end.character))
      });
    }

    return { id, result: true };
  }

  _handleMessageResponse(id, params) {
    const { requestId, value } = params;
    const callback = this._pendingRequests.get(requestId);
    if (callback) {
      this._pendingRequests.delete(requestId);
      callback(value);
    }
    return { id, result: true };
  }

  _handleSetLanguageConfiguration(id, params) {
    const { language, configuration } = params;
    if (language && configuration) {
      this._languageConfigurations.set(language, configuration);
      this.emit('event', { type: 'languageConfigurationChanged', language, configuration });
    }
    return { id, result: true };
  }

  _handleFileWatchEvent(id, params) {
    const { events } = params;
    if (!events || !Array.isArray(events)) return { id, result: true };
    for (const event of events) {
      const filePath = event.path;
      const kind = event.kind;
      const uri = VscUri.file(filePath);
      for (const [, watcher] of this._fileWatchers) {
        if (!this._matchGlob(watcher.pattern, filePath)) continue;
        if (kind === 'created') watcher.onCreate.fire(uri);
        else if (kind === 'modified') watcher.onChange.fire(uri);
        else if (kind === 'deleted') watcher.onDelete.fire(uri);
        else if (kind === 'renamed_to') watcher.onCreate.fire(uri);
        else if (kind === 'renamed_from') watcher.onDelete.fire(uri);
      }
    }
    return { id, result: true };
  }

  _matchGlob(pattern, filePath) {
    if (!pattern || pattern === '**' || pattern === '**/*') return true;
    const patternStr = typeof pattern === 'string' ? pattern : pattern.pattern || String(pattern);
    if (patternStr === '**' || patternStr === '**/*') return true;
    const ext = patternStr.match(/\*\*\/\*\.(\w+)$/);
    if (ext) return filePath.endsWith('.' + ext[1]);
    const extOnly = patternStr.match(/^\*\.(\w+)$/);
    if (extOnly) return filePath.endsWith('.' + extOnly[1]);
    if (patternStr.includes('/')) return filePath.includes(patternStr.replace(/\*\*/g, '').replace(/\*/g, ''));
    return true;
  }

  _makeTextEditorProxy(uri) {
    const doc = this._makeDocumentProxy(uri);
    let rawSelections = [];
    for (const [, ed] of this._editors) {
      if (ed.uri === uri) { rawSelections = ed.selections || []; break; }
    }
    const selections = rawSelections.map(
      (s) =>
        new VscSelection(s.anchor?.line ?? 0, s.anchor?.character ?? 0, s.active?.line ?? 0, s.active?.character ?? 0),
    );
    if (!selections.length) selections.push(new VscSelection(0, 0, 0, 0));
    return {
      document: doc,
      selection: selections[0],
      selections,
      visibleRanges: [new VscRange(0, 0, doc.lineCount, 0)],
      options: { tabSize: 4, insertSpaces: true, cursorStyle: 1, lineNumbers: 1 },
      viewColumn: 1,
      edit: (callback) => {
        const edits = [];
        const toRange = (loc) =>
          loc instanceof VscRange
            ? loc
            : loc?.start && loc?.end
              ? new VscRange(loc.start.line, loc.start.character, loc.end.line, loc.end.character)
              : new VscRange(loc, loc);
        const builder = {
          replace(loc, val) {
            edits.push({ range: toRange(loc), newText: val });
          },
          insert(pos, val) {
            edits.push({ range: new VscRange(pos, pos), newText: val });
          },
          delete(range) {
            edits.push({ range, newText: '' });
          },
          setEndOfLine() {},
        };
        callback(builder);
        if (edits.length) {
          const serializedEdits = edits.map((e) => ({ uri: doc.uri.toString(), range: e.range, newText: e.newText }));
          this.emit('event', { type: 'applyEdit', edits: serializedEdits });
          const stored = this._textDocuments.get(doc.uri.toString());
          if (stored) {
            const lines = stored.text.split('\n');
            const toOffset = (line, char) => {
              let off = 0;
              for (let i = 0; i < line && i < lines.length; i++) off += lines[i].length + 1;
              return off + Math.min(char, (lines[line] || '').length);
            };
            for (const e of edits) {
              const start = toOffset(e.range.start.line, e.range.start.character);
              const end = toOffset(e.range.end.line, e.range.end.character);
              stored.text = stored.text.substring(0, start) + e.newText + stored.text.substring(end);
              stored.version += 1;
            }
          }
        }
        return Promise.resolve(true);
      },
      insertSnippet: () => Promise.resolve(true),
      setDecorations: () => {},
      revealRange: () => {},
      show: () => {},
      hide: () => {},
    };
  }

  _createEditorValue(editorId) {
    const host = this;
    const value = Object.freeze({
      get document() {
        const ed = host._editors.get(editorId);
        return ed ? host._makeDocumentProxy(ed.uri) : undefined;
      },
      get selection() {
        const ed = host._editors.get(editorId);
        return ed?._vscSelections?.[0] || new VscSelection(0, 0, 0, 0);
      },
      set selection(sel) {
        const ed = host._editors.get(editorId);
        if (ed) {
          ed._vscSelections = [sel];
          host.emit('event', { type: 'trySetSelections', editorId, selections: [{ anchor: { line: sel.anchor.line, character: sel.anchor.character }, active: { line: sel.active.line, character: sel.active.character } }] });
        }
      },
      get selections() {
        const ed = host._editors.get(editorId);
        return ed?._vscSelections || [new VscSelection(0, 0, 0, 0)];
      },
      set selections(sels) {
        const ed = host._editors.get(editorId);
        if (ed) {
          ed._vscSelections = sels;
          host.emit('event', { type: 'trySetSelections', editorId, selections: sels.map(s => ({ anchor: { line: s.anchor.line, character: s.anchor.character }, active: { line: s.active.line, character: s.active.character } })) });
        }
      },
      get options() {
        const ed = host._editors.get(editorId);
        return ed?.options || { tabSize: 4, insertSpaces: true, cursorStyle: 1, lineNumbers: 1 };
      },
      set options(opts) {
        const ed = host._editors.get(editorId);
        if (ed && opts && typeof opts === 'object') {
          Object.assign(ed.options, opts);
          host.emit('event', { type: 'trySetOptions', editorId, options: ed.options });
        }
      },
      get visibleRanges() {
        const ed = host._editors.get(editorId);
        return (ed?.visibleRanges || []).map(r => new VscRange(r.start?.line ?? 0, r.start?.character ?? 0, r.end?.line ?? 0, r.end?.character ?? 0));
      },
      get viewColumn() {
        const ed = host._editors.get(editorId);
        return ed?.viewColumn || 1;
      },
      edit(callback) {
        const ed = host._editors.get(editorId);
        if (!ed) return Promise.resolve(false);
        const doc = host._makeDocumentProxy(ed.uri);
        const edits = [];
        const toRange = (loc) =>
          loc instanceof VscRange
            ? loc
            : loc?.start && loc?.end
              ? new VscRange(loc.start.line, loc.start.character, loc.end.line, loc.end.character)
              : new VscRange(loc, loc);
        const builder = {
          replace(loc, val) { edits.push({ range: toRange(loc), newText: val }); },
          insert(pos, val) { edits.push({ range: new VscRange(pos, pos), newText: val }); },
          delete(range) { edits.push({ range, newText: '' }); },
          setEndOfLine() {},
        };
        callback(builder);
        if (edits.length) {
          const serializedEdits = edits.map(e => ({ uri: doc.uri.toString(), range: e.range, newText: e.newText }));
          host.emit('event', { type: 'applyEdit', edits: serializedEdits });
          const stored = host._textDocuments.get(doc.uri.toString());
          if (stored) {
            const lines = stored.text.split('\n');
            const toOffset = (line, char) => {
              let off = 0;
              for (let i = 0; i < line && i < lines.length; i++) off += lines[i].length + 1;
              return off + Math.min(char, (lines[line] || '').length);
            };
            for (const e of edits) {
              const start = toOffset(e.range.start.line, e.range.start.character);
              const end = toOffset(e.range.end.line, e.range.end.character);
              stored.text = stored.text.substring(0, start) + e.newText + stored.text.substring(end);
              stored.version += 1;
            }
          }
        }
        return Promise.resolve(true);
      },
      insertSnippet: () => Promise.resolve(true),
      setDecorations(decorationType, ranges) {
        const key = decorationType?.key || decorationType;
        const serialized = (ranges || []).map(r => {
          if (r.range) return { range: r.range, renderOptions: r.renderOptions, hoverMessage: r.hoverMessage };
          return { range: r };
        });
        host.emit('event', { type: 'trySetDecorations', editorId, key, ranges: serialized });
      },
      revealRange(range, revealType) {
        host.emit('event', { type: 'tryRevealRange', editorId, range: { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } }, revealType: revealType || 0 });
      },
      show() {},
      hide() {},
    });
    return value;
  }

  _handleSetConfiguration(id, params) {
    if (params && params.settings) {
      for (const [k, v] of Object.entries(params.settings)) {
        this._configuration.set(k, v);
      }
      this._onConfigChangeEvent?.fire({
        affectsConfiguration: (section) => {
          return Object.keys(params.settings).some((k) => k === section || k.startsWith(section + '.'));
        },
      });
    }
    return { id, result: true };
  }

  _handleProvideCompletionItems(id, params) {
    return this._invokeProviders('completion', id, params);
  }
  _handleProvideHover(id, params) {
    return this._invokeProviders('hover', id, params);
  }
  _handleProvideDefinition(id, params) {
    return this._invokeProviders('definition', id, params);
  }
  _handleProvideReferences(id, params) {
    return this._invokeProviders('references', id, params);
  }
  _handleProvideDocumentSymbols(id, params) {
    return this._invokeProviders('documentSymbol', id, params);
  }

  _handleProvideRename(id, params) {
    const providers = this._providers.rename || [];
    if (!providers.length) return { id, result: null };
    const doc = this._makeDocumentProxy(
      params.uri || params.textDocument?.uri,
      params.languageId || params.textDocument?.languageId,
      params.version || params.textDocument?.version,
    );
    const pos = params.position
      ? new VscPosition(params.position.line, params.position.character)
      : new VscPosition(0, 0);
    const token = { isCancellationRequested: false, onCancellationRequested: noopEvent };
    const newName = params.newName || '';
    const promises = providers
      .filter((p) => this._matchSelector(p.selector, doc))
      .map((p) => {
        try {
          return Promise.resolve(p.provider.provideRenameEdits(doc, pos, newName, token));
        } catch (e) {
          return Promise.resolve(null);
        }
      });
    Promise.all(promises)
      .then((results) => {
        const edits = [];
        for (const r of results) {
          if (!r) continue;
          if (r._edits)
            edits.push(
              ...r._edits.map((e) => ({ uri: e.uri?.toString?.() || '', range: e.range, newText: e.newText })),
            );
        }
        this.emit('event', { id, result: { edits } });
      })
      .catch((e) => this.emit('event', { id, error: e.message }));
    return undefined;
  }

  _handlePrepareRename(id, params) {
    const providers = this._providers.rename || [];
    if (!providers.length) return { id, result: null };
    const doc = this._makeDocumentProxy(
      params.uri || params.textDocument?.uri,
      params.languageId || params.textDocument?.languageId,
      params.version || params.textDocument?.version,
    );
    const pos = params.position
      ? new VscPosition(params.position.line, params.position.character)
      : new VscPosition(0, 0);
    const token = { isCancellationRequested: false, onCancellationRequested: noopEvent };
    const provider = providers.find((p) => this._matchSelector(p.selector, doc));
    if (!provider || !provider.provider.prepareRename) return { id, result: null };
    Promise.resolve(provider.provider.prepareRename(doc, pos, token))
      .then((r) => {
        if (!r) return this.emit('event', { id, result: null });
        if (r.range) this.emit('event', { id, result: { range: r.range, placeholder: r.placeholder || '' } });
        else this.emit('event', { id, result: { range: r, placeholder: '' } });
      })
      .catch((e) => this.emit('event', { id, error: e.message }));
    return undefined;
  }

  _handleListExtensions(id) {
    const list = [];
    for (const [extId, ext] of this._extensions) {
      list.push({ id: extId, name: ext.manifest.name, version: ext.manifest.version, activated: ext.activated });
    }
    return { id, result: list };
  }

  _handleGetDiagnostics(id, params) {
    const uri = params && params.uri;
    if (uri) return { id, result: this._diagnostics.get(uri) || [] };
    const all = [];
    for (const [u, diags] of this._diagnostics) {
      all.push([u, diags]);
    }
    return { id, result: all };
  }

  _handleGetProviderCapabilities(id) {
    const capabilities = {};
    for (const [kind, providers] of Object.entries(this._providers)) {
      if (providers.length > 0) {
        capabilities[kind] = providers.map((p) => p.selector);
      }
    }
    return { id, result: capabilities };
  }

  _handleGetExtensionState(id) {
    const commands = [...this._commands.keys()];
    const webviewViewProviders = this._webviewViewProviders ? [...this._webviewViewProviders.keys()] : [];
    const customEditorProviders = this._customEditorProviders ? [...this._customEditorProviders.keys()] : [];
    return {
      id,
      result: { commands, webviewViewProviders, customEditorProviders },
    };
  }

  _handleResetPanels(id) {
    if (this._webviewPanels) {
      for (const [panelId, panel] of this._webviewPanels) {
        if (panel && panel._disposeEmitter) {
          panel._disposeEmitter.fire();
          panel._disposeEmitter.dispose();
        }
        if (panel && panel._messageEmitter) panel._messageEmitter.dispose();
        if (panel && panel._viewStateEmitter) panel._viewStateEmitter.dispose();
      }
      this._webviewPanels.clear();
    }
    if (this._webviewViews) {
      for (const [handle, entry] of this._webviewViews) {
        entry.disposeEmitter.emit('dispose');
      }
      this._webviewViews.clear();
    }
    return { id, result: true };
  }

  _handleResolveWebviewView(id, params) {
    const { viewId, webviewHandle } = params;
    const provider = this._webviewViewProviders?.get(viewId);
    if (!provider) return { id, error: `no provider for ${viewId}` };

    const messageEmitter = new (require('events').EventEmitter)();
    const disposeEmitter = new (require('events').EventEmitter)();
    const visibilityEmitter = new (require('events').EventEmitter)();
    let _html = '';
    let _visible = true;
    let _options = { enableScripts: true, enableForms: false, localResourceRoots: [] };
    const host = this;
    const RESOURCE_AUTHORITY = 'vscode-resource.vscode-cdn.net';

    const webviewView = {
      get viewType() { return viewId; },
      _handle: webviewHandle,
      title: params.title || '',
      description: '',
      badge: undefined,
      webview: {
        get options() { return _options; },
        set options(v) { _options = { ..._options, ...v }; },
        get html() { return _html; },
        set html(v) {
          _html = v;
          host.emit('event', { type: 'webviewViewHtmlUpdate', webviewHandle, html: inlineWebviewResources(v) });
        },
        onDidReceiveMessage: (listener) => {
          messageEmitter.on('message', listener);
          return { dispose() { messageEmitter.removeListener('message', listener); } };
        },
        postMessage(msg) {
          host.emit('event', { type: 'webviewViewPostMessage', webviewHandle, message: msg });
          return Promise.resolve(true);
        },
        asWebviewUri(localUri) {
          if (!localUri) return localUri;
          const u = typeof localUri === 'string' ? localUri : (localUri.toString ? localUri.toString() : String(localUri));
          const scheme = localUri.scheme || 'file';
          const authority = localUri.authority || '';
          const uriPath = localUri.path || '';
          const nativePath = localUri.fsPath || uriPathToFsPath(uriPath) || '';
          if (scheme === 'http' || scheme === 'https') return localUri;
          const imgMimes = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon' };
          const ext = path.extname(nativePath).toLowerCase();
          if (imgMimes[ext]) {
            try {
              const dataUri = `data:${imgMimes[ext]};base64,${fs.readFileSync(nativePath).toString('base64')}`;
              return { scheme: 'data', authority: '', path: dataUri.slice(5), query: '', fragment: '', fsPath: nativePath, toString() { return dataUri; }, with(change) { return { ...this, ...change }; }, toJSON() { return { $mid: 1, scheme: 'data', path: this.path }; } };
            } catch {}
          }
          return {
            scheme: 'https',
            authority: `${scheme}+${authority}.${RESOURCE_AUTHORITY}`,
            path: uriPath,
            query: localUri.query || '',
            fragment: localUri.fragment || '',
            fsPath: nativePath,
            toString() { return `https://${this.authority}${this.path}`; },
            with(change) { return { ...this, ...change }; },
            toJSON() { return { scheme: this.scheme, authority: this.authority, path: this.path }; },
          };
        },
        cspSource: `https://*.${RESOURCE_AUTHORITY} 'self' http://localhost:* *`,
      },
      get visible() { return _visible; },
      onDidChangeVisibility: (listener) => {
        visibilityEmitter.on('change', listener);
        return { dispose() { visibilityEmitter.removeListener('change', listener); } };
      },
      onDispose: (listener) => {
        disposeEmitter.on('dispose', listener);
        return { dispose() { disposeEmitter.removeListener('dispose', listener); } };
      },
      dispose() { disposeEmitter.emit('dispose'); },
      show(preserveFocus) {
        host.emit('event', { type: 'webviewViewShow', webviewHandle, preserveFocus });
      },
    };

    if (!this._webviewViews) this._webviewViews = new Map();
    this._webviewViews.set(webviewHandle, { view: webviewView, messageEmitter, disposeEmitter, visibilityEmitter });

    try {
      provider.resolveWebviewView(webviewView, { state: params.state }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    } catch (e) {
      log(`resolveWebviewView error (${viewId}): ${e.message}`);
    }
    return { id, result: { resolved: true } };
  }

  _handleWebviewViewMessage(id, params) {
    const entry = this._webviewViews?.get(params.webviewHandle);
    if (entry) entry.messageEmitter.emit('message', params.message);
    return { id, result: true };
  }

  _handleWebviewViewVisible(id, params) {
    const entry = this._webviewViews?.get(params.webviewHandle);
    if (entry) entry.visibilityEmitter.emit('change', params.visible);
    return { id, result: true };
  }

  _handleWebviewViewDispose(id, params) {
    const entry = this._webviewViews?.get(params.webviewHandle);
    if (entry) {
      entry.disposeEmitter.emit('dispose');
      this._webviewViews.delete(params.webviewHandle);
    }
    return { id, result: true };
  }

  _handleWebviewMessage(id, params) {
    const panel = [...(this._webviewPanels?.values?.() || [])].find(p => p?._panelId === params.panelId);
    if (panel && panel._messageEmitter) panel._messageEmitter.fire(params.message);
    return { id, result: true };
  }

  _handleWebviewPanelClosed(id, params) {
    const panel = [...(this._webviewPanels?.values?.() || [])].find(p => p?._panelId === params.panelId);
    if (panel) {
      if (panel._disposeEmitter) {
        panel._disposeEmitter.fire();
        panel._disposeEmitter.dispose();
      }
      if (panel._messageEmitter) panel._messageEmitter.dispose();
      if (panel._viewStateEmitter) panel._viewStateEmitter.dispose();
      this._webviewPanels.delete(params.panelId);
    }
    return { id, result: true };
  }

  _invokeProviders(kind, id, params) {
    const providers = this._providers[kind] || [];
    if (!providers.length) {
      const empty =
        kind === 'hover' ||
        kind === 'definition' ||
        kind === 'typeDefinition' ||
        kind === 'implementation' ||
        kind === 'declaration'
          ? null
          : [];
      return { id, result: kind === 'completion' ? { items: [] } : empty };
    }
    const uri = params.uri || params.textDocument?.uri;
    if (uri && !this._textDocuments.has(uri)) {
      const langId = params.languageId || params.textDocument?.languageId || 'plaintext';
      const ver = params.version || params.textDocument?.version || 1;
      this._textDocuments.set(uri, { uri, languageId: langId, version: ver, text: '' });
      if (uri.startsWith('file://')) {
        try {
          const filePath = uri.startsWith('file:///') ? uri.slice(7) : uri.slice(5);
          if (fs.existsSync(filePath)) {
            this._textDocuments.get(uri).text = fs.readFileSync(filePath, 'utf-8');
          }
        } catch {}
      }
      this._onDocumentEvent.fire(this._makeDocumentProxy(uri));
      log(`[providers] auto-synced document for ${kind}: ${uri} (${this._textDocuments.get(uri).text.length} chars)`);
    }
    const doc = this._makeDocumentProxy(
      uri,
      params.languageId || params.textDocument?.languageId,
      params.version || params.textDocument?.version,
    );
    const pos = params.position
      ? new VscPosition(params.position.line, params.position.character)
      : new VscPosition(0, 0);
    const token = { isCancellationRequested: false, onCancellationRequested: noopEvent };

    const providerFnMap = {
      completion: (p) =>
        p.provideCompletionItems(doc, pos, token, {
          triggerKind: typeof params.triggerKind === 'number' ? params.triggerKind : 0,
          triggerCharacter: params.triggerCharacter,
        }),
      hover: (p) => p.provideHover(doc, pos, token),
      definition: (p) => p.provideDefinition(doc, pos, token),
      typeDefinition: (p) => p.provideTypeDefinition(doc, pos, token),
      implementation: (p) => p.provideImplementation(doc, pos, token),
      declaration: (p) => p.provideDeclaration(doc, pos, token),
      references: (p) => p.provideReferences(doc, pos, { includeDeclaration: true }, token),
      documentSymbol: (p) => p.provideDocumentSymbols(doc, token),
      codeAction: (p) => {
        const range = params.range
          ? new VscRange(
              params.range.start.line,
              params.range.start.character,
              params.range.end.line,
              params.range.end.character,
            )
          : new VscRange(pos, pos);
        const diagnostics = (params.context?.diagnostics || []).map((d) => ({
          range: d.range
            ? new VscRange(d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character)
            : undefined,
          message: d.message || '',
          severity: d.severity,
          source: d.source,
          code: d.code,
          relatedInformation: d.relatedInformation || [],
          tags: d.tags || [],
        }));
        return p.provideCodeActions(
          doc,
          range,
          { diagnostics, triggerKind: params.context?.triggerKind || 1, only: params.context?.only },
          token,
        );
      },
      codeLens: (p) => p.provideCodeLenses(doc, token),
      formatting: (p) =>
        p.provideDocumentFormattingEdits(doc, params.options || { tabSize: 4, insertSpaces: true }, token),
      rangeFormatting: (p) => {
        const range = params.range
          ? new VscRange(
              params.range.start.line,
              params.range.start.character,
              params.range.end.line,
              params.range.end.character,
            )
          : new VscRange(0, 0, 0, 0);
        return p.provideDocumentRangeFormattingEdits(
          doc,
          range,
          params.options || { tabSize: 4, insertSpaces: true },
          token,
        );
      },
      signatureHelp: (p) => p.provideSignatureHelp(doc, pos, token, { triggerKind: 1, isRetrigger: false }),
      documentHighlight: (p) => p.provideDocumentHighlights(doc, pos, token),
      documentLink: (p) => p.provideDocumentLinks(doc, token),
      foldingRange: (p) => p.provideFoldingRanges(doc, {}, token),
      selectionRange: (p) => {
        const positions = params.positions
          ? params.positions.map((pp) => new VscPosition(pp.line, pp.character))
          : [pos];
        return p.provideSelectionRanges(doc, positions, token);
      },
      inlayHint: (p) => {
        const range = params.range
          ? new VscRange(
              params.range.start.line,
              params.range.start.character,
              params.range.end.line,
              params.range.end.character,
            )
          : new VscRange(0, 0, doc.lineCount, 0);
        return p.provideInlayHints(doc, range, token);
      },
      color: (p) => p.provideDocumentColors(doc, token),
      semanticTokens: (p) => p.provideDocumentSemanticTokens(doc, token),
      workspaceSymbol: (p) => p.provideWorkspaceSymbols(params.query || '', token),
    };

    const callFn = providerFnMap[kind];
    if (!callFn) return { id, result: null };

    const promises = providers
      .filter((p) => this._matchSelector(p.selector, doc))
      .map((p, idx) => {
        try {
          return Promise.resolve(callFn(p.provider));
        } catch (e) {
          return Promise.resolve(null);
        }
      });

    Promise.all(promises)
      .then((results) => {
        let merged =
          kind === 'completion'
            ? { items: [] }
            : kind === 'hover' ||
                kind === 'definition' ||
                kind === 'typeDefinition' ||
                kind === 'implementation' ||
                kind === 'declaration' ||
                kind === 'signatureHelp'
              ? null
              : [];
        for (const r of results) {
          if (!r) continue;
          if (kind === 'completion') {
            const items = Array.isArray(r) ? r : r.items || [];
            merged.items.push(...items.map(serializeCompletionItem));
          } else if (kind === 'hover') {
            merged = serializeHover(r);
          } else if (kind === 'documentSymbol') {
            const items = Array.isArray(r) ? r : [];
            merged = (merged || []).concat(items.map(serializeDocumentSymbol));
          } else if (kind === 'codeAction') {
            const items = Array.isArray(r) ? r : [];
            merged = (merged || []).concat(
              items.map((a) => ({
                title: a.title,
                kind: typeof a.kind === 'string' ? a.kind : a.kind?.value,
                diagnostics: a.diagnostics || [],
                isPreferred: a.isPreferred || false,
                edit: a.edit
                  ? {
                      edits: (a.edit._edits || []).map((e) => ({
                        uri: e.uri?.toString?.() || '',
                        range: e.range,
                        newText: e.newText,
                      })),
                    }
                  : undefined,
                command: a.command,
              })),
            );
          } else if (kind === 'codeLens') {
            const items = Array.isArray(r) ? r : [];
            merged = (merged || []).concat(items.map((l) => ({ range: l.range, command: l.command })));
          } else if (kind === 'formatting' || kind === 'rangeFormatting') {
            const items = Array.isArray(r) ? r : [];
            merged = (merged || []).concat(items.map((e) => ({ range: e.range, newText: e.newText })));
          } else if (kind === 'signatureHelp') {
            merged = r
              ? {
                  signatures: (r.signatures || []).map((s) => ({
                    label: s.label,
                    documentation: s.documentation,
                    parameters: s.parameters,
                  })),
                  activeSignature: r.activeSignature ?? 0,
                  activeParameter: r.activeParameter ?? 0,
                }
              : null;
          } else if (kind === 'documentHighlight') {
            const items = Array.isArray(r) ? r : [];
            merged = (merged || []).concat(items.map((h) => ({ range: h.range, kind: h.kind ?? 0 })));
          } else if (kind === 'documentLink') {
            const items = Array.isArray(r) ? r : [];
            merged = (merged || []).concat(
              items.map((l) => ({ range: l.range, target: l.target?.toString?.() || '' })),
            );
          } else if (kind === 'foldingRange') {
            const items = Array.isArray(r) ? r : [];
            merged = (merged || []).concat(items.map((f) => ({ start: f.start, end: f.end, kind: f.kind })));
          } else if (kind === 'selectionRange') {
            merged = Array.isArray(r) ? r.map(serializeSelectionRange) : merged;
          } else if (kind === 'inlayHint') {
            const items = Array.isArray(r) ? r : [];
            merged = (merged || []).concat(
              items.map((h) => ({
                position: h.position,
                label: typeof h.label === 'string' ? h.label : h.label?.map?.((p) => ({ value: p.value || '' })) || '',
                kind: h.kind,
                paddingLeft: h.paddingLeft,
                paddingRight: h.paddingRight,
              })),
            );
          } else if (kind === 'color') {
            const items = Array.isArray(r) ? r : [];
            merged = (merged || []).concat(
              items.map((c) => ({
                range: c.range,
                color: { red: c.color.red, green: c.color.green, blue: c.color.blue, alpha: c.color.alpha },
              })),
            );
          } else if (kind === 'semanticTokens') {
            if (r && r.data) merged = { data: Array.from(r.data), resultId: r.resultId };
          } else if (kind === 'workspaceSymbol') {
            const items = Array.isArray(r) ? r : [];
            merged = (merged || []).concat(
              items.map((s) => ({ name: s.name, kind: s.kind, location: serializeLocation(s.location) })),
            );
          } else if (Array.isArray(r)) {
            merged = (merged || []).concat(r.map(serializeLocation));
          } else {
            merged = serializeLocation(r);
          }
        }
        this.emit('event', { id, result: merged });
      })
      .catch((e) => {
        this.emit('event', { id, error: e.message });
      });
    return undefined;
  }

  _matchSelector(selector, doc) {
    if (!selector) return true;
    const sel =
      typeof selector === 'string' ? [{ language: selector }] : Array.isArray(selector) ? selector : [selector];
    const docScheme = doc.uri?.scheme || 'file';
    return sel.some((s) => {
      if (typeof s === 'string') return s === doc.languageId || s === '*';
      if (s.notebookType) return false;
      const langMatch = !s.language || s.language === doc.languageId || s.language === '*';
      const schemeMatch = !s.scheme || s.scheme === docScheme || s.scheme === '*';
      return langMatch && schemeMatch;
    });
  }

  _makeDocumentProxy(uri, fallbackLanguageId, fallbackVersion) {
    const stored = this._textDocuments.get(uri);
    const text = stored ? stored.text : '';
    const lines = text.split('\n');
    const parsedUri = VscUri.parse(uri || 'file:///untitled');
    return {
      uri: parsedUri,
      fileName: parsedUri?.fsPath || (uri ? uri.replace(/^file:\/\//, '') : ''),
      languageId: stored?.languageId || fallbackLanguageId || 'plaintext',
      version: stored?.version || fallbackVersion || 1,
      lineCount: lines.length,
      getText: (range) => {
        if (!range) return text;
        const toOffset = (line, char) => {
          let off = 0;
          for (let i = 0; i < line && i < lines.length; i++) off += lines[i].length + 1;
          return off + Math.min(char, (lines[line] || '').length);
        };
        return text.substring(
          toOffset(range.start.line, range.start.character),
          toOffset(range.end.line, range.end.character),
        );
      },
      getWordRangeAtPosition: (pos, regex) => {
        const line = lines[pos.line] || '';
        const source = regex ? regex.source : '\\w+';
        const flags = regex ? (regex.flags.includes('g') ? regex.flags : regex.flags + 'g') : 'g';
        const re = new RegExp(source, flags);
        let m;
        while ((m = re.exec(line)) !== null) {
          if (m.index <= pos.character && pos.character <= m.index + m[0].length) {
            return new VscRange(pos.line, m.index, pos.line, m.index + m[0].length);
          }
          if (!re.global) break;
        }
        return undefined;
      },
      lineAt: (lineOrPos) => {
        const ln = typeof lineOrPos === 'number' ? lineOrPos : lineOrPos.line;
        const t = lines[ln] || '';
        return {
          lineNumber: ln,
          text: t,
          range: new VscRange(ln, 0, ln, t.length),
          firstNonWhitespaceCharacterIndex: t.search(/\S/),
          isEmptyOrWhitespace: t.trim().length === 0,
        };
      },
      offsetAt: (pos) => lines.slice(0, pos.line).join('\n').length + (pos.line > 0 ? 1 : 0) + pos.character,
      positionAt: (offset) => {
        let remaining = offset;
        for (let i = 0; i < lines.length; i++) {
          if (remaining <= lines[i].length) return new VscPosition(i, remaining);
          remaining -= lines[i].length + 1;
        }
        return new VscPosition(lines.length - 1, (lines[lines.length - 1] || '').length);
      },
      validateRange: (r) => r,
      validatePosition: (p) => p,
      isDirty: false,
      isUntitled: false,
      isClosed: false,
      eol: 1,
      save: () => Promise.resolve(true),
    };
  }

  _checkActivationEvents(event) {
    for (const [extId, ext] of this._extensions) {
      if (ext.activated) continue;
      const events = ext.manifest.activationEvents || [];
      if (events.includes(event) || events.includes('*') || events.includes('onStartupFinished')) {
        this._activateExtension(extId).catch((e) => log(`activation error (${extId}): ${e.message}`));
      }
    }
  }

  _readManifest(extensionPath) {
    const pkgPath = path.join(extensionPath, 'package.json');
    if (!fs.existsSync(pkgPath)) throw new Error(`no package.json at ${extensionPath}`);
    const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const publisher = raw.publisher || 'unknown';
    const name = raw.name || path.basename(extensionPath);
    return {
      id: `${publisher}.${name}`,
      name: raw.displayName || name,
      version: raw.version || '0.0.0',
      main: raw.main || raw.browser,
      activationEvents: raw.activationEvents || [],
      contributes: raw.contributes || {},
      extensionDependencies: raw.extensionDependencies || [],
      packageJSON: raw,
    };
  }

  async _activateExtension(extensionId) {
    const ext = this._extensions.get(extensionId);
    if (!ext) return null;
    if (ext.activated) return ext.exports;
    if (this._activationPromises.has(extensionId)) return this._activationPromises.get(extensionId);
    if (this._failedExtensions.has(extensionId)) return null;
    if (!ext.manifest.main) {
      ext.activated = true;
      return;
    }

    const mainPath = path.resolve(ext.extensionPath, ext.manifest.main);
    if (!fs.existsSync(mainPath) && !fs.existsSync(mainPath + '.js')) {
      log(`main not found: ${mainPath}`);
      ext.activated = true;
      return;
    }

    const context = this._createExtensionContext(extensionId, ext);
    const activationPromise = (async () => {
      try {
        const mod = await this._loadExtensionModule(mainPath);
        ext.module = mod;
        ext.context = context;
        if (typeof mod.activate === 'function') {
          const result = await Promise.resolve(mod.activate(context));
          ext.exports = result || mod;
        } else {
          ext.exports = mod;
        }
        ext.activated = true;
        this._failedExtensions.delete(extensionId);
        log(`activated ${extensionId}`);
        this.emit('event', { type: 'extensionActivated', extensionId });
        return ext.exports;
      } catch (e) {
        this._failedExtensions.add(extensionId);
        log(`activate error (${extensionId}): ${e.stack || e.message}`);
        throw e;
      } finally {
        this._activationPromises.delete(extensionId);
      }
    })();
    this._activationPromises.set(extensionId, activationPromise);
    return activationPromise;
  }

  async _loadExtensionModule(mainPath) {
    try {
      return require(mainPath);
    } catch (e) {
      if (e && e.code === 'ERR_REQUIRE_ESM') {
        const withExt = fs.existsSync(mainPath) ? mainPath : `${mainPath}.js`;
        const mod = await import(pathToFileURL(withExt).href);
        return mod && mod.default && typeof mod.activate === 'undefined' ? mod.default : mod;
      }
      throw e;
    }
  }

  _createExtensionContext(extensionId, ext) {
    const extensionPath = ext.extensionPath;
    const subscriptions = [];
    const storagePath = path.join(extensionPath, '.storage');
    const globalStoragePath = path.join(extensionPath, '.global-storage');
    try {
      fs.mkdirSync(storagePath, { recursive: true });
    } catch {}
    try {
      fs.mkdirSync(globalStoragePath, { recursive: true });
    } catch {}

    const secrets = new Map();
    const workspaceState = createMemento();
    const globalState = createMemento();
    globalState.update('PYTHON_GLOBAL_STORAGE_KEYS', []);
    globalState.update('PYTHON_EXTENSION_GLOBAL_STORAGE_KEYS', []);
    workspaceState.update('PYTHON_WORKSPACE_STORAGE_KEYS', []);
    workspaceState.update('PYTHON_EXTENSION_WORKSPACE_STORAGE_KEYS', []);
    return {
      extensionPath,
      extensionUri: VscUri.file(extensionPath),
      storagePath,
      globalStoragePath,
      logPath: storagePath,
      storageUri: VscUri.file(storagePath),
      globalStorageUri: VscUri.file(globalStoragePath),
      logUri: VscUri.file(storagePath),
      extensionMode: 3, // Production
      subscriptions,
      asAbsolutePath: (rel) => path.join(extensionPath, rel),
      workspaceState,
      globalState,
      secrets: {
        get: (key) => Promise.resolve(secrets.get(key)),
        store: (key, value) => {
          secrets.set(key, value);
          return Promise.resolve();
        },
        delete: (key) => {
          secrets.delete(key);
          return Promise.resolve();
        },
        onDidChange: noopEvent,
      },
      environmentVariableCollection: {
        persistent: true,
        description: '',
        replace: () => {},
        append: () => {},
        prepend: () => {},
        get: () => undefined,
        forEach: () => {},
        delete: () => {},
        clear: () => {},
        [Symbol.iterator]: function* () {},
        getScoped(scope) {
          return {
            persistent: true,
            description: '',
            replace: () => {},
            append: () => {},
            prepend: () => {},
            get: () => undefined,
            forEach: () => {},
            delete: () => {},
            clear: () => {},
            [Symbol.iterator]: function* () {},
          };
        },
      },
      extension: {
        id: extensionId,
        extensionUri: VscUri.file(extensionPath),
        extensionPath,
        isActive: true,
        packageJSON: ext.manifest.packageJSON || ext.manifest,
        extensionKind: 1,
        exports: undefined,
      },
      languageModelAccessInformation: { onDidChange: noopEvent, canSendRequest: () => undefined },
    };
  }

  _registerBuiltinCommands() {
    this._commands.set('sidex.extHost.ping', () => 'pong');
    this._commands.set('setContext', () => undefined);
    this._commands.set('sidex.extHost.listLoaded', () => {
      const list = [];
      for (const [id, ext] of this._extensions) list.push({ id, activated: ext.activated });
      return list;
    });
  }
}


function log(msg) {
  process.stderr.write(`[ext-host] ${msg}\n`);
}

const noopDisposable = { dispose() {} };
const noopEvent = (_listener) => noopDisposable;

function createMemento() {
  const store = new Map();
  return {
    keys: () => [...store.keys()],
    get: (key, defaultValue) => {
      if (!store.has(key)) return defaultValue;
      const v = store.get(key);
      return v === undefined || v === null ? defaultValue : v;
    },
    update: (key, value) => {
      store.set(key, value);
      return Promise.resolve();
    },
    setKeysForSync: () => {},
  };
}

function serializeCompletionItem(item) {
  return {
    label: typeof item.label === 'string' ? item.label : item.label?.label || '',
    kind: item.kind,
    detail: item.detail,
    insertText: typeof item.insertText === 'string' ? item.insertText : item.insertText?.value,
    documentation: typeof item.documentation === 'string' ? item.documentation : item.documentation?.value,
    sortText: item.sortText,
    filterText: item.filterText,
  };
}
function serializeHover(h) {
  if (!h) return null;
  const contents = Array.isArray(h.contents) ? h.contents : [h.contents];
  return { contents: contents.map((c) => (typeof c === 'string' ? c : (c && c.value) || '')), range: h.range };
}
function serializeLocation(loc) {
  if (!loc) return null;
  return { uri: loc.uri?.toString?.() || '', range: loc.range };
}
function serializeDocumentSymbol(s) {
  return {
    name: s.name,
    kind: s.kind,
    detail: s.detail || '',
    range: s.range,
    selectionRange: s.selectionRange || s.range,
    children: (s.children || []).map(serializeDocumentSymbol),
  };
}
function serializeSelectionRange(sr) {
  if (!sr) return null;
  return { range: sr.range, parent: sr.parent ? serializeSelectionRange(sr.parent) : undefined };
}


class VscPosition {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
  isEqual(o) {
    return this.line === o.line && this.character === o.character;
  }
  isBefore(o) {
    return this.line < o.line || (this.line === o.line && this.character < o.character);
  }
  isBeforeOrEqual(o) {
    return this.isBefore(o) || this.isEqual(o);
  }
  isAfter(o) {
    return !this.isEqual(o) && !this.isBefore(o);
  }
  isAfterOrEqual(o) {
    return this.isAfter(o) || this.isEqual(o);
  }
  translate(lineDelta, charDelta) {
    return new VscPosition(this.line + (lineDelta || 0), this.character + (charDelta || 0));
  }
  with(line, character) {
    return new VscPosition(line ?? this.line, character ?? this.character);
  }
  compareTo(o) {
    return this.isBefore(o) ? -1 : this.isAfter(o) ? 1 : 0;
  }
}

class VscRange {
  constructor(startLine, startChar, endLine, endChar) {
    if (startLine instanceof VscPosition) {
      this.start = startLine;
      this.end = startChar;
    } else {
      this.start = new VscPosition(startLine, startChar);
      this.end = new VscPosition(endLine, endChar);
    }
  }
  get isEmpty() {
    return this.start.isEqual(this.end);
  }
  get isSingleLine() {
    return this.start.line === this.end.line;
  }
  contains(posOrRange) {
    if (
      posOrRange instanceof VscPosition ||
      (posOrRange && posOrRange.line !== undefined && posOrRange.character !== undefined && !posOrRange.start)
    ) {
      const p = posOrRange;
      return (
        (p.line > this.start.line || (p.line === this.start.line && p.character >= this.start.character)) &&
        (p.line < this.end.line || (p.line === this.end.line && p.character <= this.end.character))
      );
    }
    const r = posOrRange;
    return this.contains(r.start) && this.contains(r.end);
  }
  isEqual(o) {
    return this.start.isEqual(o.start) && this.end.isEqual(o.end);
  }
  intersection(o) {
    const s = this.start.isAfter(o.start) ? this.start : o.start;
    const e = this.end.isBefore(o.end) ? this.end : o.end;
    if (s.isAfter(e)) return undefined;
    return new VscRange(s, e);
  }
  union(o) {
    const s = this.start.isBefore(o.start) ? this.start : o.start;
    const e = this.end.isAfter(o.end) ? this.end : o.end;
    return new VscRange(s, e);
  }
  with(start, end) {
    return new VscRange(start || this.start, end || this.end);
  }
}

class VscSelection extends VscRange {
  constructor(anchorLine, anchorChar, activeLine, activeChar) {
    if (anchorLine instanceof VscPosition) {
      super(anchorLine, anchorChar);
      this.anchor = anchorLine;
      this.active = anchorChar;
    } else {
      super(anchorLine, anchorChar, activeLine, activeChar);
      this.anchor = this.start;
      this.active = this.end;
    }
  }
  get isReversed() {
    return this.anchor.isAfter(this.active);
  }
}

class VscUri {
  constructor(scheme, authority, p, query, fragment) {
    this.scheme = scheme || 'file';
    this.authority = authority || '';
    this.path = p || '';
    this.query = query || '';
    this.fragment = fragment || '';
    if (this.scheme === 'file') {
      this.fsPath = _isWin && /^\/[A-Za-z]:/.test(this.path)
        ? this.path.slice(1).replace(/\//g, '\\')
        : this.path;
    } else {
      this.fsPath = '';
    }
  }
  static file(p) {
    let uriPath = p;
    if (_isWin && p) {
      uriPath = p.replace(/\\/g, '/');
      if (/^[A-Za-z]:/.test(uriPath)) {
        uriPath = '/' + uriPath;
      }
    }
    return new VscUri('file', '', uriPath);
  }
  static parse(s) {
    try {
      const u = new URL(s);
      return new VscUri(u.protocol.replace(':', ''), u.host, u.pathname, u.search.slice(1), u.hash.slice(1));
    } catch {
      return VscUri.file(s);
    }
  }
  static from(components) {
    return new VscUri(components.scheme, components.authority, components.path, components.query, components.fragment);
  }
  static joinPath(base, ...segments) {
    return new VscUri(base.scheme, base.authority, path.posix.join(base.path, ...segments));
  }
  static isUri(thing) {
    return thing instanceof VscUri || (thing && typeof thing.scheme === 'string' && typeof thing.path === 'string');
  }
  toString() {
    let result = `${this.scheme}://${this.authority}${this.path}`;
    if (this.query) { result += `?${this.query}`; }
    if (this.fragment) { result += `#${this.fragment}`; }
    return result;
  }
  toJSON() {
    return {
      scheme: this.scheme,
      authority: this.authority,
      path: this.path,
      query: this.query,
      fragment: this.fragment,
      fsPath: this.fsPath,
    };
  }
  with(change) {
    return new VscUri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }
}


let hostInstance = null;

function createVscodeShim() {
  const host = hostInstance;

  const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
  const CompletionItemKind = {
    Text: 0,
    Method: 1,
    Function: 2,
    Constructor: 3,
    Field: 4,
    Variable: 5,
    Class: 6,
    Interface: 7,
    Module: 8,
    Property: 9,
    Unit: 10,
    Value: 11,
    Enum: 12,
    Keyword: 13,
    Snippet: 14,
    Color: 15,
    File: 16,
    Reference: 17,
    Folder: 18,
    EnumMember: 19,
    Constant: 20,
    Struct: 21,
    Event: 22,
    Operator: 23,
    TypeParameter: 24,
  };
  const CompletionTriggerKind = { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 };
  const SymbolKind = {
    File: 0,
    Module: 1,
    Namespace: 2,
    Package: 3,
    Class: 4,
    Method: 5,
    Property: 6,
    Field: 7,
    Constructor: 8,
    Enum: 9,
    Interface: 10,
    Function: 11,
    Variable: 12,
    Constant: 13,
    String: 14,
    Number: 15,
    Boolean: 16,
    Array: 17,
    Object: 18,
    Key: 19,
    Null: 20,
    EnumMember: 21,
    Struct: 22,
    Event: 23,
    Operator: 24,
    TypeParameter: 25,
  };
  const DocumentHighlightKind = { Text: 0, Read: 1, Write: 2 };
  class VscCodeActionKind {
    constructor(value) {
      this.value = value || '';
    }
    append(part) {
      if (!part) return new VscCodeActionKind(this.value);
      return new VscCodeActionKind(this.value ? `${this.value}.${part}` : part);
    }
    contains(other) {
      const o = typeof other === 'string' ? other : other?.value;
      if (!o) return false;
      return this.value === o || o.startsWith(this.value + '.');
    }
    intersects(other) {
      const o = typeof other === 'string' ? other : other?.value;
      if (!o) return false;
      return this.contains(o) || o === this.value || this.value.startsWith(o + '.');
    }
    toString() {
      return this.value;
    }
  }
  const codeActionKinds = {
    Empty: new VscCodeActionKind(''),
    QuickFix: new VscCodeActionKind('quickfix'),
    Refactor: new VscCodeActionKind('refactor'),
    RefactorExtract: new VscCodeActionKind('refactor.extract'),
    RefactorInline: new VscCodeActionKind('refactor.inline'),
    RefactorRewrite: new VscCodeActionKind('refactor.rewrite'),
    Source: new VscCodeActionKind('source'),
    SourceOrganizeImports: new VscCodeActionKind('source.organizeImports'),
    SourceFixAll: new VscCodeActionKind('source.fixAll'),
  };
  function codeActionKindFromProperty(prop) {
    if (typeof prop !== 'string' || !prop) return '';
    if (prop === 'Empty') return '';
    const withDots = prop
      .replace(/([a-z0-9])([A-Z])/g, '$1.$2')
      .replace(/^([A-Z])/, (m) => m.toLowerCase())
      .replace(/\./g, '.');
    return withDots
      .toLowerCase()
      .replace(/fix\.all/g, 'fixAll')
      .replace(/organize\.imports/g, 'organizeImports');
  }
  const CodeActionKind = new Proxy(codeActionKinds, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      const value = codeActionKindFromProperty(prop);
      const kind = new VscCodeActionKind(value);
      if (typeof prop === 'string') {
        target[prop] = kind;
      }
      return kind;
    },
  });
  const IndentAction = { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 };
  const FoldingRangeKind = { Comment: 1, Imports: 2, Region: 3 };
  const SignatureHelpTriggerKind = { Invoke: 1, TriggerCharacter: 2, ContentChange: 3 };
  const InlayHintKind = { Type: 1, Parameter: 2 };
  const TextDocumentSaveReason = { Manual: 1, AfterDelay: 2, FocusOut: 3 };
  const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
  const TextEditorCursorStyle = { Line: 1, Block: 2, Underline: 3, LineThin: 4, BlockOutline: 5, UnderlineThin: 6 };
  const TextEditorLineNumbersStyle = { Off: 0, On: 1, Relative: 2 };
  const DecorationRangeBehavior = { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 };
  const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
  const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
  const ExtensionKind = { UI: 1, Workspace: 2 };
  const DiagnosticTag = { Unnecessary: 1, Deprecated: 2 };
  const CompletionItemTag = { Deprecated: 1 };

  class TextEdit {
    constructor(range, newText) {
      this.range = range;
      this.newText = newText;
    }
    static replace(range, newText) {
      return new TextEdit(range, newText);
    }
    static insert(position, newText) {
      return new TextEdit(new VscRange(position, position), newText);
    }
    static delete(range) {
      return new TextEdit(range, '');
    }
    static setEndOfLine() {
      return new TextEdit(new VscRange(0, 0, 0, 0), '');
    }
  }

  class WorkspaceEdit {
    constructor() {
      this._edits = [];
    }
    replace(uri, range, newText) {
      this._edits.push({ uri, range, newText });
    }
    insert(uri, position, newText) {
      this._edits.push({ uri, range: new VscRange(position, position), newText });
    }
    delete(uri, range) {
      this._edits.push({ uri, range, newText: '' });
    }
    has(uri) {
      return this._edits.some((e) => e.uri?.toString() === uri?.toString());
    }
    set(uri, edits) {
      this._edits = this._edits.filter((e) => e.uri?.toString() !== uri?.toString());
      edits.forEach((e) => this._edits.push({ uri, ...e }));
    }
    get size() {
      return this._edits.length;
    }
    entries() {
      const map = new Map();
      for (const e of this._edits) {
        const key = e.uri?.toString() || '';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(new TextEdit(e.range, e.newText));
      }
      return [...map.entries()].map(([k, v]) => [VscUri.parse(k), v]);
    }
    renameFile(oldUri, newUri, options) {
      this._edits.push({ _type: 'rename', oldUri, newUri, options });
    }
    createFile(uri, options) {
      this._edits.push({ _type: 'create', uri, options });
    }
    deleteFile(uri, options) {
      this._edits.push({ _type: 'delete', uri, options });
    }
  }

  class Hover {
    constructor(contents, range) {
      this.contents = Array.isArray(contents) ? contents : [contents];
      this.range = range;
    }
  }
  class Location {
    constructor(uri, rangeOrPos) {
      this.uri = uri;
      this.range = rangeOrPos;
    }
  }
  class Diagnostic {
    constructor(range, message, severity) {
      this.range = range;
      this.message = message;
      this.severity = severity ?? DiagnosticSeverity.Error;
      this.source = '';
      this.code = '';
      this.relatedInformation = [];
      this.tags = [];
    }
  }
  class DiagnosticRelatedInformation {
    constructor(location, message) {
      this.location = location;
      this.message = message;
    }
  }
  class CompletionItem {
    constructor(label, kind) {
      this.label = label;
      this.kind = kind;
    }
  }
  class CompletionList {
    constructor(items, isIncomplete) {
      this.items = items || [];
      this.isIncomplete = !!isIncomplete;
    }
  }
  class CancellationError extends Error {
    constructor() {
      super('Canceled');
      this.name = 'Canceled';
    }
  }
  class FileSystemError extends Error {
    constructor(message) {
      super(message || 'File system error');
      this.name = 'FileSystemError';
    }
    static FileNotFound(message) {
      const e = new FileSystemError(message || 'File not found');
      e.name = 'FileNotFound';
      return e;
    }
    static FileExists(message) {
      const e = new FileSystemError(message || 'File exists');
      e.name = 'FileExists';
      return e;
    }
    static FileNotADirectory(message) {
      const e = new FileSystemError(message || 'File not a directory');
      e.name = 'FileNotADirectory';
      return e;
    }
    static FileIsADirectory(message) {
      const e = new FileSystemError(message || 'File is a directory');
      e.name = 'FileIsADirectory';
      return e;
    }
    static NoPermissions(message) {
      const e = new FileSystemError(message || 'No permissions');
      e.name = 'NoPermissions';
      return e;
    }
    static Unavailable(message) {
      const e = new FileSystemError(message || 'Unavailable');
      e.name = 'Unavailable';
      return e;
    }
  }
  class CodeAction {
    constructor(title, kind) {
      this.title = title;
      this.kind = kind;
      this.diagnostics = [];
      this.isPreferred = false;
    }
  }
  class CodeLens {
    constructor(range, command) {
      this.range = range;
      this.command = command;
      this.isResolved = !!command;
    }
  }
  class DocumentSymbol {
    constructor(name, detail, kind, range, selectionRange) {
      this.name = name;
      this.detail = detail;
      this.kind = kind;
      this.range = range;
      this.selectionRange = selectionRange;
      this.children = [];
    }
  }
  class SymbolInformation {
    constructor(name, kind, range, uri) {
      this.name = name;
      this.kind = kind;
      this.location = new Location(uri, range);
    }
  }
  class FoldingRange {
    constructor(start, end, kind) {
      this.start = start;
      this.end = end;
      this.kind = kind;
    }
  }
  class SelectionRange {
    constructor(range, parent) {
      this.range = range;
      this.parent = parent;
    }
  }
  class CallHierarchyItem {
    constructor(kind, name, detail, uri, range, selectionRange) {
      this.kind = kind;
      this.name = name;
      this.detail = detail;
      this.uri = uri;
      this.range = range;
      this.selectionRange = selectionRange;
    }
  }
  class TypeHierarchyItem {
    constructor(kind, name, detail, uri, range, selectionRange) {
      this.kind = kind;
      this.name = name;
      this.detail = detail;
      this.uri = uri;
      this.range = range;
      this.selectionRange = selectionRange;
    }
  }
  class DocumentLink {
    constructor(range, target) {
      this.range = range;
      this.target = target;
    }
  }
  class Color {
    constructor(red, green, blue, alpha) {
      this.red = red;
      this.green = green;
      this.blue = blue;
      this.alpha = alpha;
    }
  }
  class ColorInformation {
    constructor(range, color) {
      this.range = range;
      this.color = color;
    }
  }
  class ColorPresentation {
    constructor(label) {
      this.label = label;
    }
  }
  class InlayHint {
    constructor(position, label, kind) {
      this.position = position;
      this.label = label;
      this.kind = kind;
    }
  }
  class SnippetString {
    constructor(value) {
      this.value = value || '';
    }
    appendText(s) {
      this.value += s;
      return this;
    }
    appendPlaceholder(fn, num) {
      this.value += `\${${num || 1}:}`;
      return this;
    }
    appendTabstop(num) {
      this.value += `\$${num || 0}`;
      return this;
    }
  }
  class MarkdownString {
    constructor(value, supportThemeIcons) {
      this.value = value || '';
      this.isTrusted = false;
      this.supportThemeIcons = !!supportThemeIcons;
      this.supportHtml = false;
    }
    appendText(v) {
      this.value += v;
      return this;
    }
    appendMarkdown(v) {
      this.value += v;
      return this;
    }
    appendCodeblock(code, lang) {
      this.value += `\n\`\`\`${lang || ''}\n${code}\n\`\`\`\n`;
      return this;
    }
  }
  class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  }
  class ThemeIcon {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
    static get File() {
      return new ThemeIcon('file');
    }
    static get Folder() {
      return new ThemeIcon('folder');
    }
  }
  class TreeItem {
    constructor(labelOrUri, collapsibleState) {
      if (typeof labelOrUri === 'string') {
        this.label = labelOrUri;
      } else {
        this.resourceUri = labelOrUri;
      }
      this.collapsibleState = collapsibleState || TreeItemCollapsibleState.None;
    }
  }
  class SemanticTokensLegend {
    constructor(tokenTypes, tokenModifiers) {
      this.tokenTypes = tokenTypes;
      this.tokenModifiers = tokenModifiers || [];
    }
  }
  class SemanticTokensBuilder {
    constructor(legend) {
      this._legend = legend;
      this._data = [];
    }
    push(line, char, length, tokenType, tokenModifiers) {
      this._data.push(line, char, length, tokenType, tokenModifiers || 0);
    }
    build() {
      return { data: new Uint32Array(this._data) };
    }
  }
  class SemanticTokens {
    constructor(data, resultId) {
      this.data = data;
      this.resultId = resultId;
    }
  }
  class SignatureHelp {
    constructor() {
      this.signatures = [];
      this.activeSignature = 0;
      this.activeParameter = 0;
    }
  }
  class SignatureInformation {
    constructor(label, documentation) {
      this.label = label;
      this.documentation = documentation;
      this.parameters = [];
    }
  }
  class ParameterInformation {
    constructor(label, documentation) {
      this.label = label;
      this.documentation = documentation;
    }
  }
  class DocumentHighlight {
    constructor(range, kind) {
      this.range = range;
      this.kind = kind || DocumentHighlightKind.Text;
    }
  }

  class VscEventEmitter {
    constructor() {
      this._listeners = [];
    }
    get event() {
      const self = this;
      return (listener, thisArg, disposables) => {
        const bound = thisArg ? listener.bind(thisArg) : listener;
        self._listeners.push(bound);
        const d = {
          dispose() {
            const i = self._listeners.indexOf(bound);
            if (i >= 0) self._listeners.splice(i, 1);
          },
        };
        if (disposables) disposables.push(d);
        return d;
      };
    }
    fire(data) {
      for (const fn of this._listeners.slice()) {
        try {
          fn(data);
        } catch (e) {
          log(`event error: ${e.message}`);
        }
      }
    }
    dispose() {
      this._listeners.length = 0;
    }
  }

  host._onDocumentEvent = new VscEventEmitter();
  host._onDocumentChangeEvent = new VscEventEmitter();
  host._onDocumentCloseEvent = new VscEventEmitter();
  host._onDocumentSaveEvent = new VscEventEmitter();
  host._onConfigChangeEvent = new VscEventEmitter();
  host._onDiagnosticsChangeEvent = new VscEventEmitter();
  host._onActiveEditorChangeEvent = new VscEventEmitter();
  host._onVisibleEditorsChangeEvent = new VscEventEmitter();
  host._onSelectionChangeEvent = new VscEventEmitter();
  host._onOptionsChangeEvent = new VscEventEmitter();
  host._onVisibleRangesChangeEvent = new VscEventEmitter();

  const diagnosticCollections = new Map();

  class DiagnosticCollection {
    constructor(name) {
      this.name = name;
      this._entries = new Map();
    }
    set(uri, diagnostics) {
      const key = typeof uri === 'string' ? uri : uri.toString();
      this._entries.set(key, diagnostics || []);
      host._diagnostics.set(
        key,
        (diagnostics || []).map((d) => ({
          range: d.range,
          message: d.message,
          severity: d.severity,
          source: d.source,
          code: d.code,
        })),
      );
      host.emit('event', { type: 'diagnosticsChanged', uri: key, diagnostics: host._diagnostics.get(key) });
      host._onDiagnosticsChangeEvent.fire({ uris: [VscUri.parse(key)] });
    }
    delete(uri) {
      const key = typeof uri === 'string' ? uri : uri.toString();
      this._entries.delete(key);
      host._diagnostics.delete(key);
      host.emit('event', { type: 'diagnosticsChanged', uri: key, diagnostics: [] });
      host._onDiagnosticsChangeEvent.fire({ uris: [VscUri.parse(key)] });
    }
    clear() {
      const uris = [];
      for (const key of this._entries.keys()) {
        host._diagnostics.delete(key);
        uris.push(VscUri.parse(key));
      }
      this._entries.clear();
      host.emit('event', { type: 'diagnosticsChanged' });
      if (uris.length) host._onDiagnosticsChangeEvent.fire({ uris });
    }
    get(uri) {
      const key = typeof uri === 'string' ? uri : uri.toString();
      return this._entries.get(key);
    }
    has(uri) {
      const key = typeof uri === 'string' ? uri : uri.toString();
      return this._entries.has(key);
    }
    forEach(cb) {
      this._entries.forEach((v, k) => cb(VscUri.parse(k), v, this));
    }
    dispose() {
      this.clear();
      diagnosticCollections.delete(this.name);
    }
    get size() {
      return this._entries.size;
    }
    [Symbol.iterator]() {
      return this._entries[Symbol.iterator]();
    }
  }

  function registerProvider(kind, selector, provider) {
    const entry = { selector, provider };
    host._providers[kind].push(entry);
    return {
      dispose() {
        const i = host._providers[kind].indexOf(entry);
        if (i >= 0) host._providers[kind].splice(i, 1);
      },
    };
  }

  const languagesBase = {
    createDiagnosticCollection(name) {
      const col = new DiagnosticCollection(name || `diag-${Date.now()}`);
      diagnosticCollections.set(col.name, col);
      return col;
    },
    registerCompletionItemProvider(selector, provider, ...triggerChars) {
      return registerProvider('completion', selector, provider);
    },
    registerHoverProvider(selector, provider) {
      return registerProvider('hover', selector, provider);
    },
    registerDefinitionProvider(selector, provider) {
      return registerProvider('definition', selector, provider);
    },
    registerTypeDefinitionProvider(selector, provider) {
      return registerProvider('typeDefinition', selector, provider);
    },
    registerImplementationProvider(selector, provider) {
      return registerProvider('implementation', selector, provider);
    },
    registerDeclarationProvider(selector, provider) {
      return registerProvider('declaration', selector, provider);
    },
    registerReferenceProvider(selector, provider) {
      return registerProvider('references', selector, provider);
    },
    registerDocumentSymbolProvider(selector, provider) {
      return registerProvider('documentSymbol', selector, provider);
    },
    registerWorkspaceSymbolProvider(provider) {
      return registerProvider('workspaceSymbol', null, provider);
    },
    registerCodeActionsProvider(selector, provider) {
      return registerProvider('codeAction', selector, provider);
    },
    registerCodeLensProvider(selector, provider) {
      return registerProvider('codeLens', selector, provider);
    },
    registerDocumentFormattingEditProvider(selector, provider) {
      return registerProvider('formatting', selector, provider);
    },
    registerDocumentRangeFormattingEditProvider(selector, provider) {
      return registerProvider('rangeFormatting', selector, provider);
    },
    registerOnTypeFormattingEditProvider(selector, provider, firstChar, ...moreChars) {
      return registerProvider('onTypeFormatting', selector, provider);
    },
    registerSignatureHelpProvider(selector, provider, ...triggerCharsOrMeta) {
      return registerProvider('signatureHelp', selector, provider);
    },
    registerDocumentHighlightProvider(selector, provider) {
      return registerProvider('documentHighlight', selector, provider);
    },
    registerMultiDocumentHighlightProvider(selector, provider) {
      return registerProvider('documentHighlight', selector, provider);
    },
    registerRenameProvider(selector, provider) {
      return registerProvider('rename', selector, provider);
    },
    registerDocumentLinkProvider(selector, provider) {
      return registerProvider('documentLink', selector, provider);
    },
    registerColorProvider(selector, provider) {
      return registerProvider('color', selector, provider);
    },
    registerFoldingRangeProvider(selector, provider) {
      return registerProvider('foldingRange', selector, provider);
    },
    registerSelectionRangeProvider(selector, provider) {
      return registerProvider('selectionRange', selector, provider);
    },
    registerLinkedEditingRangeProvider(selector, provider) {
      return noopDisposable;
    },
    registerDocumentSemanticTokensProvider(selector, provider, legend) {
      return registerProvider('semanticTokens', selector, provider);
    },
    registerDocumentRangeSemanticTokensProvider(selector, provider, legend) {
      return noopDisposable;
    },
    registerInlayHintsProvider(selector, provider) {
      return registerProvider('inlayHint', selector, provider);
    },
    registerCallHierarchyProvider(selector, provider) {
      return noopDisposable;
    },
    registerTypeHierarchyProvider(selector, provider) {
      return noopDisposable;
    },
    registerInlineCompletionItemProvider(selector, provider) {
      return noopDisposable;
    },
    registerEvaluatableExpressionProvider(selector, provider) {
      return noopDisposable;
    },
    registerInlineValuesProvider(selector, provider) {
      return noopDisposable;
    },
    registerDocumentDropEditProvider(selector, provider) {
      return noopDisposable;
    },
    registerDocumentPasteEditProvider(selector, provider, metadata) {
      return noopDisposable;
    },
    setLanguageConfiguration(language, config) {
      host._languageConfigurations.set(language, config);
      host.emit('event', {
        type: 'languageConfigurationChanged',
        language,
        configuration: {
          comments: config.comments
            ? {
                lineComment: config.comments.lineComment,
                blockComment: config.comments.blockComment,
              }
            : undefined,
          brackets: config.brackets,
          autoClosingPairs: config.autoClosingPairs?.map((p) => (Array.isArray(p) ? { open: p[0], close: p[1] } : p)),
          surroundingPairs: config.surroundingPairs?.map((p) => (Array.isArray(p) ? { open: p[0], close: p[1] } : p)),
          wordPattern: config.wordPattern?.source,
          indentationRules: config.indentationRules
            ? {
                increaseIndentPattern: config.indentationRules.increaseIndentPattern?.source,
                decreaseIndentPattern: config.indentationRules.decreaseIndentPattern?.source,
              }
            : undefined,
          onEnterRules: config.onEnterRules?.map((r) => ({
            beforeText: r.beforeText?.source,
            afterText: r.afterText?.source,
            action: r.action,
          })),
        },
      });
      return {
        dispose() {
          host._languageConfigurations.delete(language);
        },
      };
    },
    getLanguages() {
      return Promise.resolve([]);
    },
    getDiagnostics(uri) {
      if (uri) return host._diagnostics.get(uri?.toString()) || [];
      const all = [];
      for (const [u, diags] of host._diagnostics) all.push([VscUri.parse(u), diags]);
      return all;
    },
    onDidChangeDiagnostics: (listener, thisArg, disposables) =>
      host._onDiagnosticsChangeEvent.event(listener, thisArg, disposables),
    match(selector, document) {
      if (!selector || !document) return 0;
      const sels =
        typeof selector === 'string' ? [{ language: selector }] : Array.isArray(selector) ? selector : [selector];
      let best = 0;
      const docScheme = document.uri?.scheme || 'file';
      for (const s of sels) {
        const sl = typeof s === 'string' ? { language: s } : s;
        if (sl.notebookType) continue;
        let score = 0;
        if (sl.language && (sl.language === document.languageId || sl.language === '*')) score += 10;
        if (sl.scheme) {
          if (sl.scheme === docScheme || sl.scheme === '*') score += 10;
          else continue;
        }
        if (sl.pattern) score += 5;
        if (score > best) best = score;
      }
      return best;
    },
    createLanguageStatusItem() {
      return { id: '', severity: 0, name: '', text: '', detail: '', dispose() {} };
    },
  };
  const languages = new Proxy(languagesBase, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      if (typeof prop === 'string' && prop.startsWith('register')) {
        return () => {
          log(`shim fallback for languages.${prop}`);
          return noopDisposable;
        };
      }
      return undefined;
    },
  });

  const commands = {
    registerCommand(id, handler, thisArg) {
      host._commands.set(id, thisArg ? handler.bind(thisArg) : handler);
      host.emit('event', { type: 'commandRegistered', commandId: id });
      return {
        dispose() {
          host._commands.delete(id);
        },
      };
    },
    registerTextEditorCommand(id, handler) {
      host._commands.set(id, handler);
      return {
        dispose() {
          host._commands.delete(id);
        },
      };
    },
    async executeCommand(id, ...args) {
      let fn = host._commands.get(id);
      if (!fn) {
        host._checkActivationEvents(`onCommand:${id}`);
        await new Promise((r) => setTimeout(r, 100));
        fn = host._commands.get(id);
      }
      if (fn) return fn(...args);
      return new Promise((resolve, reject) => {
        const reqId = ++host._reqId;
        host.emit('event', { type: 'executeWorkbenchCommand', reqId, command: id, args });
        const timeout = setTimeout(() => reject(new Error(`command timed out: ${id}`)), 10000);
        const handler = (event) => {
          if (event && event.type === 'workbenchCommandResult' && event.reqId === reqId) {
            clearTimeout(timeout);
            host.removeListener('inbound', handler);
            if (event.error) reject(new Error(event.error));
            else resolve(event.result);
          }
        };
        host.on('inbound', handler);
      });
    },
    getCommands(filterInternal) {
      return Promise.resolve([...host._commands.keys()]);
    },
  };

  const workspace = {
    get workspaceFolders() {
      return host._workspaceFolders.map((f, i) => ({ uri: VscUri.file(f), name: path.basename(f), index: i }));
    },
    get rootPath() {
      return host._workspaceFolders[0];
    },
    get name() {
      return host._workspaceFolders[0] ? path.basename(host._workspaceFolders[0]) : undefined;
    },
    get workspaceFile() {
      return undefined;
    },
    get textDocuments() {
      return [...host._textDocuments.values()].map((d) => host._makeDocumentProxy(d.uri));
    },
    get notebookDocuments() {
      return [];
    },
    getWorkspaceFolder(uri) {
      const uriStr = typeof uri === 'string' ? uri : uri.fsPath || uri.path || uri.toString();
      for (let i = 0; i < host._workspaceFolders.length; i++) {
        const f = host._workspaceFolders[i];
        if (uriStr.startsWith(f)) {
          return { uri: VscUri.file(f), name: path.basename(f), index: i };
        }
      }
      return undefined;
    },
    asRelativePath(pathOrUri, includeWorkspaceFolder) {
      const p = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath || pathOrUri.path || pathOrUri.toString();
      for (const folder of host._workspaceFolders) {
        if (p.startsWith(folder)) {
          const rel = p.substring(folder.length);
          return rel.startsWith('/') ? rel.substring(1) : rel;
        }
      }
      return p;
    },
    getConfiguration(section, scope) {
      const getVal = (key) => {
        if (key === undefined || key === null || key === '') {
          if (!section) {
            const all = Object.create(null);
            for (const [cfgKey, cfgValue] of host._configuration.entries()) {
              all[cfgKey] = cfgValue;
            }
            return all;
          }
          if (host._configuration.has(section)) {
            const sectionVal = host._configuration.get(section);
            if (sectionVal && typeof sectionVal === 'object') {
              return sectionVal;
            }
          }
          const sectionPrefix = `${section}.`;
          const sectionObj = Object.create(null);
          for (const [cfgKey, cfgValue] of host._configuration.entries()) {
            if (cfgKey.startsWith(sectionPrefix)) {
              sectionObj[cfgKey.slice(sectionPrefix.length)] = cfgValue;
            }
          }
          return sectionObj;
        }
        const full = section ? `${section}.${key}` : key;
        if (host._configuration.has(full)) return host._configuration.get(full);
        if (section && host._configuration.has(section)) {
          const sectionVal = host._configuration.get(section);
          if (sectionVal && typeof sectionVal === 'object' && key in sectionVal) return sectionVal[key];
        }
        return undefined;
      };
      const proxy = {
        get(key, defaultValue) {
          const v = getVal(key);
          return v !== undefined ? v : defaultValue;
        },
        has(key) {
          return getVal(key) !== undefined;
        },
        update(key, value, target, overrideInLanguage) {
          const full = section ? `${section}.${key}` : key;
          host._configuration.set(full, value);
          host._onConfigChangeEvent?.fire({ affectsConfiguration: (s) => full === s || full.startsWith(s + '.') });
          return Promise.resolve();
        },
        inspect(key) {
          if (key === undefined || key === null || key === '') {
            const sectionValue = getVal(undefined);
            return {
              key: section || '',
              defaultValue: undefined,
              globalValue: sectionValue,
              workspaceValue: sectionValue,
              workspaceFolderValue: undefined,
            };
          }
          const full = section ? `${section}.${key}` : key;
          const v = host._configuration.get(full);
          return {
            key: full,
            defaultValue: undefined,
            globalValue: v,
            workspaceValue: v,
            workspaceFolderValue: undefined,
          };
        },
        toJSON() {
          return getVal(undefined) ?? {};
        },
      };
      return new Proxy(proxy, {
        get(target, prop) {
          if (prop in target) return target[prop];
          if (typeof prop === 'string') return getVal(prop);
          return undefined;
        },
      });
    },
    onDidChangeConfiguration: (listener, thisArg, disposables) =>
      host._onConfigChangeEvent.event(listener, thisArg, disposables),
    onDidOpenTextDocument: (listener, thisArg, disposables) =>
      host._onDocumentEvent.event(listener, thisArg, disposables),
    onDidCloseTextDocument: (listener, thisArg, disposables) =>
      host._onDocumentCloseEvent.event(listener, thisArg, disposables),
    onDidChangeTextDocument: (listener, thisArg, disposables) =>
      host._onDocumentChangeEvent.event(listener, thisArg, disposables),
    onDidOpenNotebookDocument: noopEvent,
    onDidCloseNotebookDocument: noopEvent,
    onDidChangeNotebookDocument: noopEvent,
    onDidSaveNotebookDocument: noopEvent,
    onDidSaveTextDocument: (listener, thisArg, disposables) =>
      host._onDocumentSaveEvent.event(listener, thisArg, disposables),
    onWillSaveTextDocument: noopEvent,
    onDidChangeWorkspaceFolders: noopEvent,
    onDidCreateFiles: noopEvent,
    onDidDeleteFiles: noopEvent,
    onDidRenameFiles: noopEvent,
    onWillCreateFiles: noopEvent,
    onWillDeleteFiles: noopEvent,
    onWillRenameFiles: noopEvent,
    registerPortAttributesProvider: () => noopDisposable,
    createFileSystemWatcher: (globPattern, ignoreCreateEvents, ignoreChangeEvents, ignoreDeleteEvents) => {
      const id = host._nextWatcherId++;
      const pattern = typeof globPattern === 'string' ? globPattern : globPattern?.pattern || '**/*';
      const base =
        typeof globPattern === 'object' && globPattern?.baseUri
          ? globPattern.baseUri.fsPath || globPattern.base || ''
          : '';
      const onCreate = new VscEventEmitter();
      const onChange = new VscEventEmitter();
      const onDelete = new VscEventEmitter();
      host._fileWatchers.set(id, { pattern, base, onCreate, onChange, onDelete });
      const watchPaths = (host._workspaceFolders.length > 0 ? host._workspaceFolders : [base || process.cwd()]).filter(
        Boolean,
      );
      host.emit('event', {
        type: 'startFileWatch',
        watcherId: id,
        paths: watchPaths,
        pattern,
        recursive: pattern.includes('**'),
      });
      return {
        onDidCreate: ignoreCreateEvents ? noopEvent : onCreate.event,
        onDidChange: ignoreChangeEvents ? noopEvent : onChange.event,
        onDidDelete: ignoreDeleteEvents ? noopEvent : onDelete.event,
        dispose() {
          host._fileWatchers.delete(id);
          onCreate.dispose();
          onChange.dispose();
          onDelete.dispose();
          host.emit('event', { type: 'stopFileWatch', watcherId: id });
        },
      };
    },
    fs: {
      readFile: (uri) => fs.promises.readFile(uri.fsPath || uri.path),
      writeFile: (uri, content) => fs.promises.writeFile(uri.fsPath || uri.path, content),
      stat: (uri) =>
        fs.promises
          .stat(uri.fsPath || uri.path)
          .then((s) => ({ type: s.isDirectory() ? 2 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size })),
      readDirectory: (uri) =>
        fs.promises
          .readdir(uri.fsPath || uri.path, { withFileTypes: true })
          .then((entries) => entries.map((e) => [e.name, e.isDirectory() ? 2 : 1])),
      createDirectory: (uri) => fs.promises.mkdir(uri.fsPath || uri.path, { recursive: true }),
      delete: (uri) => fs.promises.rm(uri.fsPath || uri.path, { recursive: true, force: true }),
      rename: (oldUri, newUri) => fs.promises.rename(oldUri.fsPath, newUri.fsPath),
      copy: (src, dest) => fs.promises.copyFile(src.fsPath, dest.fsPath),
      isWritableFileSystem: () => true,
    },
    openTextDocument(uriOrPath) {
      if (typeof uriOrPath === 'string') {
        const uri = VscUri.file(uriOrPath);
        return fs.promises
          .readFile(uriOrPath, 'utf-8')
          .then((text) => {
            host._textDocuments.set(uri.toString(), { uri: uri.toString(), languageId: 'plaintext', version: 1, text });
            return host._makeDocumentProxy(uri.toString());
          })
          .catch(() => host._makeDocumentProxy(uri.toString()));
      }
      if (uriOrPath && uriOrPath.fsPath) {
        return fs.promises
          .readFile(uriOrPath.fsPath, 'utf-8')
          .then((text) => {
            host._textDocuments.set(uriOrPath.toString(), {
              uri: uriOrPath.toString(),
              languageId: 'plaintext',
              version: 1,
              text,
            });
            return host._makeDocumentProxy(uriOrPath.toString());
          })
          .catch(() => host._makeDocumentProxy(uriOrPath.toString()));
      }
      return Promise.resolve(host._makeDocumentProxy('file:///untitled'));
    },
    findFiles: (include, exclude, maxResults, token) => {
      const glob = require('path');
      const fsNode = require('fs');
      const pattern = typeof include === 'string' ? include : include?.pattern || '**/*';
      const results = [];
      const limit = maxResults || 1000;
      function walk(dir, depth) {
        if (results.length >= limit || depth > 10) return;
        try {
          const entries = fsNode.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length >= limit) break;
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const full = glob.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, depth + 1);
            else if (entry.isFile()) {
              if (pattern === '**/*' || full.endsWith(pattern.replace('**/', '').replace('*', ''))) {
                results.push(VscUri.file(full));
              }
            }
          }
        } catch {}
      }
      for (const folder of host._workspaceFolders) walk(folder, 0);
      return Promise.resolve(results);
    },
    applyEdit: (edit) => {
      if (edit && edit._edits) {
        const edits = edit._edits
          .filter((e) => e.range && e.uri)
          .map((e) => ({ uri: e.uri?.toString(), range: e.range, newText: e.newText }));
        if (edits.length) {
          host.emit('event', { type: 'applyEdit', edits });
          for (const e of edits) {
            const doc = host._textDocuments.get(e.uri);
            if (doc && e.range && e.newText !== undefined) {
              const lines = doc.text.split('\n');
              const toOffset = (line, char) => {
                let off = 0;
                for (let i = 0; i < line && i < lines.length; i++) off += lines[i].length + 1;
                return off + Math.min(char, (lines[line] || '').length);
              };
              const start = toOffset(e.range.start.line, e.range.start.character);
              const end = toOffset(e.range.end.line, e.range.end.character);
              doc.text = doc.text.substring(0, start) + e.newText + doc.text.substring(end);
              doc.version++;
              host._onDocumentChangeEvent.fire({
                document: host._makeDocumentProxy(e.uri),
                contentChanges: [{
                  range: e.range,
                  rangeOffset: start,
                  rangeLength: end - start,
                  text: e.newText,
                }],
                reason: undefined,
              });
            }
          }
        }
      }
      return Promise.resolve(true);
    },
    saveAll: () => Promise.resolve(true),
    updateWorkspaceFolders: () => false,
    registerTextDocumentContentProvider: (scheme, provider) => {
      if (!host._textContentProviders) host._textContentProviders = new Map();
      host._textContentProviders.set(scheme, provider);
      return { dispose() { host._textContentProviders?.delete(scheme); } };
    },
    registerTaskProvider: (type, provider) => {
      return tasks.registerTaskProvider(type, provider);
    },
    registerFileSystemProvider: (scheme, provider, options) => {
      if (!host._fsProviders) host._fsProviders = new Map();
      host._fsProviders.set(scheme, provider);
      return { dispose() { host._fsProviders?.delete(scheme); } };
    },
    isTrusted: true,
    onDidGrantWorkspaceTrust: noopEvent,
    registerRemoteAuthorityResolver: (authorityPrefix, resolver) => noopDisposable,
    registerTunnelProvider: (tunnelProvider, features) => noopDisposable,
  };

  const window = {
    showInformationMessage(msg, ...rest) {
      log(`[info] ${msg}`);
      host.emit('event', { type: 'showMessage', severity: 'info', message: msg });
      const items = rest.filter((r) => typeof r === 'string' || (typeof r === 'object' && r !== null));
      if (items.length) {
        return new Promise((resolve) => {
          const reqId = ++host._reqId;
          host._pendingRequests.set(reqId, resolve);
          host.emit('event', {
            type: 'showMessageRequest',
            id: reqId,
            severity: 'info',
            message: msg,
            items: items.map((i) => (typeof i === 'string' ? i : i.title)),
          });
          setTimeout(() => {
            if (host._pendingRequests.has(reqId)) {
              host._pendingRequests.delete(reqId);
              resolve(undefined);
            }
          }, 30000);
        });
      }
      return Promise.resolve(undefined);
    },
    showWarningMessage(msg, ...rest) {
      log(`[warn] ${msg}`);
      host.emit('event', { type: 'showMessage', severity: 'warning', message: msg });
      const items = rest.filter((r) => typeof r === 'string' || (typeof r === 'object' && r !== null));
      if (items.length) {
        return new Promise((resolve) => {
          const reqId = ++host._reqId;
          host._pendingRequests.set(reqId, resolve);
          host.emit('event', {
            type: 'showMessageRequest',
            id: reqId,
            severity: 'warning',
            message: msg,
            items: items.map((i) => (typeof i === 'string' ? i : i.title)),
          });
          setTimeout(() => {
            if (host._pendingRequests.has(reqId)) {
              host._pendingRequests.delete(reqId);
              resolve(undefined);
            }
          }, 30000);
        });
      }
      return Promise.resolve(undefined);
    },
    showErrorMessage(msg, ...rest) {
      log(`[error] ${msg}`);
      host.emit('event', { type: 'showMessage', severity: 'error', message: msg });
      const items = rest.filter((r) => typeof r === 'string' || (typeof r === 'object' && r !== null));
      if (items.length) {
        return new Promise((resolve) => {
          const reqId = ++host._reqId;
          host._pendingRequests.set(reqId, resolve);
          host.emit('event', {
            type: 'showMessageRequest',
            id: reqId,
            severity: 'error',
            message: msg,
            items: items.map((i) => (typeof i === 'string' ? i : i.title)),
          });
          setTimeout(() => {
            if (host._pendingRequests.has(reqId)) {
              host._pendingRequests.delete(reqId);
              resolve(undefined);
            }
          }, 30000);
        });
      }
      return Promise.resolve(undefined);
    },
    createOutputChannel(name, opts) {
      const logLevelEmitter = new VscEventEmitter();
      const ch = {
        name,
        _lines: [],
        logLevel: 3,
        onDidChangeLogLevel: logLevelEmitter.event,
        append(s) {
          this._lines.push(s);
        },
        appendLine(line) {
          log(`[${name}] ${line}`);
          this._lines.push(line + '\n');
        },
        clear() {
          this._lines = [];
        },
        show() {},
        hide() {},
        replace(s) {
          this._lines = [s];
        },
        dispose() {
          logLevelEmitter.dispose();
          host._outputChannels.delete(name);
        },
      };
      if (typeof opts === 'object' && opts.log) {
        ch.trace = ch.debug = ch.info = ch.warn = ch.error = (msg) => ch.appendLine(msg);
      }
      host._outputChannels.set(name, ch);
      return ch;
    },
    createStatusBarItem(alignmentOrId, priorityOrAlignment, priorityArg) {
      let itemId, alignment, priority;
      if (typeof alignmentOrId === 'string') {
        itemId = alignmentOrId;
        alignment = typeof priorityOrAlignment === 'number' ? priorityOrAlignment : 1;
        priority = typeof priorityArg === 'number' ? priorityArg : 0;
      } else {
        itemId = `sidex-statusbar-${++host._reqId}`;
        alignment = typeof alignmentOrId === 'number' ? alignmentOrId : 1;
        priority = typeof priorityOrAlignment === 'number' ? priorityOrAlignment : 0;
      }

      let _text = '';
      let _tooltip = '';
      let _command = '';
      let _color = undefined;
      let _backgroundColor = undefined;
      let _name = '';
      let _accessibilityInformation = undefined;
      let _visible = false;

      const emitUpdate = () => {
        if (!_visible) return;
        host.emit('event', {
          type: 'statusBarItemUpdate',
          id: itemId,
          text: _text,
          tooltip: typeof _tooltip === 'string' ? _tooltip : (_tooltip?.value ?? ''),
          command: typeof _command === 'string' ? _command : _command?.command ?? '',
          color: _color,
          backgroundColor: _backgroundColor,
          name: _name || itemId,
          alignment,
          priority,
        });
      };

      const item = {
        get id() { return itemId; },
        get alignment() { return alignment; },
        get priority() { return priority; },
        get text() { return _text; },
        set text(v) { _text = v || ''; emitUpdate(); },
        get tooltip() { return _tooltip; },
        set tooltip(v) { _tooltip = v; emitUpdate(); },
        get command() { return _command; },
        set command(v) { _command = v; emitUpdate(); },
        get color() { return _color; },
        set color(v) { _color = v; emitUpdate(); },
        get backgroundColor() { return _backgroundColor; },
        set backgroundColor(v) { _backgroundColor = v; emitUpdate(); },
        get name() { return _name; },
        set name(v) { _name = v; emitUpdate(); },
        get accessibilityInformation() { return _accessibilityInformation; },
        set accessibilityInformation(v) { _accessibilityInformation = v; },
        show() {
          _visible = true;
          host.emit('event', {
            type: 'statusBarItemShow',
            id: itemId,
            text: _text,
            tooltip: typeof _tooltip === 'string' ? _tooltip : (_tooltip?.value ?? ''),
            command: typeof _command === 'string' ? _command : _command?.command ?? '',
            color: _color,
            backgroundColor: _backgroundColor,
            name: _name || itemId,
            alignment,
            priority,
          });
        },
        hide() {
          if (!_visible) return;
          _visible = false;
          host.emit('event', { type: 'statusBarItemHide', id: itemId });
        },
        dispose() {
          _visible = false;
          host.emit('event', { type: 'statusBarItemRemove', id: itemId });
        },
      };
      return item;
    },
    showQuickPick(items, options) {
      return new Promise((resolve) => {
        const reqId = ++host._reqId;
        host._pendingRequests.set(reqId, resolve);
        const labels = Array.isArray(items) ? items.map((i) => (typeof i === 'string' ? i : i.label)) : [];
        host.emit('event', { type: 'showQuickPick', id: reqId, items: labels, options: options || {} });
        setTimeout(() => {
          if (host._pendingRequests.has(reqId)) {
            host._pendingRequests.delete(reqId);
            resolve(undefined);
          }
        }, 60000);
      });
    },
    showInputBox(options) {
      return new Promise((resolve) => {
        const reqId = ++host._reqId;
        host._pendingRequests.set(reqId, resolve);
        host.emit('event', { type: 'showInputBox', id: reqId, options: options || {} });
        setTimeout(() => {
          if (host._pendingRequests.has(reqId)) {
            host._pendingRequests.delete(reqId);
            resolve(undefined);
          }
        }, 60000);
      });
    },
    showOpenDialog: (options) => {
      return new Promise((resolve) => {
        const reqId = ++host._reqId;
        host._pendingRequests.set(reqId, resolve);
        host.emit('event', { type: 'showOpenDialog', id: reqId, options: options || {} });
        setTimeout(() => {
          if (host._pendingRequests.has(reqId)) {
            host._pendingRequests.delete(reqId);
            resolve(undefined);
          }
        }, 120000);
      });
    },
    showSaveDialog: (options) => {
      return new Promise((resolve) => {
        const reqId = ++host._reqId;
        host._pendingRequests.set(reqId, resolve);
        host.emit('event', { type: 'showSaveDialog', id: reqId, options: options || {} });
        setTimeout(() => {
          if (host._pendingRequests.has(reqId)) {
            host._pendingRequests.delete(reqId);
            resolve(undefined);
          }
        }, 120000);
      });
    },
    get activeTextEditor() {
      return host._activeEditorId ? host._editorValues.get(host._activeEditorId) : undefined;
    },
    get visibleTextEditors() {
      return [...host._editorValues.values()];
    },
    onDidChangeActiveTextEditor: (listener, thisArg, disposables) =>
      host._onActiveEditorChangeEvent.event(listener, thisArg, disposables),
    onDidChangeVisibleTextEditors: (listener, thisArg, disposables) =>
      host._onVisibleEditorsChangeEvent.event(listener, thisArg, disposables),
    onDidChangeTextEditorSelection: (listener, thisArg, disposables) =>
      host._onSelectionChangeEvent.event(listener, thisArg, disposables),
    onDidChangeTextEditorOptions: (listener, thisArg, disposables) =>
      host._onOptionsChangeEvent.event(listener, thisArg, disposables),
    onDidChangeTextEditorVisibleRanges: (listener, thisArg, disposables) =>
      host._onVisibleRangesChangeEvent.event(listener, thisArg, disposables),
    onDidChangeTextEditorViewColumn: noopEvent,
    onDidChangeWindowState: noopEvent,
    onDidChangeVisibleNotebookEditors: noopEvent,
    onDidChangeActiveNotebookEditor: noopEvent,
    onDidWriteTerminalData: noopEvent,
    createTextEditorDecorationType(options) {
      const key = `deco-${++host._nextDecorationTypeId}`;
      host._decorationTypes.set(key, options);
      host.emit('event', { type: 'registerDecorationType', key, options });
      return {
        key,
        dispose() {
          host._decorationTypes.delete(key);
          host.emit('event', { type: 'removeDecorationType', key });
        }
      };
    },
    showTextDocument: (docOrUri, columnOrOptions, preserveFocus) => {
      const uri = docOrUri && docOrUri.uri ? docOrUri.uri : docOrUri;
      const uriStr = uri?.toString?.() || '';
      host.emit('event', {
        type: 'showTextDocument',
        uri: uriStr,
        options: typeof columnOrOptions === 'object' ? columnOrOptions : {},
      });
      for (const [edId, ed] of host._editors) {
        if (ed.uri === uriStr) return Promise.resolve(host._editorValues.get(edId));
      }
      return Promise.resolve(undefined);
    },
    withProgress(opts, task) {
      const cts = { isCancellationRequested: false, onCancellationRequested: noopEvent };
      const progress = {
        report(value) {
          host.emit('event', {
            type: 'progress',
            location: opts.location,
            title: opts.title,
            message: value.message,
            increment: value.increment,
          });
        },
      };
      host.emit('event', { type: 'progressStart', location: opts.location, title: opts.title });
      const result = task(progress, cts);
      if (result && typeof result.then === 'function') {
        return result.finally(() => {
          host.emit('event', { type: 'progressEnd', location: opts.location, title: opts.title });
        });
      }
      host.emit('event', { type: 'progressEnd', location: opts.location, title: opts.title });
      return result;
    },
    createTerminal(nameOrOptions, shellPath, shellArgs) {
      const termId = `sidex-term-${++host._reqId}`;
      let opts = {};
      if (typeof nameOrOptions === 'object' && nameOrOptions !== null) {
        opts = nameOrOptions;
      } else {
        opts = { name: nameOrOptions || '', shellPath, shellArgs };
      }
      host.emit('event', {
        type: 'createTerminal',
        terminalId: termId,
        name: opts.name || '',
        shellPath: opts.shellPath,
        shellArgs: opts.shellArgs,
        cwd: opts.cwd ? (typeof opts.cwd === 'string' ? opts.cwd : opts.cwd.fsPath) : undefined,
        env: opts.env,
        strictEnv: opts.strictEnv,
        hideFromUser: opts.hideFromUser,
        isTransient: opts.isTransient,
        location: opts.location,
        message: opts.message,
      });
      const onDidCloseEmitter = new VscEventEmitter();
      const terminal = {
        name: opts.name || '',
        processId: Promise.resolve(undefined),
        creationOptions: opts,
        exitStatus: undefined,
        state: { isInteractedWith: false },
        shellIntegration: undefined,
        sendText(text, addNewLine) {
          host.emit('event', {
            type: 'terminalSendText',
            terminalId: termId,
            text,
            addNewLine: addNewLine !== false,
          });
        },
        show(preserveFocus) {
          host.emit('event', { type: 'terminalShow', terminalId: termId, preserveFocus });
        },
        hide() {
          host.emit('event', { type: 'terminalHide', id: termId });
        },
        dispose() {
          host.emit('event', { type: 'terminalDispose', terminalId: termId });
          onDidCloseEmitter.fire(undefined);
          onDidCloseEmitter.dispose();
        },
      };
      if (!host._terminals) host._terminals = new Map();
      host._terminals.set(termId, terminal);
      return terminal;
    },
    get terminals() {
      if (!host._terminals) return [];
      return [...host._terminals.values()];
    },
    onDidOpenTerminal: noopEvent,
    onDidCloseTerminal: noopEvent,
    onDidChangeActiveTerminal: noopEvent,
    onDidChangeTerminalState: noopEvent,
    registerTreeDataProvider: (viewId, provider) => {
      host.emit('event', { type: 'registerTreeDataProvider', viewId });
      if (!host._treeProviders) host._treeProviders = new Map();
      host._treeProviders.set(viewId, provider);
      return { dispose() { host._treeProviders?.delete(viewId); } };
    },
    createTreeView: (viewId, options) => {
      const provider = options.treeDataProvider;
      if (!host._treeProviders) host._treeProviders = new Map();
      host._treeProviders.set(viewId, provider);
      const selectionEmitter = new VscEventEmitter();
      const visibilityEmitter = new VscEventEmitter();
      const expandEmitter = new VscEventEmitter();
      const collapseEmitter = new VscEventEmitter();
      const checkboxEmitter = new VscEventEmitter();
      let _visible = true;
      let _selection = [];
      let _message = '';
      let _title = viewId;
      let _description = '';
      let _badge = undefined;
      host.emit('event', { type: 'createTreeView', viewId, canSelectMany: options.canSelectMany });
      return {
        onDidExpandElement: expandEmitter.event,
        onDidCollapseElement: collapseEmitter.event,
        get selection() { return _selection; },
        onDidChangeSelection: selectionEmitter.event,
        get visible() { return _visible; },
        onDidChangeVisibility: visibilityEmitter.event,
        onDidChangeCheckboxState: checkboxEmitter.event,
        get message() { return _message; },
        set message(v) { _message = v; host.emit('event', { type: 'treeViewUpdate', viewId, message: v }); },
        get title() { return _title; },
        set title(v) { _title = v; host.emit('event', { type: 'treeViewUpdate', viewId, title: v }); },
        get description() { return _description; },
        set description(v) { _description = v; host.emit('event', { type: 'treeViewUpdate', viewId, description: v }); },
        get badge() { return _badge; },
        set badge(v) { _badge = v; },
        reveal(element, opts) {
          host.emit('event', { type: 'treeViewReveal', viewId, options: opts });
          return Promise.resolve();
        },
        dispose() {
          host._treeProviders?.delete(viewId);
          selectionEmitter.dispose();
          visibilityEmitter.dispose();
          expandEmitter.dispose();
          collapseEmitter.dispose();
          checkboxEmitter.dispose();
        },
      };
    },
    registerWebviewPanelSerializer: (viewType, serializer) => {
      if (!host._webviewSerializers) host._webviewSerializers = new Map();
      host._webviewSerializers.set(viewType, serializer);
      return { dispose() { host._webviewSerializers?.delete(viewType); } };
    },
    registerWebviewViewProvider: (viewId, provider) => {
      if (!host._webviewViewProviders) host._webviewViewProviders = new Map();
      host._webviewViewProviders.set(viewId, provider);
      host.emit('event', { type: 'registerWebviewViewProvider', viewId });
      return { dispose() { host._webviewViewProviders?.delete(viewId); } };
    },
    registerCustomEditorProvider: (viewType, provider) => {
      if (!host._customEditorProviders) host._customEditorProviders = new Map();
      host._customEditorProviders.set(viewType, provider);
      host.emit('event', { type: 'registerCustomEditorProvider', viewType });
      return { dispose() { host._customEditorProviders?.delete(viewType); } };
    },
    registerUriHandler: (handler) => {
      host._uriHandler = handler;
      host.emit('event', { type: 'registerUriHandler' });
      return { dispose() { host._uriHandler = null; } };
    },
    registerFileDecorationProvider: (provider) => {
      if (!host._fileDecorationProviders) host._fileDecorationProviders = [];
      host._fileDecorationProviders.push(provider);
      return { dispose() {
        const idx = host._fileDecorationProviders?.indexOf(provider);
        if (idx >= 0) host._fileDecorationProviders.splice(idx, 1);
      }};
    },
    registerTerminalLinkProvider: (provider) => {
      if (!host._terminalLinkProviders) host._terminalLinkProviders = [];
      host._terminalLinkProviders.push(provider);
      return { dispose() {
        const idx = host._terminalLinkProviders?.indexOf(provider);
        if (idx >= 0) host._terminalLinkProviders.splice(idx, 1);
      }};
    },
    registerTerminalProfileProvider: (id, provider) => {
      if (!host._terminalProfileProviders) host._terminalProfileProviders = new Map();
      host._terminalProfileProviders.set(id, provider);
      return { dispose() { host._terminalProfileProviders?.delete(id); } };
    },
    onDidChangeTerminalShellIntegration: noopEvent,
    onDidStartTerminalShellExecution: noopEvent,
    onDidEndTerminalShellExecution: noopEvent,
    createQuickPick() {
      const acceptEmitter = new VscEventEmitter();
      const changeActiveEmitter = new VscEventEmitter();
      const changeSelectionEmitter = new VscEventEmitter();
      const changeValueEmitter = new VscEventEmitter();
      const hideEmitter = new VscEventEmitter();
      const triggerButtonEmitter = new VscEventEmitter();
      const triggerItemButtonEmitter = new VscEventEmitter();
      let _items = [];
      let _value = '';
      let _placeholder = '';
      let _title = '';
      let _step = undefined;
      let _totalSteps = undefined;
      let _busy = false;
      let _enabled = true;
      let _canSelectMany = false;
      let _matchOnDescription = false;
      let _matchOnDetail = false;
      let _activeItems = [];
      let _selectedItems = [];
      let _buttons = [];
      const qpId = `sidex-qp-${++host._reqId}`;
      return {
        get items() { return _items; },
        set items(v) { _items = v; },
        get value() { return _value; },
        set value(v) { _value = v; changeValueEmitter.fire(v); },
        get placeholder() { return _placeholder; },
        set placeholder(v) { _placeholder = v; },
        get title() { return _title; },
        set title(v) { _title = v; },
        get step() { return _step; },
        set step(v) { _step = v; },
        get totalSteps() { return _totalSteps; },
        set totalSteps(v) { _totalSteps = v; },
        get busy() { return _busy; },
        set busy(v) { _busy = v; },
        get enabled() { return _enabled; },
        set enabled(v) { _enabled = v; },
        get canSelectMany() { return _canSelectMany; },
        set canSelectMany(v) { _canSelectMany = v; },
        get matchOnDescription() { return _matchOnDescription; },
        set matchOnDescription(v) { _matchOnDescription = v; },
        get matchOnDetail() { return _matchOnDetail; },
        set matchOnDetail(v) { _matchOnDetail = v; },
        get activeItems() { return _activeItems; },
        set activeItems(v) { _activeItems = v; changeActiveEmitter.fire(v); },
        get selectedItems() { return _selectedItems; },
        set selectedItems(v) { _selectedItems = v; changeSelectionEmitter.fire(v); },
        get buttons() { return _buttons; },
        set buttons(v) { _buttons = v; },
        keepScrollPosition: false,
        onDidAccept: acceptEmitter.event,
        onDidChangeActive: changeActiveEmitter.event,
        onDidChangeSelection: changeSelectionEmitter.event,
        onDidChangeValue: changeValueEmitter.event,
        onDidHide: hideEmitter.event,
        onDidTriggerButton: triggerButtonEmitter.event,
        onDidTriggerItemButton: triggerItemButtonEmitter.event,
        show() {
          host.emit('event', {
            type: 'showQuickPick',
            id: qpId,
            items: _items.map((i) => (typeof i === 'string' ? i : i.label)),
            options: { title: _title, placeholder: _placeholder, canPickMany: _canSelectMany },
          });
        },
        hide() { hideEmitter.fire(); },
        dispose() {
          acceptEmitter.dispose();
          changeActiveEmitter.dispose();
          changeSelectionEmitter.dispose();
          changeValueEmitter.dispose();
          hideEmitter.dispose();
          triggerButtonEmitter.dispose();
          triggerItemButtonEmitter.dispose();
        },
      };
    },
    createInputBox() {
      const acceptEmitter = new VscEventEmitter();
      const changeValueEmitter = new VscEventEmitter();
      const hideEmitter = new VscEventEmitter();
      const triggerButtonEmitter = new VscEventEmitter();
      let _value = '';
      let _placeholder = '';
      let _password = false;
      let _title = '';
      let _step = undefined;
      let _totalSteps = undefined;
      let _prompt = '';
      let _validationMessage = '';
      let _busy = false;
      let _enabled = true;
      let _buttons = [];
      let _valueSelection = undefined;
      const ibId = `sidex-ib-${++host._reqId}`;
      return {
        get value() { return _value; },
        set value(v) { _value = v; },
        get valueSelection() { return _valueSelection; },
        set valueSelection(v) { _valueSelection = v; },
        get placeholder() { return _placeholder; },
        set placeholder(v) { _placeholder = v; },
        get password() { return _password; },
        set password(v) { _password = v; },
        get title() { return _title; },
        set title(v) { _title = v; },
        get step() { return _step; },
        set step(v) { _step = v; },
        get totalSteps() { return _totalSteps; },
        set totalSteps(v) { _totalSteps = v; },
        get prompt() { return _prompt; },
        set prompt(v) { _prompt = v; },
        get validationMessage() { return _validationMessage; },
        set validationMessage(v) { _validationMessage = v; },
        get busy() { return _busy; },
        set busy(v) { _busy = v; },
        get enabled() { return _enabled; },
        set enabled(v) { _enabled = v; },
        get buttons() { return _buttons; },
        set buttons(v) { _buttons = v; },
        onDidAccept: acceptEmitter.event,
        onDidChangeValue: changeValueEmitter.event,
        onDidHide: hideEmitter.event,
        onDidTriggerButton: triggerButtonEmitter.event,
        show() {
          host.emit('event', {
            type: 'showInputBox',
            id: ibId,
            options: { title: _title, prompt: _prompt, placeholder: _placeholder, password: _password, value: _value },
          });
        },
        hide() { hideEmitter.fire(); },
        dispose() {
          acceptEmitter.dispose();
          changeValueEmitter.dispose();
          hideEmitter.dispose();
          triggerButtonEmitter.dispose();
        },
      };
    },
    createWebviewPanel: (viewType, title, showOptions, options) => {
      const panelId = `sidex-webview-${++host._reqId}`;
      const messageEmitter = new VscEventEmitter();
      const disposeEmitter = new VscEventEmitter();
      const viewStateEmitter = new VscEventEmitter();
      let _html = '';
      let _title = title;
      let _iconPath = undefined;
      let _active = true;
      let _visible = true;
      const column = typeof showOptions === 'number' ? showOptions : showOptions?.viewColumn || 1;
      host.emit('event', { type: 'createWebviewPanel', panelId, viewType, title, column, options });
      const panel = {
        viewType,
        get title() { return _title; },
        set title(v) { _title = v; host.emit('event', { type: 'webviewPanelUpdate', panelId, title: v }); },
        get iconPath() { return _iconPath; },
        set iconPath(v) {
          _iconPath = v;
          if (v) {
            let light, dark;
            if (v.light || v.dark) {
              light = v.light ? (v.light.path || v.light.fsPath || String(v.light)) : undefined;
              dark = v.dark ? (v.dark.path || v.dark.fsPath || String(v.dark)) : undefined;
            } else {
              const p = v.path || v.fsPath || String(v);
              light = p;
              dark = p;
            }
            host.emit('event', { type: 'webviewPanelIcon', panelId, light, dark });
          }
        },
        webview: {
          get options() { return options || {}; },
          set options(v) { options = { ...options, ...v }; },
          get html() { return _html; },
          set html(v) { _html = v; host.emit('event', { type: 'webviewHtmlUpdate', panelId, html: inlineWebviewResources(v) }); },
          onDidReceiveMessage: messageEmitter.event,
          postMessage(msg) {
            host.emit('event', { type: 'webviewPostMessage', panelId, message: msg });
            return Promise.resolve(true);
          },
          asWebviewUri(localUri) {
            if (!localUri) return localUri;
            const scheme = localUri.scheme || 'file';
            const uriPath = localUri.path || '';
            const nativePath = localUri.fsPath || uriPathToFsPath(uriPath) || '';
            if (scheme === 'http' || scheme === 'https') return localUri;
            const imgMimes = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon' };
            const ext = path.extname(nativePath).toLowerCase();
            if (imgMimes[ext]) {
              try {
                const dataUri = `data:${imgMimes[ext]};base64,${fs.readFileSync(nativePath).toString('base64')}`;
                return { scheme: 'data', authority: '', path: dataUri.slice(5), query: '', fragment: '', fsPath: nativePath, toString() { return dataUri; }, with(change) { return { ...this, ...change }; }, toJSON() { return { $mid: 1, scheme: 'data', path: this.path }; } };
              } catch {}
            }
            const RESOURCE_AUTHORITY = 'vscode-resource.vscode-cdn.net';
            return {
              scheme: 'https',
              authority: `${scheme}+${localUri.authority || ''}.${RESOURCE_AUTHORITY}`,
              path: uriPath,
              query: localUri.query || '',
              fragment: localUri.fragment || '',
              fsPath: nativePath,
              toString() { return `https://${this.authority}${this.path}`; },
              with(change) { return { ...this, ...change }; },
              toJSON() { return { scheme: this.scheme, authority: this.authority, path: this.path }; },
            };
          },
          cspSource: "https://*.vscode-resource.vscode-cdn.net 'self' http://localhost:* *",
        },
        get options() { return options || {}; },
        get viewColumn() { return column; },
        get active() { return _active; },
        get visible() { return _visible; },
        onDidDispose: disposeEmitter.event,
        onDidChangeViewState: viewStateEmitter.event,
        reveal(viewColumn, preserveFocus) {
          host.emit('event', { type: 'webviewPanelReveal', panelId, viewColumn, preserveFocus });
        },
        dispose() {
          host.emit('event', { type: 'webviewPanelDispose', panelId });
          disposeEmitter.fire();
          disposeEmitter.dispose();
          messageEmitter.dispose();
          viewStateEmitter.dispose();
        },
        _panelId: panelId,
        _disposeEmitter: disposeEmitter,
        _messageEmitter: messageEmitter,
        _viewStateEmitter: viewStateEmitter,
      };
      if (!host._webviewPanels) host._webviewPanels = new Map();
      host._webviewPanels.set(panelId, panel);
      disposeEmitter.event(() => { host._webviewPanels?.delete(panelId); });
      return panel;
    },
    get state() {
      return { focused: true };
    },
    get activeColorTheme() {
      return { kind: 2 };
    },
    onDidChangeActiveColorTheme: noopEvent,
    get tabGroups() {
      return {
        all: [],
        activeTabGroup: { tabs: [], isActive: true, viewColumn: 1 },
        onDidChangeTabGroups: noopEvent,
        onDidChangeTabs: noopEvent,
        close: () => Promise.resolve(),
      };
    },
    setStatusBarMessage: () => noopDisposable,
  };

  const extensions = {
    getExtension(id) {
      const ext = host._extensions.get(id);
      if (!ext) return undefined;
      return {
        id,
        extensionPath: ext.extensionPath,
        extensionUri: VscUri.file(ext.extensionPath),
        exports: ext.exports,
        isActive: ext.activated,
        packageJSON: ext.manifest.packageJSON || ext.manifest,
        extensionKind: ExtensionKind.Workspace,
        activate: () => Promise.resolve(ext.exports),
      };
    },
    get all() {
      const arr = [];
      for (const [id, ext] of host._extensions)
        arr.push({
          id,
          extensionPath: ext.extensionPath,
          extensionUri: VscUri.file(ext.extensionPath),
          exports: ext.exports,
          isActive: ext.activated,
          packageJSON: ext.manifest.packageJSON || ext.manifest,
          extensionKind: ExtensionKind.Workspace,
        });
      return arr;
    },
    onDidChange: noopEvent,
  };

  const env = (() => {
    const cp = require('child_process');
    const logLevelEmitter = new VscEventEmitter();
    const telemetryEmitter = new VscEventEmitter();
    const shellEmitter = new VscEventEmitter();
    let _logLevel = 2;
    let _clipboardText = '';
    return {
      appName: 'SideX',
      appRoot: process.cwd(),
      appHost: 'desktop',
      language: 'en',
      machineId: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`,
      sessionId: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`,
      uriScheme: 'sidex',
      get shell() { return process.env.SHELL || process.env.COMSPEC || '/bin/sh'; },
      clipboard: {
        readText() {
          try {
            if (process.platform === 'darwin') {
              return Promise.resolve(cp.execSync('pbpaste', { encoding: 'utf8' }));
            }
            if (process.platform === 'linux') {
              return Promise.resolve(cp.execSync('xclip -selection clipboard -o', { encoding: 'utf8' }));
            }
          } catch {}
          return Promise.resolve(_clipboardText);
        },
        writeText(text) {
          _clipboardText = text;
          try {
            if (process.platform === 'darwin') {
              cp.execSync('pbcopy', { input: text });
              return Promise.resolve();
            }
            if (process.platform === 'linux') {
              cp.execSync('xclip -selection clipboard', { input: text });
              return Promise.resolve();
            }
          } catch {}
          return Promise.resolve();
        },
      },
      openExternal: (uri) => {
        const url = typeof uri === 'string' ? uri : uri?.toString?.() || '';
        host.emit('event', { type: 'openExternal', url });
        return Promise.resolve(true);
      },
      asExternalUri: (uri) => Promise.resolve(uri),
      createTelemetryLogger: (sender, options) => {
        const enableEmitter = new VscEventEmitter();
        return {
          logUsage(eventName, data) {
            if (sender && typeof sender.sendEventData === 'function') {
              try { sender.sendEventData(eventName, data); } catch {}
            }
          },
          logError(eventNameOrError, data) {
            if (sender && typeof sender.sendErrorData === 'function') {
              try {
                const err = eventNameOrError instanceof Error ? eventNameOrError : new Error(String(eventNameOrError));
                sender.sendErrorData(err, data);
              } catch {}
            }
          },
          get isUsageEnabled() { return false; },
          get isErrorsEnabled() { return false; },
          onDidChangeEnableStates: enableEmitter.event,
          dispose() {
            if (sender && typeof sender.flush === 'function') {
              try { sender.flush(); } catch {}
            }
            enableEmitter.dispose();
          },
        };
      },
      get isTelemetryEnabled() { return false; },
      onDidChangeTelemetryEnabled: telemetryEmitter.event,
      get isNewAppInstall() { return true; },
      get remoteName() { return undefined; },
      get logLevel() { return _logLevel; },
      onDidChangeLogLevel: logLevelEmitter.event,
      onDidChangeShell: shellEmitter.event,
      get uiKind() { return 1; },
    };
  })();

  const tasks = (() => {
    const _taskProviders = new Map();
    const _executions = [];
    const startEmitter = new VscEventEmitter();
    const endEmitter = new VscEventEmitter();
    const processStartEmitter = new VscEventEmitter();
    const processEndEmitter = new VscEventEmitter();
    return {
      registerTaskProvider: (type, provider) => {
        _taskProviders.set(type, provider);
        host.emit('event', { type: 'registerTaskProvider', taskType: type });
        return { dispose() { _taskProviders.delete(type); } };
      },
      fetchTasks: (filter) => {
        const promises = [];
        for (const [type, provider] of _taskProviders) {
          if (!filter || !filter.type || filter.type === type) {
            try {
              const result = provider.provideTasks(
                { isCancellationRequested: false, onCancellationRequested: noopEvent }
              );
              if (result && typeof result.then === 'function') {
                promises.push(result.then((t) => t || []));
              } else {
                promises.push(Promise.resolve(result || []));
              }
            } catch {
              promises.push(Promise.resolve([]));
            }
          }
        }
        return Promise.all(promises).then((arrays) => arrays.flat());
      },
      executeTask: (task) => {
        const execId = `sidex-taskexec-${++host._reqId}`;
        host.emit('event', {
          type: 'executeTask',
          id: execId,
          name: task.name,
          source: task.source,
          definition: task.definition,
        });
        const execution = { task, terminate() { host.emit('event', { type: 'terminateTask', id: execId }); } };
        _executions.push(execution);
        startEmitter.fire({ execution });
        return Promise.resolve(execution);
      },
      get taskExecutions() { return [..._executions]; },
      onDidStartTask: startEmitter.event,
      onDidEndTask: endEmitter.event,
      onDidStartTaskProcess: processStartEmitter.event,
      onDidEndTaskProcess: processEndEmitter.event,
    };
  })();

  const debug = (() => {
    const _configProviders = new Map();
    const _adapterFactories = new Map();
    const _trackerFactories = new Map();
    const _breakpoints = [];
    let _activeSession = undefined;
    const sessionStartEmitter = new VscEventEmitter();
    const sessionEndEmitter = new VscEventEmitter();
    const activeSessionEmitter = new VscEventEmitter();
    const breakpointsEmitter = new VscEventEmitter();
    const customEventEmitter = new VscEventEmitter();
    return {
      registerDebugConfigurationProvider: (type, provider, trigger) => {
        const key = `${type}:${trigger || 1}`;
        if (!_configProviders.has(key)) _configProviders.set(key, []);
        _configProviders.get(key).push(provider);
        return { dispose() {
          const arr = _configProviders.get(key);
          if (arr) {
            const idx = arr.indexOf(provider);
            if (idx >= 0) arr.splice(idx, 1);
          }
        }};
      },
      registerDebugAdapterDescriptorFactory: (type, factory) => {
        _adapterFactories.set(type, factory);
        return { dispose() { _adapterFactories.delete(type); } };
      },
      registerDebugAdapterTrackerFactory: (type, factory) => {
        if (!_trackerFactories.has(type)) _trackerFactories.set(type, []);
        _trackerFactories.get(type).push(factory);
        return { dispose() {
          const arr = _trackerFactories.get(type);
          if (arr) {
            const idx = arr.indexOf(factory);
            if (idx >= 0) arr.splice(idx, 1);
          }
        }};
      },
      registerDebugVisualizationTreeProvider: () => noopDisposable,
      registerDebugVisualizationProvider: () => noopDisposable,
      startDebugging: (folder, config, parentSession) => {
        host.emit('event', { type: 'startDebugging', folder, config, parentSession });
        return Promise.resolve(true);
      },
      stopDebugging: (session) => {
        host.emit('event', { type: 'stopDebugging', sessionId: session?.id });
        return Promise.resolve();
      },
      addBreakpoints: (bps) => {
        _breakpoints.push(...bps);
        breakpointsEmitter.fire({ added: bps, removed: [], changed: [] });
      },
      removeBreakpoints: (bps) => {
        for (const bp of bps) {
          const idx = _breakpoints.indexOf(bp);
          if (idx >= 0) _breakpoints.splice(idx, 1);
        }
        breakpointsEmitter.fire({ added: [], removed: bps, changed: [] });
      },
      get activeDebugSession() { return _activeSession; },
      get activeDebugConsole() {
        return {
          append(value) { host.emit('event', { type: 'debugConsoleAppend', value }); },
          appendLine(value) { host.emit('event', { type: 'debugConsoleAppend', value: value + '\n' }); },
        };
      },
      get breakpoints() { return [..._breakpoints]; },
      onDidChangeActiveDebugSession: activeSessionEmitter.event,
      onDidStartDebugSession: sessionStartEmitter.event,
      onDidReceiveDebugSessionCustomEvent: customEventEmitter.event,
      onDidTerminateDebugSession: sessionEndEmitter.event,
      onDidChangeBreakpoints: breakpointsEmitter.event,
      asDebugSourceUri: (source, session) => {
        if (source.path) return VscUri.file(source.path);
        return VscUri.file('');
      },
    };
  })();

  const notebooks = {
    createNotebookController: (id, notebookType, label, handler) => {
      const selectedEmitter = new VscEventEmitter();
      let _supportedLanguages = undefined;
      let _supportsExecutionOrder = false;
      let _description = '';
      let _detail = '';
      let _executeHandler = handler || undefined;
      let _interruptHandler = undefined;
      host.emit('event', { type: 'createNotebookController', id, notebookType, label });
      return {
        id,
        notebookType,
        get label() { return label; },
        get supportedLanguages() { return _supportedLanguages; },
        set supportedLanguages(v) { _supportedLanguages = v; },
        get supportsExecutionOrder() { return _supportsExecutionOrder; },
        set supportsExecutionOrder(v) { _supportsExecutionOrder = v; },
        get description() { return _description; },
        set description(v) { _description = v; },
        get detail() { return _detail; },
        set detail(v) { _detail = v; },
        get executeHandler() { return _executeHandler; },
        set executeHandler(v) { _executeHandler = v; },
        get interruptHandler() { return _interruptHandler; },
        set interruptHandler(v) { _interruptHandler = v; },
        onDidChangeSelectedNotebooks: selectedEmitter.event,
        createNotebookCellExecution(cell) {
          let _order = undefined;
          const token = { isCancellationRequested: false, onCancellationRequested: noopEvent };
          return {
            cell,
            token,
            get executionOrder() { return _order; },
            set executionOrder(v) { _order = v; },
            start(startTime) {},
            end(success, endTime) {},
            clearOutput(cell) { return Promise.resolve(); },
            replaceOutput(output, cell) { return Promise.resolve(); },
            appendOutput(output, cell) { return Promise.resolve(); },
            replaceOutputItems(items, output) { return Promise.resolve(); },
            appendOutputItems(items, output) { return Promise.resolve(); },
          };
        },
        dispose() { selectedEmitter.dispose(); },
      };
    },
    registerNotebookCellStatusBarItemProvider: (notebookType, provider) => {
      host.emit('event', { type: 'registerNotebookCellStatusBarItemProvider', notebookType });
      return noopDisposable;
    },
    createRendererMessaging: (rendererId) => {
      const msgEmitter = new VscEventEmitter();
      return {
        onDidReceiveMessage: msgEmitter.event,
        postMessage(message) {
          return Promise.resolve(true);
        },
      };
    },
  };

  const scm = {
    createSourceControl(id, label, rootUri) {
      const sc = {
        id,
        label,
        rootUri: rootUri || undefined,
        inputBox: {
          value: '',
          placeholder: '',
          enabled: true,
          visible: true,
          validateInput: undefined,
        },
        count: 0,
        quickDiffProvider: undefined,
        commitTemplate: undefined,
        acceptInputCommand: undefined,
        statusBarCommands: undefined,
        onDidChangeCommitTemplate: noopEvent,
        onDidChangeStatusBarCommands: noopEvent,
        onInputBoxValueChange: noopEvent,
        createResourceGroup(id, label) {
          const group = {
            id,
            label,
            hideWhenEmpty: undefined,
            resourceStates: [],
            onDidChange: noopEvent,
            dispose() {},
          };
          return group;
        },
        dispose() {},
      };
      host.emit('event', { type: 'scmSourceControlCreated', id, label });
      return sc;
    },
    inputBox: { value: '', placeholder: '' },
    registerGitContextProvider: (provider) => noopDisposable,
  };

  const comments = {
    createCommentController: (id, label) => {
      const threads = [];
      host.emit('event', { type: 'createCommentController', id, label });
      return {
        id,
        label,
        options: undefined,
        commentingRangeProvider: undefined,
        createCommentThread(uri, range, cmts) {
          const collapseEmitter = new VscEventEmitter();
          const thread = {
            uri,
            range,
            comments: cmts || [],
            collapsibleState: 1,
            canReply: true,
            contextValue: '',
            label: '',
            state: undefined,
            dispose() {
              const idx = threads.indexOf(thread);
              if (idx >= 0) threads.splice(idx, 1);
              collapseEmitter.dispose();
            },
          };
          threads.push(thread);
          return thread;
        },
        dispose() { threads.length = 0; },
      };
    },
  };

  const authentication = (() => {
    const _providers = new Map();
    const _sessions = new Map();
    const sessionsEmitter = new VscEventEmitter();
    return {
      getSession: (providerId, scopes, options) => {
        const key = `${providerId}:${(scopes || []).join(',')}`;
        const existing = _sessions.get(key);
        if (existing) return Promise.resolve(existing);
        const provider = _providers.get(providerId);
        if (provider) {
          return provider.getSessions(scopes).then((sessions) => {
            if (sessions && sessions.length > 0) {
              _sessions.set(key, sessions[0]);
              return sessions[0];
            }
            if (options && options.createIfNone) {
              return provider.createSession(scopes).then((session) => {
                _sessions.set(key, session);
                return session;
              });
            }
            return undefined;
          }).catch(() => undefined);
        }
        return Promise.resolve(undefined);
      },
      registerAuthenticationProvider: (id, label, provider, options) => {
        _providers.set(id, provider);
        host.emit('event', { type: 'registerAuthenticationProvider', id, label });
        if (provider.onDidChangeSessions) {
          provider.onDidChangeSessions((e) => {
            sessionsEmitter.fire({ provider: { id, label }, ...e });
          });
        }
        return { dispose() { _providers.delete(id); } };
      },
      onDidChangeSessions: sessionsEmitter.event,
    };
  })();

  const tests = {
    createTestController: (id, label) => {
      const items = new Map();
      return {
        id,
        label,
        items: {
          add: (item) => {
            if (item && item.id) items.set(item.id, item);
          },
          delete: (itemId) => {
            items.delete(itemId);
          },
          replace: (arr) => {
            items.clear();
            for (const item of arr || []) {
              if (item && item.id) items.set(item.id, item);
            }
          },
          get: (itemId) => items.get(itemId),
          forEach: (fn) => items.forEach(fn),
        },
        createTestItem: (testId, testLabel, uri) => ({
          id: testId,
          label: testLabel,
          uri,
          children: new Map(),
          canResolveChildren: false,
          range: undefined,
          busy: false,
          error: undefined,
          tags: [],
        }),
        createRunProfile: () => ({ dispose() {} }),
        createTestRun: () => ({
          enqueued() {},
          skipped() {},
          started() {},
          failed() {},
          passed() {},
          appendOutput() {},
          end() {},
        }),
        invalidateTestResults: () => {},
        refreshHandler: undefined,
        resolveHandler: undefined,
        dispose: () => {},
      };
    },
    createTestRunProfile: () => ({ dispose() {} }),
    onDidChangeTestResults: noopEvent,
    onDidChangeTestProviders: noopEvent,
  };

  const api = {
    Position: VscPosition,
    Range: VscRange,
    Selection: VscSelection,
    Uri: VscUri,
    Location,
    Diagnostic,
    DiagnosticRelatedInformation,
    DiagnosticSeverity,
    DiagnosticTag,
    CompletionItem,
    CompletionItemKind,
    CompletionItemTag,
    CompletionList,
    CompletionTriggerKind,
    CancellationError,
    FileSystemError,
    TextEdit,
    WorkspaceEdit,
    Hover,
    CodeAction,
    CodeLens,
    DocumentSymbol,
    SymbolInformation,
    SymbolKind,
    DocumentHighlight,
    DocumentHighlightKind,
    FoldingRange,
    FoldingRangeKind,
    SelectionRange,
    CallHierarchyItem,
    TypeHierarchyItem,
    DocumentLink,
    Color,
    ColorInformation,
    ColorPresentation,
    InlayHint,
    InlayHintKind,
    SignatureHelp,
    SignatureInformation,
    ParameterInformation,
    SignatureHelpTriggerKind,
    SnippetString,
    MarkdownString,
    ThemeColor,
    ThemeIcon,
    TreeItem,
    SemanticTokensLegend,
    SemanticTokensBuilder,
    SemanticTokens,
    CodeActionKind,
    IndentAction,
    FileType,
    TextEditorCursorStyle,
    TextEditorLineNumbersStyle,
    DecorationRangeBehavior,
    TextDocumentSaveReason,
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: {
      Active: -1,
      Beside: -2,
      One: 1,
      Two: 2,
      Three: 3,
      Four: 4,
      Five: 5,
      Six: 6,
      Seven: 7,
      Eight: 8,
      Nine: 9,
    },
    EndOfLine: { LF: 1, CRLF: 2 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation,
    TreeItemCollapsibleState,
    ExtensionKind,
    TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    UIKind: { Desktop: 1, Web: 2 },
    LogLevel: { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },
    EventEmitter: VscEventEmitter,
    CancellationTokenSource: class {
      constructor() {
        const emitter = new VscEventEmitter();
        this.token = { isCancellationRequested: false, onCancellationRequested: emitter.event };
        this._emitter = emitter;
      }
      cancel() {
        this.token.isCancellationRequested = true;
        this._emitter.fire();
      }
      dispose() {
        this._emitter.dispose();
      }
    },
    Disposable: class {
      constructor(fn) {
        this._fn = fn;
      }
      static from(...disposables) {
        return new this(() => disposables.forEach((d) => d.dispose()));
      }
      dispose() {
        if (this._fn) {
          this._fn();
          this._fn = null;
        }
      }
    },
    RelativePattern: class {
      constructor(base, pattern) {
        this.baseUri = typeof base === 'string' ? VscUri.file(base) : base.uri || base;
        this.base = typeof base === 'string' ? base : base.uri?.fsPath || base.fsPath || '';
        this.pattern = pattern;
      }
    },
    ShellExecution: class {
      constructor(commandLine, args, options) {
        this.commandLine = commandLine;
        this.args = args;
        this.options = options;
      }
    },
    ProcessExecution: class {
      constructor(process, args, options) {
        this.process = process;
        this.args = args;
        this.options = options;
      }
    },
    CustomExecution: class {
      constructor(callback) {
        this.callback = callback;
      }
    },
    Task: class {
      constructor(definition, scope, name, source, execution, problemMatchers) {
        this.definition = definition;
        this.scope = scope;
        this.name = name;
        this.source = source;
        this.execution = execution;
        this.problemMatchers = problemMatchers || [];
        this.isBackground = false;
        this.presentationOptions = {};
        this.runOptions = {};
        this.group = undefined;
      }
    },
    TaskScope: { Global: 1, Workspace: 2 },
    TaskGroup: { Build: { id: 'build' }, Test: { id: 'test' }, Clean: { id: 'clean' }, Rebuild: { id: 'rebuild' } },
    TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
    TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
    DebugConfigurationProviderTriggerKind: { Initial: 1, Dynamic: 2 },
    TerminalLocation: { Panel: 1, Editor: 2 },
    TerminalExitReason: { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 },
    TerminalShellExecutionCommandLineConfidence: { Low: 0, Medium: 1, High: 2 },
    EnvironmentVariableMutatorType: { Replace: 1, Append: 2, Prepend: 3 },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    FilePermission: { Readonly: 1 },
    TextDocumentChangeReason: { Undo: 1, Redo: 2 },
    NotebookCellKind: { Markup: 1, Code: 2 },
    NotebookControllerAffinity: { Default: 1, Preferred: 2 },
    NotebookCellStatusBarAlignment: { Left: 1, Right: 2 },
    NotebookEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    CommentMode: { Editing: 0, Preview: 1 },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
    CommentThreadState: { Unresolved: 0, Resolved: 1 },
    LanguageStatusSeverity: { Information: 0, Warning: 1, Error: 2 },
    ShellQuoting: { Escape: 1, Strong: 2, Weak: 3 },
    TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
    DocumentPasteTriggerKind: { Automatic: 0, PasteAs: 1 },
    DebugConsoleMode: { Separate: 0, MergeWithParent: 1 },
    ChatResultFeedbackKind: { Unhelpful: 0, Helpful: 1 },
    LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
    QuickInputButtonLocation: { Title: 1, Inline: 2, Input: 3 },
    SyntaxTokenType: { Other: 0, Comment: 1, String: 2, RegEx: 3 },
    CodeActionTriggerKind: { Invoke: 1, Automatic: 2 },
    QuickInputButtons: class {
      static get Back() {
        return { iconPath: new ThemeIcon('arrow-left'), tooltip: 'Back' };
      }
    },
    LocationLink: class {
      constructor(targetUri, targetRange, targetSelectionRange, originSelectionRange) {
        this.targetUri = targetUri;
        this.targetRange = targetRange;
        this.targetSelectionRange = targetSelectionRange;
        this.originSelectionRange = originSelectionRange;
      }
    },
    FileDecoration: class {
      constructor(badge, tooltip, color) {
        this.badge = badge;
        this.tooltip = tooltip;
        this.color = color;
      }
    },
    DataTransferItem: class {
      constructor(value) {
        this.value = value;
      }
      asString() {
        return Promise.resolve(typeof this.value === 'string' ? this.value : JSON.stringify(this.value));
      }
      asFile() {
        return undefined;
      }
    },
    DataTransfer: class {
      constructor() {
        this._map = new Map();
      }
      get(mimeType) {
        return this._map.get(mimeType.toLowerCase());
      }
      set(mimeType, value) {
        this._map.set(mimeType.toLowerCase(), value);
      }
      forEach(callbackfn, thisArg) {
        this._map.forEach((item, mimeType) => callbackfn.call(thisArg, item, mimeType, this));
      }
      [Symbol.iterator]() {
        return this._map[Symbol.iterator]();
      }
    },
    EvaluatableExpression: class {
      constructor(range, expression) {
        this.range = range;
        this.expression = expression;
      }
    },
    InlineValueText: class {
      constructor(range, text) {
        this.range = range;
        this.text = text;
      }
    },
    InlineValueVariableLookup: class {
      constructor(range, variableName, caseSensitiveLookup) {
        this.range = range;
        this.variableName = variableName;
        this.caseSensitiveLookup = caseSensitiveLookup !== undefined ? caseSensitiveLookup : true;
      }
    },
    InlineValueEvaluatableExpression: class {
      constructor(range, expression) {
        this.range = range;
        this.expression = expression;
      }
    },
    LinkedEditingRanges: class {
      constructor(ranges, wordPattern) {
        this.ranges = ranges;
        this.wordPattern = wordPattern;
      }
    },
    InlineCompletionItem: class {
      constructor(insertText, range, command) {
        this.insertText = insertText;
        this.range = range;
        this.command = command;
      }
    },
    InlineCompletionList: class {
      constructor(items) {
        this.items = items;
      }
    },
    NotebookRange: class {
      constructor(start, end) {
        if (start > end) {
          this.start = end;
          this.end = start;
        } else {
          this.start = start;
          this.end = end;
        }
        this.isEmpty = this.start === this.end;
      }
      with(change) {
        const s = change.start !== undefined ? change.start : this.start;
        const e = change.end !== undefined ? change.end : this.end;
        if (s === this.start && e === this.end) return this;
        return new api.NotebookRange(s, e);
      }
    },
    NotebookCellOutputItem: class {
      constructor(data, mime) {
        this.data = data;
        this.mime = mime;
      }
      static text(value, mime) {
        const encoder = new TextEncoder();
        return new api.NotebookCellOutputItem(encoder.encode(value), mime || 'text/plain');
      }
      static json(value, mime) {
        const encoder = new TextEncoder();
        return new api.NotebookCellOutputItem(encoder.encode(JSON.stringify(value)), mime || 'application/json');
      }
      static stdout(value) {
        return api.NotebookCellOutputItem.text(value, 'application/vnd.code.notebook.stdout');
      }
      static stderr(value) {
        return api.NotebookCellOutputItem.text(value, 'application/vnd.code.notebook.stderr');
      }
      static error(value) {
        return api.NotebookCellOutputItem.json({ name: value.name, message: value.message, stack: value.stack }, 'application/vnd.code.notebook.error');
      }
    },
    NotebookCellOutput: class {
      constructor(items, metadata) {
        this.items = items;
        this.metadata = metadata;
      }
    },
    NotebookCellData: class {
      constructor(kind, value, languageId) {
        this.kind = kind;
        this.value = value;
        this.languageId = languageId;
      }
    },
    NotebookData: class {
      constructor(cells) {
        this.cells = cells;
      }
    },
    NotebookCellStatusBarItem: class {
      constructor(text, alignment) {
        this.text = text;
        this.alignment = alignment;
      }
    },
    DebugAdapterExecutable: class {
      constructor(command, args, options) {
        this.command = command;
        this.args = args || [];
        this.options = options;
      }
    },
    DebugAdapterServer: class {
      constructor(port, host) {
        this.port = port;
        this.host = host;
      }
    },
    DebugAdapterNamedPipeServer: class {
      constructor(path) {
        this.path = path;
      }
    },
    DebugAdapterInlineImplementation: class {
      constructor(implementation) {
        this.implementation = implementation;
      }
    },
    Breakpoint: class {
      constructor(enabled, condition, hitCondition, logMessage) {
        this.id = Math.random().toString(36).slice(2);
        this.enabled = enabled !== undefined ? enabled : true;
        this.condition = condition;
        this.hitCondition = hitCondition;
        this.logMessage = logMessage;
      }
    },
    SourceBreakpoint: class {
      constructor(location, enabled, condition, hitCondition, logMessage) {
        this.id = Math.random().toString(36).slice(2);
        this.location = location;
        this.enabled = enabled !== undefined ? enabled : true;
        this.condition = condition;
        this.hitCondition = hitCondition;
        this.logMessage = logMessage;
      }
    },
    FunctionBreakpoint: class {
      constructor(functionName, enabled, condition, hitCondition, logMessage) {
        this.id = Math.random().toString(36).slice(2);
        this.functionName = functionName;
        this.enabled = enabled !== undefined ? enabled : true;
        this.condition = condition;
        this.hitCondition = hitCondition;
        this.logMessage = logMessage;
      }
    },
    TabInputText: class {
      constructor(uri) {
        this.uri = uri;
      }
    },
    TabInputTextDiff: class {
      constructor(original, modified) {
        this.original = original;
        this.modified = modified;
      }
    },
    TabInputCustom: class {
      constructor(uri, viewType) {
        this.uri = uri;
        this.viewType = viewType;
      }
    },
    TabInputWebview: class {
      constructor(viewType) {
        this.viewType = viewType;
      }
    },
    TabInputNotebook: class {
      constructor(uri, notebookType) {
        this.uri = uri;
        this.notebookType = notebookType;
      }
    },
    TabInputNotebookDiff: class {
      constructor(original, modified, notebookType) {
        this.original = original;
        this.modified = modified;
        this.notebookType = notebookType;
      }
    },
    TabInputTerminal: class {
      constructor() {}
    },
    TestTag: class {
      constructor(id) {
        this.id = id;
      }
    },
    TestRunRequest: class {
      constructor(include, exclude, profile, continuous, preserveFocus) {
        this.include = include;
        this.exclude = exclude;
        this.profile = profile;
        this.continuous = continuous;
        this.preserveFocus = preserveFocus !== undefined ? preserveFocus : false;
      }
    },
    TestMessage: class {
      constructor(message) {
        this.message = message;
      }
      static diff(message, expected, actual) {
        const msg = new api.TestMessage(message);
        msg.expectedOutput = expected;
        msg.actualOutput = actual;
        return msg;
      }
    },
    TestCoverageCount: class {
      constructor(covered, total) {
        this.covered = covered;
        this.total = total;
      }
    },
    FileCoverage: class {
      constructor(uri, statementCoverage, branchCoverage, declarationCoverage, includesTests) {
        this.uri = uri;
        this.statementCoverage = statementCoverage;
        this.branchCoverage = branchCoverage;
        this.declarationCoverage = declarationCoverage;
        this.includesTests = includesTests;
      }
      static fromDetails(uri, details) {
        let sCov = 0, sTotal = 0, bCov = 0, bTotal = 0, dCov = 0, dTotal = 0;
        for (const d of details) {
          if (d instanceof api.StatementCoverage) {
            sTotal++;
            if (d.executed) sCov++;
            for (const b of d.branches || []) {
              bTotal++;
              if (b.executed) bCov++;
            }
          } else if (d instanceof api.DeclarationCoverage) {
            dTotal++;
            if (d.executed) dCov++;
          }
        }
        return new api.FileCoverage(uri,
          new api.TestCoverageCount(sCov, sTotal),
          bTotal > 0 ? new api.TestCoverageCount(bCov, bTotal) : undefined,
          dTotal > 0 ? new api.TestCoverageCount(dCov, dTotal) : undefined
        );
      }
    },
    StatementCoverage: class {
      constructor(executed, location, branches) {
        this.executed = executed;
        this.location = location;
        this.branches = branches || [];
      }
    },
    BranchCoverage: class {
      constructor(executed, location, label) {
        this.executed = executed;
        this.location = location;
        this.label = label;
      }
    },
    DeclarationCoverage: class {
      constructor(name, executed, location) {
        this.name = name;
        this.executed = executed;
        this.location = location;
      }
    },
    ChatResponseMarkdownPart: class {
      constructor(value) {
        this.value = typeof value === 'string' ? new api.MarkdownString(value) : value;
      }
    },
    ChatResponseFileTreePart: class {
      constructor(value, baseUri) {
        this.value = value;
        this.baseUri = baseUri;
      }
    },
    ChatResponseAnchorPart: class {
      constructor(value, title) {
        this.value = value;
        this.title = title;
      }
    },
    ChatResponseProgressPart: class {
      constructor(value) {
        this.value = value;
      }
    },
    ChatResponseReferencePart: class {
      constructor(value, iconPath) {
        this.value = value;
        this.iconPath = iconPath;
      }
    },
    ChatResponseCommandButtonPart: class {
      constructor(value) {
        this.value = value;
      }
    },
    LanguageModelChatMessage: class {
      constructor(role, content, name) {
        this.role = role;
        this.content = typeof content === 'string' ? [new api.LanguageModelTextPart(content)] : content;
        this.name = name;
      }
      static User(content, name) {
        return new api.LanguageModelChatMessage(1, content, name);
      }
      static Assistant(content, name) {
        return new api.LanguageModelChatMessage(2, content, name);
      }
    },
    LanguageModelTextPart: class {
      constructor(value) {
        this.value = value;
      }
    },
    LanguageModelToolCallPart: class {
      constructor(callId, name, input) {
        this.callId = callId;
        this.name = name;
        this.input = input;
      }
    },
    LanguageModelToolResultPart: class {
      constructor(callId, content) {
        this.callId = callId;
        this.content = content;
      }
    },
    LanguageModelError: class extends Error {
      constructor(message) {
        super(message);
        this.code = 'Unknown';
      }
      static NoPermissions(message) {
        const err = new api.LanguageModelError(message);
        err.code = 'NoPermissions';
        return err;
      }
      static Blocked(message) {
        const err = new api.LanguageModelError(message);
        err.code = 'Blocked';
        return err;
      }
      static NotFound(message) {
        const err = new api.LanguageModelError(message);
        err.code = 'NotFound';
        return err;
      }
    },
    LanguageModelPromptTsxPart: class {
      constructor(value) {
        this.value = value;
      }
    },
    languages,
    commands,
    workspace,
    window,
    extensions,
    env,
    tasks,
    debug,
    notebooks,
    scm,
    comments,
    authentication,
    tests,
    version: '1.110.0',
    l10n: {
      t: (message, ...args) => {
        let str = typeof message === 'string' ? message : message.message || '';
        if (args.length > 0) {
          if (typeof args[0] === 'object' && !Array.isArray(args[0])) {
            for (const [key, val] of Object.entries(args[0])) {
              str = str.replace(new RegExp(`\\{${key}\\}`, 'g'), String(val));
            }
          } else {
            for (let i = 0; i < args.length; i++) {
              str = str.replace(new RegExp(`\\{${i}\\}`, 'g'), String(args[i]));
            }
          }
        }
        return str;
      },
      bundle: undefined,
      uri: undefined,
    },
    chat: {
      createChatParticipant: (id, handler) => {
        const feedbackEmitter = new VscEventEmitter();
        const participant = {
          id,
          iconPath: undefined,
          requestHandler: handler,
          followupProvider: undefined,
          onDidReceiveFeedback: feedbackEmitter.event,
          dispose() { feedbackEmitter.dispose(); },
        };
        host.emit('event', { type: 'registerChatParticipant', id });
        return participant;
      },
      registerChatOutputRenderer: (mimeType, renderer) => noopDisposable,
      registerChatSessionItemProvider: (id, provider) => noopDisposable,
    },
    lm: {
      selectChatModels: (selector) => Promise.resolve([]),
      registerChatModelProvider: () => noopDisposable,
      get languageModels() { return []; },
      onDidChangeChatModels: noopEvent,
      registerTool: (name, tool) => {
        host.emit('event', { type: 'registerLanguageModelTool', name });
        return noopDisposable;
      },
      get tools() { return []; },
    },
  };

  const unknownApiCache = new Map();
  function createUnknownApi(name) {
    if (unknownApiCache.has(name)) return unknownApiCache.get(name);
    const unknown = new Proxy(function () {}, {
      get(target, prop) {
        if (prop === 'prototype') return target.prototype;
        if (prop === Symbol.toPrimitive) return () => name;
        if (prop === 'toString') return () => name;
        return createUnknownApi(`${name}.${String(prop)}`);
      },
      apply() {
        return undefined;
      },
      construct() {
        return {};
      },
    });
    unknownApiCache.set(name, unknown);
    return unknown;
  }

  return new Proxy(api, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      if (typeof prop === 'string') {
        const fallback = createUnknownApi(`vscode.${prop}`);
        target[prop] = fallback;
        log(`shim fallback for vscode.${prop}`);
        return fallback;
      }
      return undefined;
    },
  });
}

function installVscodeShim() {
  const Module = require('module');
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'vscode') return '__sidex_vscode_shim__';
    return original.call(this, request, parent, isMain, options);
  };
  require.cache['__sidex_vscode_shim__'] = {
    id: '__sidex_vscode_shim__',
    filename: '__sidex_vscode_shim__',
    loaded: true,
    exports: null,
  };
  const hostDir = __dirname;
  const vscDir = path.join(hostDir, 'node_modules', 'vscode');
  try {
    fs.mkdirSync(vscDir, { recursive: true });
    fs.writeFileSync(path.join(vscDir, 'package.json'), JSON.stringify({
      name: 'vscode',
      version: '1.110.0',
      main: 'index.cjs',
    }));
    fs.writeFileSync(path.join(vscDir, 'index.cjs'), "module.exports = globalThis.__sidex_vscode_shim__ || require('__sidex_vscode_shim__');");
  } catch {}
}

installVscodeShim();
hostInstance = new ExtensionHost();
const _vscodeShim = createVscodeShim();
globalThis.__sidex_vscode_shim__ = _vscodeShim;
require.cache['__sidex_vscode_shim__'].exports = _vscodeShim;

try {
  const { register } = require('module');
  if (typeof register === 'function') {
    const hostCjsPath = path.resolve(__dirname, 'host.cjs');
    const shimExports = require.cache['__sidex_vscode_shim__']?.exports;
    const namedKeys = shimExports ? Object.keys(shimExports).filter(k => k !== 'default' && k !== '__esModule') : [];
    const esmLines = [
      `import { createRequire } from 'node:module';`,
      `import { fileURLToPath } from 'node:url';`,
      `const _require = createRequire(${JSON.stringify(hostCjsPath)});`,
      `const _shim = globalThis.__sidex_vscode_shim__ || _require('__sidex_vscode_shim__');`,
      `export default _shim;`,
      ...namedKeys.map(k => `export const ${k} = _shim.${k};`),
    ];
    const esmPath = path.join(__dirname, 'node_modules', 'vscode', 'index.mjs');
    fs.writeFileSync(esmPath, esmLines.join('\n'));
    const esmUrl = `file://${esmPath.replace(/\\/g, '/')}`;

    const loaderSrc = [
      `const ESM_URL = ${JSON.stringify(esmUrl)};`,
      `export async function resolve(specifier, context, nextResolve) {`,
      `  if (specifier === 'vscode') return { url: ESM_URL, shortCircuit: true };`,
      `  return nextResolve(specifier, context);`,
      `}`,
    ].join('\n');
    register(`data:text/javascript,${encodeURIComponent(loaderSrc)}`);
  }
} catch {}


if (process.env.SIDEX_EXTENSION_HOST === 'true' && process.send) {
  const host = hostInstance;
  host.initialize();

  let initData = null;
  try {
    if (process.env.SIDEX_INIT_DATA_FILE) {
      const raw = require('fs').readFileSync(process.env.SIDEX_INIT_DATA_FILE, 'utf8');
      initData = JSON.parse(raw);
      try { require('fs').unlinkSync(process.env.SIDEX_INIT_DATA_FILE); } catch {}
    } else if (process.env.SIDEX_INIT_DATA) {
      initData = JSON.parse(process.env.SIDEX_INIT_DATA);
    }
  } catch (e) {
    log(`failed to parse init data: ${e.message}`);
  }

  if (initData && initData.extensions) {
    const skipPrefixes = [
      'anysphere.cursor',
      'cursor.',
      'GitHub.copilot',
      'sswg.swift-lang',
      'vscode.github-authentication',
      'vscode.microsoft-authentication',
    ];
    for (const ext of initData.extensions) {
      const extPath = uriPathToFsPath(ext.extensionLocation?.path || ext.location?.path);
      if (!extPath) continue;
      try {
        const manifest = host._readManifest(extPath);
        if (skipPrefixes.some(p => manifest.id.startsWith(p))) continue;
        const configs = manifest.contributes?.configuration;
        if (configs) {
          const sections = Array.isArray(configs) ? configs : [configs];
          for (const section of sections) {
            const props = section.properties;
            if (!props) continue;
            for (const [key, schema] of Object.entries(props)) {
              if (schema && 'default' in schema && !host._configuration.has(key)) {
                host._configuration.set(key, schema.default);
              }
            }
          }
        }
        host._extensions.set(manifest.id, {
          manifest,
          extensionPath: extPath,
          module: null,
          context: null,
          exports: null,
          activated: false,
        });
        const activationEvents = manifest.activationEvents || [];
        if (
          activationEvents.includes('*') ||
          activationEvents.length === 0
        ) {
          host._activateExtension(manifest.id).catch((e) => {
            log(`auto-activate failed ${manifest.id}: ${e.message}`);
          });
        }
      } catch (e) {
        log(`load extension failed ${extPath}: ${e.message}`);
      }
    }
  }

  setTimeout(() => {
    host._checkActivationEvents('onStartupFinished');
    for (const [extId, ext] of host._extensions) {
      if (ext.activated) continue;
      const events = ext.manifest.activationEvents || [];
      for (const ev of events) {
        if (!ev.startsWith('workspaceContains:')) continue;
        const pattern = ev.substring('workspaceContains:'.length);
        for (const folder of host._workspaceFolders) {
          try {
            const entries = fs.readdirSync(folder);
            const match = entries.some((e) => {
              if (pattern.includes('*')) {
                const re = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
                return re.test(e);
              }
              return e === pattern;
            });
            if (match) {
              host._activateExtension(extId).catch((e) => log(`workspaceContains activate error (${extId}): ${e.message}`));
              break;
            }
          } catch {}
        }
      }
    }
  }, 500);

  host.on('event', (event) => {
    if (process.send) {
      process.send({ type: 'sidex:host-event', event });
    }
  });

  process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    host.emit('inbound', msg);
    const reply = host.handleMessage(msg);
    if (reply && typeof reply.then === 'function') {
      reply.then((r) => {
        if (r && process.send) process.send({ type: 'sidex:host-reply', reply: r });
      }).catch(() => {});
    } else if (reply && process.send) {
      process.send({ type: 'sidex:host-reply', reply });
    }
  });

  process.send({ type: 'VSCODE_EXTHOST_IPC_READY' });
  log('extension host process running in IPC mode');
} else {
  module.exports = hostInstance;
}
