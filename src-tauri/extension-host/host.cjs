'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const crypto = require('crypto');

class ExtensionHost extends EventEmitter {
  constructor() {
    super();
    this._extensions = new Map();
    this._diagnostics = new Map();
    this._commands = new Map();
    this._providers = { completion: [], hover: [], definition: [], references: [], documentSymbol: [], codeAction: [], codeLens: [], formatting: [], rangeFormatting: [], signatureHelp: [], documentHighlight: [], rename: [], documentLink: [], foldingRange: [], selectionRange: [], inlayHint: [], typeDefinition: [], implementation: [], declaration: [], color: [], onTypeFormatting: [], semanticTokens: [], workspaceSymbol: [] };
    this._reqId = 0;
    this._pendingRequests = new Map();
    this._disposables = [];
    this._extensionPaths = [];
    this._outputChannels = new Map();
    this._textDocuments = new Map();
    this._workspaceFolders = [];
    this._configuration = new Map();
    this._activeEditorUri = null;
    this._activeEditorLanguageId = null;
    this._activeEditorSelections = [];
    this._languageConfigurations = new Map();
    this._fileWatchers = new Map();
    this._nextWatcherId = 1;
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

  // ── Message router (called by server.js) ──────────────────────────

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
      default:
        return { id, error: `unknown method: ${type || method}` };
    }
  }

  // ── Protocol handlers ─────────────────────────────────────────────

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
          'completionProvider', 'hoverProvider', 'definitionProvider',
          'referencesProvider', 'documentSymbolProvider', 'diagnostics',
          'commands', 'codeActionProvider', 'codeLensProvider',
          'formattingProvider', 'signatureHelpProvider', 'renameProvider',
          'documentHighlightProvider', 'typeDefinitionProvider',
          'implementationProvider', 'foldingRangeProvider', 'inlayHintProvider',
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
            discovered.push({ id: manifest.id, name: manifest.name, path: extDir, activationEvents: manifest.activationEvents });
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
      this._extensions.set(manifest.id, {
        manifest, extensionPath,
        module: null, context: null, exports: null, activated: false,
      });
      return { id, result: { extensionId: manifest.id, name: manifest.name } };
    } catch (e) {
      return { id, error: e.message };
    }
  }

  _handleActivateExtension(id, params) {
    try {
      const { extensionId } = params;
      this._activateExtension(extensionId);
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

  _handleExecuteCommand(id, params) {
    const { command, args } = params;
    const handler = this._commands.get(command);
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
      contentChanges: (changes || []).map(c => ({
        range: c.range ? new VscRange(c.range.start.line, c.range.start.character, c.range.end.line, c.range.end.character) : undefined,
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
    const { uri, languageId, selections } = params;
    this._activeEditorUri = uri || null;
    this._activeEditorLanguageId = languageId || null;
    this._activeEditorSelections = selections || [];
    this._onActiveEditorChangeEvent?.fire(uri ? this._makeTextEditorProxy(uri) : undefined);
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
    const patternStr = typeof pattern === 'string' ? pattern : (pattern.pattern || String(pattern));
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
    const selections = (this._activeEditorSelections || []).map(s =>
      new VscSelection(s.anchor?.line ?? 0, s.anchor?.character ?? 0, s.active?.line ?? 0, s.active?.character ?? 0));
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
        const builder = {
          replace(loc, val) { edits.push({ range: loc instanceof VscRange ? loc : new VscRange(loc, loc), newText: val }); },
          insert(pos, val) { edits.push({ range: new VscRange(pos, pos), newText: val }); },
          delete(range) { edits.push({ range, newText: '' }); },
          setEndOfLine() {},
        };
        callback(builder);
        if (edits.length) {
          const we = new (require('./host.cjs').__WorkspaceEdit || Object)();
          for (const e of edits) { if (we.replace) we.replace(doc.uri, e.range, e.newText); }
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

  _handleSetConfiguration(id, params) {
    if (params && params.settings) {
      for (const [k, v] of Object.entries(params.settings)) {
        this._configuration.set(k, v);
      }
      this._onConfigChangeEvent?.fire({
        affectsConfiguration: (section) => {
          return Object.keys(params.settings).some(k => k === section || k.startsWith(section + '.'));
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
    const doc = this._makeDocumentProxy(params.uri || params.textDocument?.uri);
    const pos = params.position ? new VscPosition(params.position.line, params.position.character) : new VscPosition(0, 0);
    const token = { isCancellationRequested: false };
    const newName = params.newName || '';
    const promises = providers.filter(p => this._matchSelector(p.selector, doc)).map(p => {
      try { return Promise.resolve(p.provider.provideRenameEdits(doc, pos, newName, token)); }
      catch (e) { return Promise.resolve(null); }
    });
    Promise.all(promises).then(results => {
      const edits = [];
      for (const r of results) {
        if (!r) continue;
        if (r._edits) edits.push(...r._edits.map(e => ({ uri: e.uri?.toString?.() || '', range: e.range, newText: e.newText })));
      }
      this.emit('event', { id, result: { edits } });
    }).catch(e => this.emit('event', { id, error: e.message }));
    return undefined;
  }

  _handlePrepareRename(id, params) {
    const providers = this._providers.rename || [];
    if (!providers.length) return { id, result: null };
    const doc = this._makeDocumentProxy(params.uri || params.textDocument?.uri);
    const pos = params.position ? new VscPosition(params.position.line, params.position.character) : new VscPosition(0, 0);
    const token = { isCancellationRequested: false };
    const provider = providers.find(p => this._matchSelector(p.selector, doc));
    if (!provider || !provider.provider.prepareRename) return { id, result: null };
    Promise.resolve(provider.provider.prepareRename(doc, pos, token)).then(r => {
      if (!r) return this.emit('event', { id, result: null });
      if (r.range) this.emit('event', { id, result: { range: r.range, placeholder: r.placeholder || '' } });
      else this.emit('event', { id, result: { range: r, placeholder: '' } });
    }).catch(e => this.emit('event', { id, error: e.message }));
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
    for (const [u, diags] of this._diagnostics) { all.push([u, diags]); }
    return { id, result: all };
  }

  _handleGetProviderCapabilities(id) {
    const capabilities = {};
    for (const [kind, providers] of Object.entries(this._providers)) {
      if (providers.length > 0) {
        capabilities[kind] = providers.map(p => p.selector);
      }
    }
    return { id, result: capabilities };
  }

  _invokeProviders(kind, id, params) {
    const providers = this._providers[kind] || [];
    if (!providers.length) {
      const empty = (kind === 'hover' || kind === 'definition' || kind === 'typeDefinition' || kind === 'implementation' || kind === 'declaration') ? null : [];
      return { id, result: kind === 'completion' ? { items: [] } : empty };
    }
    const doc = this._makeDocumentProxy(params.uri || params.textDocument?.uri);
    const pos = params.position ? new VscPosition(params.position.line, params.position.character) : new VscPosition(0, 0);
    const token = { isCancellationRequested: false };

    const providerFnMap = {
      completion: (p) => p.provideCompletionItems(doc, pos, token, { triggerKind: 0, triggerCharacter: params.triggerCharacter }),
      hover: (p) => p.provideHover(doc, pos, token),
      definition: (p) => p.provideDefinition(doc, pos, token),
      typeDefinition: (p) => p.provideTypeDefinition(doc, pos, token),
      implementation: (p) => p.provideImplementation(doc, pos, token),
      declaration: (p) => p.provideDeclaration(doc, pos, token),
      references: (p) => p.provideReferences(doc, pos, { includeDeclaration: true }, token),
      documentSymbol: (p) => p.provideDocumentSymbols(doc, token),
      codeAction: (p) => {
        const range = params.range
          ? new VscRange(params.range.start.line, params.range.start.character, params.range.end.line, params.range.end.character)
          : new VscRange(pos, pos);
        const diagnostics = (params.context?.diagnostics || []).map(d => new (require('./host.cjs').Diagnostic || Object)(d.range, d.message, d.severity));
        return p.provideCodeActions(doc, range, { diagnostics, triggerKind: params.context?.triggerKind || 1, only: params.context?.only }, token);
      },
      codeLens: (p) => p.provideCodeLenses(doc, token),
      formatting: (p) => p.provideDocumentFormattingEdits(doc, params.options || { tabSize: 4, insertSpaces: true }, token),
      rangeFormatting: (p) => {
        const range = params.range
          ? new VscRange(params.range.start.line, params.range.start.character, params.range.end.line, params.range.end.character)
          : new VscRange(0, 0, 0, 0);
        return p.provideDocumentRangeFormattingEdits(doc, range, params.options || { tabSize: 4, insertSpaces: true }, token);
      },
      signatureHelp: (p) => p.provideSignatureHelp(doc, pos, token, { triggerKind: 1, isRetrigger: false }),
      documentHighlight: (p) => p.provideDocumentHighlights(doc, pos, token),
      documentLink: (p) => p.provideDocumentLinks(doc, token),
      foldingRange: (p) => p.provideFoldingRanges(doc, {}, token),
      selectionRange: (p) => {
        const positions = params.positions ? params.positions.map(pp => new VscPosition(pp.line, pp.character)) : [pos];
        return p.provideSelectionRanges(doc, positions, token);
      },
      inlayHint: (p) => {
        const range = params.range
          ? new VscRange(params.range.start.line, params.range.start.character, params.range.end.line, params.range.end.character)
          : new VscRange(0, 0, doc.lineCount, 0);
        return p.provideInlayHints(doc, range, token);
      },
      color: (p) => p.provideDocumentColors(doc, token),
      semanticTokens: (p) => p.provideDocumentSemanticTokens(doc, token),
      workspaceSymbol: (p) => p.provideWorkspaceSymbols(params.query || '', token),
    };

    const callFn = providerFnMap[kind];
    if (!callFn) return { id, result: null };

    const promises = providers.filter(p => this._matchSelector(p.selector, doc)).map(p => {
      try { return Promise.resolve(callFn(p.provider)); }
      catch (e) { return Promise.resolve(null); }
    });

    Promise.all(promises).then(results => {
      let merged = kind === 'completion' ? { items: [] }
        : (kind === 'hover' || kind === 'definition' || kind === 'typeDefinition' || kind === 'implementation' || kind === 'declaration' || kind === 'signatureHelp') ? null
        : [];
      for (const r of results) {
        if (!r) continue;
        if (kind === 'completion') {
          const items = Array.isArray(r) ? r : (r.items || []);
          merged.items.push(...items.map(serializeCompletionItem));
        } else if (kind === 'hover') {
          merged = serializeHover(r);
        } else if (kind === 'documentSymbol') {
          const items = Array.isArray(r) ? r : [];
          merged = (merged || []).concat(items.map(serializeDocumentSymbol));
        } else if (kind === 'codeAction') {
          const items = Array.isArray(r) ? r : [];
          merged = (merged || []).concat(items.map(a => ({
            title: a.title, kind: typeof a.kind === 'string' ? a.kind : a.kind?.value,
            diagnostics: a.diagnostics || [], isPreferred: a.isPreferred || false,
            edit: a.edit ? { edits: (a.edit._edits || []).map(e => ({ uri: e.uri?.toString?.() || '', range: e.range, newText: e.newText })) } : undefined,
            command: a.command,
          })));
        } else if (kind === 'codeLens') {
          const items = Array.isArray(r) ? r : [];
          merged = (merged || []).concat(items.map(l => ({ range: l.range, command: l.command })));
        } else if (kind === 'formatting' || kind === 'rangeFormatting') {
          const items = Array.isArray(r) ? r : [];
          merged = (merged || []).concat(items.map(e => ({ range: e.range, newText: e.newText })));
        } else if (kind === 'signatureHelp') {
          merged = r ? {
            signatures: (r.signatures || []).map(s => ({ label: s.label, documentation: s.documentation, parameters: s.parameters })),
            activeSignature: r.activeSignature ?? 0,
            activeParameter: r.activeParameter ?? 0,
          } : null;
        } else if (kind === 'documentHighlight') {
          const items = Array.isArray(r) ? r : [];
          merged = (merged || []).concat(items.map(h => ({ range: h.range, kind: h.kind ?? 0 })));
        } else if (kind === 'documentLink') {
          const items = Array.isArray(r) ? r : [];
          merged = (merged || []).concat(items.map(l => ({ range: l.range, target: l.target?.toString?.() || '' })));
        } else if (kind === 'foldingRange') {
          const items = Array.isArray(r) ? r : [];
          merged = (merged || []).concat(items.map(f => ({ start: f.start, end: f.end, kind: f.kind })));
        } else if (kind === 'selectionRange') {
          merged = Array.isArray(r) ? r.map(serializeSelectionRange) : merged;
        } else if (kind === 'inlayHint') {
          const items = Array.isArray(r) ? r : [];
          merged = (merged || []).concat(items.map(h => ({ position: h.position, label: typeof h.label === 'string' ? h.label : h.label?.map?.(p => ({ value: p.value || '' })) || '', kind: h.kind, paddingLeft: h.paddingLeft, paddingRight: h.paddingRight })));
        } else if (kind === 'color') {
          const items = Array.isArray(r) ? r : [];
          merged = (merged || []).concat(items.map(c => ({ range: c.range, color: { red: c.color.red, green: c.color.green, blue: c.color.blue, alpha: c.color.alpha } })));
        } else if (kind === 'semanticTokens') {
          if (r && r.data) merged = { data: Array.from(r.data), resultId: r.resultId };
        } else if (kind === 'workspaceSymbol') {
          const items = Array.isArray(r) ? r : [];
          merged = (merged || []).concat(items.map(s => ({ name: s.name, kind: s.kind, location: serializeLocation(s.location) })));
        } else if (Array.isArray(r)) {
          merged = (merged || []).concat(r.map(serializeLocation));
        } else {
          merged = serializeLocation(r);
        }
      }
      this.emit('event', { id, result: merged });
    }).catch(e => {
      this.emit('event', { id, error: e.message });
    });
    return undefined;
  }

  _matchSelector(selector, doc) {
    if (!selector) return true;
    const sel = typeof selector === 'string' ? [{ language: selector }] : (Array.isArray(selector) ? selector : [selector]);
    return sel.some(s => {
      if (typeof s === 'string') return s === doc.languageId || s === '*';
      return (!s.language || s.language === doc.languageId || s.language === '*') &&
             (!s.scheme || s.scheme === 'file' || s.scheme === '*');
    });
  }

  _makeDocumentProxy(uri) {
    const stored = this._textDocuments.get(uri);
    const text = stored ? stored.text : '';
    const lines = text.split('\n');
    return {
      uri: VscUri.parse(uri || 'file:///untitled'),
      fileName: uri ? uri.replace(/^file:\/\//, '') : '',
      languageId: stored ? stored.languageId : 'plaintext',
      version: stored ? stored.version : 1,
      lineCount: lines.length,
      getText: (range) => {
        if (!range) return text;
        const toOffset = (line, char) => {
          let off = 0;
          for (let i = 0; i < line && i < lines.length; i++) off += lines[i].length + 1;
          return off + Math.min(char, (lines[line] || '').length);
        };
        return text.substring(toOffset(range.start.line, range.start.character), toOffset(range.end.line, range.end.character));
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
        return { lineNumber: ln, text: t, range: new VscRange(ln, 0, ln, t.length), firstNonWhitespaceCharacterIndex: t.search(/\S/), isEmptyOrWhitespace: t.trim().length === 0 };
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
      isDirty: false, isUntitled: false, isClosed: false, eol: 1,
      save: () => Promise.resolve(true),
    };
  }

  _checkActivationEvents(event) {
    for (const [extId, ext] of this._extensions) {
      if (ext.activated) continue;
      const events = ext.manifest.activationEvents || [];
      if (events.includes(event) || events.includes('*') || events.includes('onStartupFinished')) {
        try { this._activateExtension(extId); } catch (e) { log(`activation error (${extId}): ${e.message}`); }
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
      main: raw.main,
      activationEvents: raw.activationEvents || [],
      contributes: raw.contributes || {},
      extensionDependencies: raw.extensionDependencies || [],
    };
  }

  _activateExtension(extensionId) {
    const ext = this._extensions.get(extensionId);
    if (!ext) throw new Error(`extension not found: ${extensionId}`);
    if (ext.activated) return;
    if (!ext.manifest.main) { ext.activated = true; return; }

    const mainPath = path.resolve(ext.extensionPath, ext.manifest.main);
    if (!fs.existsSync(mainPath) && !fs.existsSync(mainPath + '.js')) {
      log(`main not found: ${mainPath}`);
      ext.activated = true;
      return;
    }

    const context = this._createExtensionContext(extensionId, ext.extensionPath);
    try {
      const mod = require(mainPath);
      ext.module = mod;
      ext.context = context;
      if (typeof mod.activate === 'function') {
        const result = mod.activate(context);
        if (result && typeof result.then === 'function') {
          result.then(r => { ext.exports = r || mod; }).catch(e => log(`async activate error (${extensionId}): ${e.message}`));
        } else {
          ext.exports = result || mod;
        }
      } else {
        ext.exports = mod;
      }
      ext.activated = true;
      log(`activated ${extensionId}`);
      this.emit('event', { type: 'extensionActivated', extensionId });
    } catch (e) {
      log(`activate error (${extensionId}): ${e.stack || e.message}`);
      throw e;
    }
  }

  _createExtensionContext(extensionId, extensionPath) {
    const subscriptions = [];
    const storagePath = path.join(extensionPath, '.storage');
    const globalStoragePath = path.join(extensionPath, '.global-storage');
    try { fs.mkdirSync(storagePath, { recursive: true }); } catch {}
    try { fs.mkdirSync(globalStoragePath, { recursive: true }); } catch {}

    const secrets = new Map();
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
      workspaceState: createMemento(),
      globalState: createMemento(),
      secrets: {
        get: (key) => Promise.resolve(secrets.get(key)),
        store: (key, value) => { secrets.set(key, value); return Promise.resolve(); },
        delete: (key) => { secrets.delete(key); return Promise.resolve(); },
        onDidChange: noopEvent,
      },
      environmentVariableCollection: {
        persistent: true,
        description: '',
        replace: () => {}, append: () => {}, prepend: () => {},
        get: () => undefined, forEach: () => {}, delete: () => {}, clear: () => {},
        [Symbol.iterator]: function* () {},
      },
      extension: {
        id: extensionId, extensionUri: VscUri.file(extensionPath),
        extensionPath, isActive: true, packageJSON: {},
        extensionKind: 1, exports: undefined,
      },
      languageModelAccessInformation: { onDidChange: noopEvent, canSendRequest: () => undefined },
    };
  }

  _registerBuiltinCommands() {
    this._commands.set('sidex.extHost.ping', () => 'pong');
    this._commands.set('sidex.extHost.listLoaded', () => {
      const list = [];
      for (const [id, ext] of this._extensions) list.push({ id, activated: ext.activated });
      return list;
    });
  }
}

// ── Helpers used by both the host class and the shim ────────────────────

function log(msg) { process.stderr.write(`[ext-host] ${msg}\n`); }

const noopDisposable = { dispose() {} };
const noopEvent = (_listener) => noopDisposable;

function createMemento() {
  const store = new Map();
  return {
    keys: () => [...store.keys()],
    get: (key, defaultValue) => store.has(key) ? store.get(key) : defaultValue,
    update: (key, value) => { store.set(key, value); return Promise.resolve(); },
    setKeysForSync: () => {},
  };
}

function serializeCompletionItem(item) {
  return { label: typeof item.label === 'string' ? item.label : item.label?.label || '', kind: item.kind, detail: item.detail, insertText: typeof item.insertText === 'string' ? item.insertText : item.insertText?.value, documentation: typeof item.documentation === 'string' ? item.documentation : item.documentation?.value, sortText: item.sortText, filterText: item.filterText };
}
function serializeHover(h) {
  if (!h) return null;
  const contents = Array.isArray(h.contents) ? h.contents : [h.contents];
  return { contents: contents.map(c => typeof c === 'string' ? c : (c && c.value) || ''), range: h.range };
}
function serializeLocation(loc) {
  if (!loc) return null;
  return { uri: loc.uri?.toString?.() || '', range: loc.range };
}
function serializeDocumentSymbol(s) {
  return {
    name: s.name, kind: s.kind, detail: s.detail || '',
    range: s.range, selectionRange: s.selectionRange || s.range,
    children: (s.children || []).map(serializeDocumentSymbol),
  };
}
function serializeSelectionRange(sr) {
  if (!sr) return null;
  return { range: sr.range, parent: sr.parent ? serializeSelectionRange(sr.parent) : undefined };
}

// ── VSCode API types (used globally so host class can reference them) ───

class VscPosition {
  constructor(line, character) { this.line = line; this.character = character; }
  isEqual(o) { return this.line === o.line && this.character === o.character; }
  isBefore(o) { return this.line < o.line || (this.line === o.line && this.character < o.character); }
  isAfter(o) { return !this.isEqual(o) && !this.isBefore(o); }
  translate(lineDelta, charDelta) { return new VscPosition(this.line + (lineDelta || 0), this.character + (charDelta || 0)); }
  with(line, character) { return new VscPosition(line ?? this.line, character ?? this.character); }
  compareTo(o) { return this.isBefore(o) ? -1 : this.isAfter(o) ? 1 : 0; }
}

class VscRange {
  constructor(startLine, startChar, endLine, endChar) {
    if (startLine instanceof VscPosition) { this.start = startLine; this.end = startChar; }
    else { this.start = new VscPosition(startLine, startChar); this.end = new VscPosition(endLine, endChar); }
  }
  get isEmpty() { return this.start.isEqual(this.end); }
  get isSingleLine() { return this.start.line === this.end.line; }
  contains(posOrRange) {
    if (posOrRange instanceof VscPosition || (posOrRange && posOrRange.line !== undefined && posOrRange.character !== undefined && !posOrRange.start)) {
      const p = posOrRange;
      return (p.line > this.start.line || (p.line === this.start.line && p.character >= this.start.character)) &&
             (p.line < this.end.line || (p.line === this.end.line && p.character <= this.end.character));
    }
    const r = posOrRange;
    return this.contains(r.start) && this.contains(r.end);
  }
  isEqual(o) { return this.start.isEqual(o.start) && this.end.isEqual(o.end); }
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
  with(start, end) { return new VscRange(start || this.start, end || this.end); }
}

class VscSelection extends VscRange {
  constructor(anchorLine, anchorChar, activeLine, activeChar) {
    if (anchorLine instanceof VscPosition) { super(anchorLine, anchorChar); this.anchor = anchorLine; this.active = anchorChar; }
    else { super(anchorLine, anchorChar, activeLine, activeChar); this.anchor = this.start; this.active = this.end; }
  }
  get isReversed() { return this.anchor.isAfter(this.active); }
}

class VscUri {
  constructor(scheme, authority, p, query, fragment) {
    this.scheme = scheme || 'file'; this.authority = authority || '';
    this.path = p || ''; this.query = query || ''; this.fragment = fragment || '';
    this.fsPath = this.scheme === 'file' ? this.path : '';
  }
  static file(p) { return new VscUri('file', '', p); }
  static parse(s) {
    try { const u = new URL(s); return new VscUri(u.protocol.replace(':', ''), u.host, u.pathname, u.search.slice(1), u.hash.slice(1)); }
    catch { return new VscUri('file', '', s); }
  }
  static from(components) { return new VscUri(components.scheme, components.authority, components.path, components.query, components.fragment); }
  static joinPath(base, ...segments) { return new VscUri(base.scheme, base.authority, path.posix.join(base.path, ...segments)); }
  static isUri(thing) { return thing instanceof VscUri || (thing && typeof thing.scheme === 'string' && typeof thing.path === 'string'); }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
  toJSON() { return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment, fsPath: this.fsPath }; }
  with(change) { return new VscUri(change.scheme ?? this.scheme, change.authority ?? this.authority, change.path ?? this.path, change.query ?? this.query, change.fragment ?? this.fragment); }
}

// ── Fake `vscode` module ────────────────────────────────────────────────

let hostInstance = null;

function createVscodeShim() {
  const host = hostInstance;

  const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
  const CompletionItemKind = { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17, Folder: 18, EnumMember: 19, Constant: 20, Struct: 21, Event: 22, Operator: 23, TypeParameter: 24 };
  const CompletionTriggerKind = { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 };
  const SymbolKind = { File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15, Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21, Struct: 22, Event: 23, Operator: 24, TypeParameter: 25 };
  const DocumentHighlightKind = { Text: 0, Read: 1, Write: 2 };
  const CodeActionKind = { Empty: '', QuickFix: 'quickfix', Refactor: 'refactor', RefactorExtract: 'refactor.extract', RefactorInline: 'refactor.inline', RefactorRewrite: 'refactor.rewrite', Source: 'source', SourceOrganizeImports: 'source.organizeImports', SourceFixAll: 'source.fixAll' };
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
    constructor(range, newText) { this.range = range; this.newText = newText; }
    static replace(range, newText) { return new TextEdit(range, newText); }
    static insert(position, newText) { return new TextEdit(new VscRange(position, position), newText); }
    static delete(range) { return new TextEdit(range, ''); }
    static setEndOfLine() { return new TextEdit(new VscRange(0,0,0,0), ''); }
  }

  class WorkspaceEdit {
    constructor() { this._edits = []; }
    replace(uri, range, newText) { this._edits.push({ uri, range, newText }); }
    insert(uri, position, newText) { this._edits.push({ uri, range: new VscRange(position, position), newText }); }
    delete(uri, range) { this._edits.push({ uri, range, newText: '' }); }
    has(uri) { return this._edits.some(e => e.uri?.toString() === uri?.toString()); }
    set(uri, edits) { this._edits = this._edits.filter(e => e.uri?.toString() !== uri?.toString()); edits.forEach(e => this._edits.push({ uri, ...e })); }
    get size() { return this._edits.length; }
    entries() {
      const map = new Map();
      for (const e of this._edits) {
        const key = e.uri?.toString() || '';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(new TextEdit(e.range, e.newText));
      }
      return [...map.entries()].map(([k, v]) => [VscUri.parse(k), v]);
    }
    renameFile(oldUri, newUri, options) { this._edits.push({ _type: 'rename', oldUri, newUri, options }); }
    createFile(uri, options) { this._edits.push({ _type: 'create', uri, options }); }
    deleteFile(uri, options) { this._edits.push({ _type: 'delete', uri, options }); }
  }

  class Hover { constructor(contents, range) { this.contents = Array.isArray(contents) ? contents : [contents]; this.range = range; } }
  class Location { constructor(uri, rangeOrPos) { this.uri = uri; this.range = rangeOrPos; } }
  class Diagnostic {
    constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity ?? DiagnosticSeverity.Error; this.source = ''; this.code = ''; this.relatedInformation = []; this.tags = []; }
  }
  class DiagnosticRelatedInformation { constructor(location, message) { this.location = location; this.message = message; } }
  class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } }
  class CompletionList { constructor(items, isIncomplete) { this.items = items || []; this.isIncomplete = !!isIncomplete; } }
  class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; this.diagnostics = []; this.isPreferred = false; } }
  class CodeLens { constructor(range, command) { this.range = range; this.command = command; this.isResolved = !!command; } }
  class DocumentSymbol { constructor(name, detail, kind, range, selectionRange) { this.name = name; this.detail = detail; this.kind = kind; this.range = range; this.selectionRange = selectionRange; this.children = []; } }
  class SymbolInformation { constructor(name, kind, range, uri) { this.name = name; this.kind = kind; this.location = new Location(uri, range); } }
  class FoldingRange { constructor(start, end, kind) { this.start = start; this.end = end; this.kind = kind; } }
  class SelectionRange { constructor(range, parent) { this.range = range; this.parent = parent; } }
  class CallHierarchyItem { constructor(kind, name, detail, uri, range, selectionRange) { this.kind = kind; this.name = name; this.detail = detail; this.uri = uri; this.range = range; this.selectionRange = selectionRange; } }
  class TypeHierarchyItem { constructor(kind, name, detail, uri, range, selectionRange) { this.kind = kind; this.name = name; this.detail = detail; this.uri = uri; this.range = range; this.selectionRange = selectionRange; } }
  class DocumentLink { constructor(range, target) { this.range = range; this.target = target; } }
  class Color { constructor(red, green, blue, alpha) { this.red = red; this.green = green; this.blue = blue; this.alpha = alpha; } }
  class ColorInformation { constructor(range, color) { this.range = range; this.color = color; } }
  class ColorPresentation { constructor(label) { this.label = label; } }
  class InlayHint { constructor(position, label, kind) { this.position = position; this.label = label; this.kind = kind; } }
  class SnippetString { constructor(value) { this.value = value || ''; } appendText(s) { this.value += s; return this; } appendPlaceholder(fn, num) { this.value += `\${${num || 1}:}`; return this; } appendTabstop(num) { this.value += `\$${num || 0}`; return this; } }
  class MarkdownString { constructor(value, supportThemeIcons) { this.value = value || ''; this.isTrusted = false; this.supportThemeIcons = !!supportThemeIcons; this.supportHtml = false; } appendText(v) { this.value += v; return this; } appendMarkdown(v) { this.value += v; return this; } appendCodeblock(code, lang) { this.value += `\n\`\`\`${lang||''}\n${code}\n\`\`\`\n`; return this; } }
  class ThemeColor { constructor(id) { this.id = id; } }
  class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } static get File() { return new ThemeIcon('file'); } static get Folder() { return new ThemeIcon('folder'); } }
  class TreeItem { constructor(labelOrUri, collapsibleState) { if (typeof labelOrUri === 'string') { this.label = labelOrUri; } else { this.resourceUri = labelOrUri; } this.collapsibleState = collapsibleState || TreeItemCollapsibleState.None; } }
  class SemanticTokensLegend { constructor(tokenTypes, tokenModifiers) { this.tokenTypes = tokenTypes; this.tokenModifiers = tokenModifiers || []; } }
  class SemanticTokensBuilder { constructor(legend) { this._legend = legend; this._data = []; } push(line, char, length, tokenType, tokenModifiers) { this._data.push(line, char, length, tokenType, tokenModifiers || 0); } build() { return { data: new Uint32Array(this._data) }; } }
  class SemanticTokens { constructor(data, resultId) { this.data = data; this.resultId = resultId; } }
  class SignatureHelp { constructor() { this.signatures = []; this.activeSignature = 0; this.activeParameter = 0; } }
  class SignatureInformation { constructor(label, documentation) { this.label = label; this.documentation = documentation; this.parameters = []; } }
  class ParameterInformation { constructor(label, documentation) { this.label = label; this.documentation = documentation; } }
  class DocumentHighlight { constructor(range, kind) { this.range = range; this.kind = kind || DocumentHighlightKind.Text; } }

  class VscEventEmitter {
    constructor() { this._listeners = []; }
    get event() { const self = this; return (listener, thisArg, disposables) => { const bound = thisArg ? listener.bind(thisArg) : listener; self._listeners.push(bound); const d = { dispose() { const i = self._listeners.indexOf(bound); if (i >= 0) self._listeners.splice(i, 1); } }; if (disposables) disposables.push(d); return d; }; }
    fire(data) { for (const fn of this._listeners.slice()) { try { fn(data); } catch (e) { log(`event error: ${e.message}`); } } }
    dispose() { this._listeners.length = 0; }
  }

  host._onDocumentEvent = new VscEventEmitter();
  host._onDocumentChangeEvent = new VscEventEmitter();
  host._onDocumentCloseEvent = new VscEventEmitter();
  host._onDocumentSaveEvent = new VscEventEmitter();
  host._onConfigChangeEvent = new VscEventEmitter();
  host._onDiagnosticsChangeEvent = new VscEventEmitter();
  host._onActiveEditorChangeEvent = new VscEventEmitter();

  const diagnosticCollections = new Map();

  class DiagnosticCollection {
    constructor(name) { this.name = name; this._entries = new Map(); }
    set(uri, diagnostics) {
      const key = typeof uri === 'string' ? uri : uri.toString();
      this._entries.set(key, diagnostics || []);
      host._diagnostics.set(key, (diagnostics || []).map(d => ({ range: d.range, message: d.message, severity: d.severity, source: d.source, code: d.code })));
      host.emit('event', { type: 'diagnosticsChanged', uri: key, diagnostics: host._diagnostics.get(key) });
      host._onDiagnosticsChangeEvent.fire({ uris: [VscUri.parse(key)] });
    }
    delete(uri) { const key = typeof uri === 'string' ? uri : uri.toString(); this._entries.delete(key); host._diagnostics.delete(key); host.emit('event', { type: 'diagnosticsChanged', uri: key, diagnostics: [] }); host._onDiagnosticsChangeEvent.fire({ uris: [VscUri.parse(key)] }); }
    clear() { const uris = []; for (const key of this._entries.keys()) { host._diagnostics.delete(key); uris.push(VscUri.parse(key)); } this._entries.clear(); host.emit('event', { type: 'diagnosticsChanged' }); if (uris.length) host._onDiagnosticsChangeEvent.fire({ uris }); }
    get(uri) { const key = typeof uri === 'string' ? uri : uri.toString(); return this._entries.get(key); }
    has(uri) { const key = typeof uri === 'string' ? uri : uri.toString(); return this._entries.has(key); }
    forEach(cb) { this._entries.forEach((v, k) => cb(VscUri.parse(k), v, this)); }
    dispose() { this.clear(); diagnosticCollections.delete(this.name); }
    get size() { return this._entries.size; }
    [Symbol.iterator]() { return this._entries[Symbol.iterator](); }
  }

  function registerProvider(kind, selector, provider) {
    const entry = { selector, provider };
    host._providers[kind].push(entry);
    return { dispose() { const i = host._providers[kind].indexOf(entry); if (i >= 0) host._providers[kind].splice(i, 1); } };
  }

  const languages = {
    createDiagnosticCollection(name) { const col = new DiagnosticCollection(name || `diag-${Date.now()}`); diagnosticCollections.set(col.name, col); return col; },
    registerCompletionItemProvider(selector, provider, ...triggerChars) { return registerProvider('completion', selector, provider); },
    registerHoverProvider(selector, provider) { return registerProvider('hover', selector, provider); },
    registerDefinitionProvider(selector, provider) { return registerProvider('definition', selector, provider); },
    registerTypeDefinitionProvider(selector, provider) { return registerProvider('typeDefinition', selector, provider); },
    registerImplementationProvider(selector, provider) { return registerProvider('implementation', selector, provider); },
    registerDeclarationProvider(selector, provider) { return registerProvider('declaration', selector, provider); },
    registerReferenceProvider(selector, provider) { return registerProvider('references', selector, provider); },
    registerDocumentSymbolProvider(selector, provider) { return registerProvider('documentSymbol', selector, provider); },
    registerWorkspaceSymbolProvider(provider) { return registerProvider('workspaceSymbol', null, provider); },
    registerCodeActionsProvider(selector, provider) { return registerProvider('codeAction', selector, provider); },
    registerCodeLensProvider(selector, provider) { return registerProvider('codeLens', selector, provider); },
    registerDocumentFormattingEditProvider(selector, provider) { return registerProvider('formatting', selector, provider); },
    registerDocumentRangeFormattingEditProvider(selector, provider) { return registerProvider('rangeFormatting', selector, provider); },
    registerOnTypeFormattingEditProvider(selector, provider, firstChar, ...moreChars) { return registerProvider('onTypeFormatting', selector, provider); },
    registerSignatureHelpProvider(selector, provider, ...triggerCharsOrMeta) { return registerProvider('signatureHelp', selector, provider); },
    registerDocumentHighlightProvider(selector, provider) { return registerProvider('documentHighlight', selector, provider); },
    registerRenameProvider(selector, provider) { return registerProvider('rename', selector, provider); },
    registerDocumentLinkProvider(selector, provider) { return registerProvider('documentLink', selector, provider); },
    registerColorProvider(selector, provider) { return registerProvider('color', selector, provider); },
    registerFoldingRangeProvider(selector, provider) { return registerProvider('foldingRange', selector, provider); },
    registerSelectionRangeProvider(selector, provider) { return registerProvider('selectionRange', selector, provider); },
    registerDocumentSemanticTokensProvider(selector, provider, legend) { return registerProvider('semanticTokens', selector, provider); },
    registerDocumentRangeSemanticTokensProvider(selector, provider, legend) { return noopDisposable; },
    registerInlayHintsProvider(selector, provider) { return registerProvider('inlayHint', selector, provider); },
    registerCallHierarchyProvider(selector, provider) { return noopDisposable; },
    registerTypeHierarchyProvider(selector, provider) { return noopDisposable; },
    registerLinkedEditingRangeProvider(selector, provider) { return noopDisposable; },
    registerInlineCompletionItemProvider(selector, provider) { return noopDisposable; },
    registerEvaluatableExpressionProvider(selector, provider) { return noopDisposable; },
    registerInlineValuesProvider(selector, provider) { return noopDisposable; },
    registerDocumentDropEditProvider(selector, provider) { return noopDisposable; },
    setLanguageConfiguration(language, config) {
      host._languageConfigurations.set(language, config);
      host.emit('event', { type: 'languageConfigurationChanged', language, configuration: {
        comments: config.comments ? {
          lineComment: config.comments.lineComment,
          blockComment: config.comments.blockComment,
        } : undefined,
        brackets: config.brackets,
        autoClosingPairs: config.autoClosingPairs?.map(p => Array.isArray(p) ? { open: p[0], close: p[1] } : p),
        surroundingPairs: config.surroundingPairs?.map(p => Array.isArray(p) ? { open: p[0], close: p[1] } : p),
        wordPattern: config.wordPattern?.source,
        indentationRules: config.indentationRules ? {
          increaseIndentPattern: config.indentationRules.increaseIndentPattern?.source,
          decreaseIndentPattern: config.indentationRules.decreaseIndentPattern?.source,
        } : undefined,
        onEnterRules: config.onEnterRules?.map(r => ({
          beforeText: r.beforeText?.source,
          afterText: r.afterText?.source,
          action: r.action,
        })),
      }});
      return { dispose() { host._languageConfigurations.delete(language); } };
    },
    getLanguages() { return Promise.resolve([]); },
    getDiagnostics(uri) {
      if (uri) return host._diagnostics.get(uri?.toString()) || [];
      const all = [];
      for (const [u, diags] of host._diagnostics) all.push([VscUri.parse(u), diags]);
      return all;
    },
    onDidChangeDiagnostics: (listener, thisArg, disposables) => host._onDiagnosticsChangeEvent.event(listener, thisArg, disposables),
    match(selector, document) {
      if (!selector || !document) return 0;
      const sels = typeof selector === 'string' ? [{ language: selector }] : (Array.isArray(selector) ? selector : [selector]);
      let best = 0;
      for (const s of sels) {
        const sl = typeof s === 'string' ? { language: s } : s;
        let score = 0;
        if (sl.language && (sl.language === document.languageId || sl.language === '*')) score += 10;
        if (sl.scheme && (sl.scheme === document.uri?.scheme || sl.scheme === '*')) score += 10;
        if (sl.pattern) score += 5;
        if (score > best) best = score;
      }
      return best;
    },
    createLanguageStatusItem() { return { id: '', severity: 0, name: '', text: '', detail: '', dispose() {} }; },
  };

  const commands = {
    registerCommand(id, handler, thisArg) { host._commands.set(id, thisArg ? handler.bind(thisArg) : handler); return { dispose() { host._commands.delete(id); } }; },
    registerTextEditorCommand(id, handler) { host._commands.set(id, handler); return { dispose() { host._commands.delete(id); } }; },
    executeCommand(id, ...args) { const fn = host._commands.get(id); if (fn) return Promise.resolve(fn(...args)); return Promise.reject(new Error(`command not found: ${id}`)); },
    getCommands(filterInternal) { return Promise.resolve([...host._commands.keys()]); },
  };

  const workspace = {
    get workspaceFolders() { return host._workspaceFolders.map((f, i) => ({ uri: VscUri.file(f), name: path.basename(f), index: i })); },
    get rootPath() { return host._workspaceFolders[0]; },
    get name() { return host._workspaceFolders[0] ? path.basename(host._workspaceFolders[0]) : undefined; },
    get workspaceFile() { return undefined; },
    get textDocuments() { return [...host._textDocuments.values()].map(d => host._makeDocumentProxy(d.uri)); },
    getWorkspaceFolder(uri) {
      const uriStr = typeof uri === 'string' ? uri : (uri.fsPath || uri.path || uri.toString());
      for (let i = 0; i < host._workspaceFolders.length; i++) {
        const f = host._workspaceFolders[i];
        if (uriStr.startsWith(f)) {
          return { uri: VscUri.file(f), name: path.basename(f), index: i };
        }
      }
      return undefined;
    },
    asRelativePath(pathOrUri, includeWorkspaceFolder) {
      const p = typeof pathOrUri === 'string' ? pathOrUri : (pathOrUri.fsPath || pathOrUri.path || pathOrUri.toString());
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
        has(key) { return getVal(key) !== undefined; },
        update(key, value, target, overrideInLanguage) {
          const full = section ? `${section}.${key}` : key;
          host._configuration.set(full, value);
          host._onConfigChangeEvent?.fire({ affectsConfiguration: (s) => full === s || full.startsWith(s + '.') });
          return Promise.resolve();
        },
        inspect(key) {
          const full = section ? `${section}.${key}` : key;
          const v = host._configuration.get(full);
          return { key: full, defaultValue: undefined, globalValue: v, workspaceValue: v, workspaceFolderValue: undefined };
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
    onDidChangeConfiguration: (listener, thisArg, disposables) => host._onConfigChangeEvent.event(listener, thisArg, disposables),
    onDidOpenTextDocument: (listener, thisArg, disposables) => host._onDocumentEvent.event(listener, thisArg, disposables),
    onDidCloseTextDocument: (listener, thisArg, disposables) => host._onDocumentCloseEvent.event(listener, thisArg, disposables),
    onDidChangeTextDocument: (listener, thisArg, disposables) => host._onDocumentChangeEvent.event(listener, thisArg, disposables),
    onDidSaveTextDocument: (listener, thisArg, disposables) => host._onDocumentSaveEvent.event(listener, thisArg, disposables),
    onWillSaveTextDocument: noopEvent,
    onDidChangeWorkspaceFolders: noopEvent,
    createFileSystemWatcher: (globPattern, ignoreCreateEvents, ignoreChangeEvents, ignoreDeleteEvents) => {
      const id = host._nextWatcherId++;
      const pattern = typeof globPattern === 'string' ? globPattern : (globPattern?.pattern || '**/*');
      const base = typeof globPattern === 'object' && globPattern?.baseUri ? (globPattern.baseUri.fsPath || globPattern.base || '') : '';
      const onCreate = new VscEventEmitter();
      const onChange = new VscEventEmitter();
      const onDelete = new VscEventEmitter();
      host._fileWatchers.set(id, { pattern, base, onCreate, onChange, onDelete });
      const watchPaths = (host._workspaceFolders.length > 0 ? host._workspaceFolders : [base || process.cwd()]).filter(Boolean);
      host.emit('event', { type: 'startFileWatch', watcherId: id, paths: watchPaths, pattern, recursive: pattern.includes('**') });
      return {
        onDidCreate: ignoreCreateEvents ? noopEvent : onCreate.event,
        onDidChange: ignoreChangeEvents ? noopEvent : onChange.event,
        onDidDelete: ignoreDeleteEvents ? noopEvent : onDelete.event,
        dispose() {
          host._fileWatchers.delete(id);
          onCreate.dispose(); onChange.dispose(); onDelete.dispose();
          host.emit('event', { type: 'stopFileWatch', watcherId: id });
        },
      };
    },
    fs: {
      readFile: (uri) => fs.promises.readFile(uri.fsPath || uri.path),
      writeFile: (uri, content) => fs.promises.writeFile(uri.fsPath || uri.path, content),
      stat: (uri) => fs.promises.stat(uri.fsPath || uri.path).then(s => ({ type: s.isDirectory() ? 2 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size })),
      readDirectory: (uri) => fs.promises.readdir(uri.fsPath || uri.path, { withFileTypes: true }).then(entries => entries.map(e => [e.name, e.isDirectory() ? 2 : 1])),
      createDirectory: (uri) => fs.promises.mkdir(uri.fsPath || uri.path, { recursive: true }),
      delete: (uri) => fs.promises.rm(uri.fsPath || uri.path, { recursive: true, force: true }),
      rename: (oldUri, newUri) => fs.promises.rename(oldUri.fsPath, newUri.fsPath),
      copy: (src, dest) => fs.promises.copyFile(src.fsPath, dest.fsPath),
      isWritableFileSystem: () => true,
    },
    openTextDocument(uriOrPath) {
      if (typeof uriOrPath === 'string') { const uri = VscUri.file(uriOrPath); return fs.promises.readFile(uriOrPath, 'utf-8').then(text => { host._textDocuments.set(uri.toString(), { uri: uri.toString(), languageId: 'plaintext', version: 1, text }); return host._makeDocumentProxy(uri.toString()); }).catch(() => host._makeDocumentProxy(uri.toString())); }
      if (uriOrPath && uriOrPath.fsPath) { return fs.promises.readFile(uriOrPath.fsPath, 'utf-8').then(text => { host._textDocuments.set(uriOrPath.toString(), { uri: uriOrPath.toString(), languageId: 'plaintext', version: 1, text }); return host._makeDocumentProxy(uriOrPath.toString()); }).catch(() => host._makeDocumentProxy(uriOrPath.toString())); }
      return Promise.resolve(host._makeDocumentProxy('file:///untitled'));
    },
    findFiles: (include, exclude, maxResults, token) => {
      const glob = require('path');
      const fsNode = require('fs');
      const pattern = typeof include === 'string' ? include : (include?.pattern || '**/*');
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
        const edits = edit._edits.filter(e => e.range && e.uri).map(e => ({ uri: e.uri?.toString(), range: e.range, newText: e.newText }));
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
            }
          }
        }
      }
      return Promise.resolve(true);
    },
    saveAll: () => Promise.resolve(true),
    updateWorkspaceFolders: () => false,
    registerTextDocumentContentProvider: () => noopDisposable,
    registerTaskProvider: () => noopDisposable,
    registerFileSystemProvider: () => noopDisposable,
    isTrusted: true,
    onDidGrantWorkspaceTrust: noopEvent,
  };

  const window = {
    showInformationMessage(msg, ...rest) {
      log(`[info] ${msg}`);
      host.emit('event', { type: 'showMessage', severity: 'info', message: msg });
      const items = rest.filter(r => typeof r === 'string' || (typeof r === 'object' && r !== null));
      if (items.length) {
        return new Promise((resolve) => {
          const reqId = ++host._reqId;
          host._pendingRequests.set(reqId, resolve);
          host.emit('event', { type: 'showMessageRequest', id: reqId, severity: 'info', message: msg, items: items.map(i => typeof i === 'string' ? i : i.title) });
          setTimeout(() => { if (host._pendingRequests.has(reqId)) { host._pendingRequests.delete(reqId); resolve(undefined); } }, 30000);
        });
      }
      return Promise.resolve(undefined);
    },
    showWarningMessage(msg, ...rest) {
      log(`[warn] ${msg}`);
      host.emit('event', { type: 'showMessage', severity: 'warning', message: msg });
      const items = rest.filter(r => typeof r === 'string' || (typeof r === 'object' && r !== null));
      if (items.length) {
        return new Promise((resolve) => {
          const reqId = ++host._reqId;
          host._pendingRequests.set(reqId, resolve);
          host.emit('event', { type: 'showMessageRequest', id: reqId, severity: 'warning', message: msg, items: items.map(i => typeof i === 'string' ? i : i.title) });
          setTimeout(() => { if (host._pendingRequests.has(reqId)) { host._pendingRequests.delete(reqId); resolve(undefined); } }, 30000);
        });
      }
      return Promise.resolve(undefined);
    },
    showErrorMessage(msg, ...rest) {
      log(`[error] ${msg}`);
      host.emit('event', { type: 'showMessage', severity: 'error', message: msg });
      const items = rest.filter(r => typeof r === 'string' || (typeof r === 'object' && r !== null));
      if (items.length) {
        return new Promise((resolve) => {
          const reqId = ++host._reqId;
          host._pendingRequests.set(reqId, resolve);
          host.emit('event', { type: 'showMessageRequest', id: reqId, severity: 'error', message: msg, items: items.map(i => typeof i === 'string' ? i : i.title) });
          setTimeout(() => { if (host._pendingRequests.has(reqId)) { host._pendingRequests.delete(reqId); resolve(undefined); } }, 30000);
        });
      }
      return Promise.resolve(undefined);
    },
    createOutputChannel(name, opts) {
      const ch = { name, _lines: [], append(s) { this._lines.push(s); }, appendLine(line) { log(`[${name}] ${line}`); this._lines.push(line + '\n'); }, clear() { this._lines = []; }, show() {}, hide() {}, replace(s) { this._lines = [s]; }, dispose() { host._outputChannels.delete(name); } };
      if (typeof opts === 'object' && opts.log) { ch.trace = ch.debug = ch.info = ch.warn = ch.error = (msg) => ch.appendLine(msg); }
      host._outputChannels.set(name, ch);
      return ch;
    },
    createStatusBarItem(alignmentOrId, priorityOrAlignment, priorityArg) { return { id: '', text: '', tooltip: '', command: '', alignment: 1, priority: 0, name: '', backgroundColor: undefined, color: undefined, accessibilityInformation: undefined, show() {}, hide() {}, dispose() {} }; },
    showQuickPick(items, options) {
      return new Promise((resolve) => {
        const reqId = ++host._reqId;
        host._pendingRequests.set(reqId, resolve);
        const labels = Array.isArray(items) ? items.map(i => typeof i === 'string' ? i : i.label) : [];
        host.emit('event', { type: 'showQuickPick', id: reqId, items: labels, options: options || {} });
        setTimeout(() => { if (host._pendingRequests.has(reqId)) { host._pendingRequests.delete(reqId); resolve(undefined); } }, 60000);
      });
    },
    showInputBox(options) {
      return new Promise((resolve) => {
        const reqId = ++host._reqId;
        host._pendingRequests.set(reqId, resolve);
        host.emit('event', { type: 'showInputBox', id: reqId, options: options || {} });
        setTimeout(() => { if (host._pendingRequests.has(reqId)) { host._pendingRequests.delete(reqId); resolve(undefined); } }, 60000);
      });
    },
    showOpenDialog: () => Promise.resolve(undefined),
    showSaveDialog: () => Promise.resolve(undefined),
    get activeTextEditor() { return host._activeEditorUri ? host._makeTextEditorProxy(host._activeEditorUri) : undefined; },
    get visibleTextEditors() { return host._activeEditorUri ? [host._makeTextEditorProxy(host._activeEditorUri)] : []; },
    onDidChangeActiveTextEditor: (listener, thisArg, disposables) => host._onActiveEditorChangeEvent.event(listener, thisArg, disposables),
    onDidChangeVisibleTextEditors: noopEvent,
    onDidChangeTextEditorSelection: noopEvent,
    onDidChangeTextEditorOptions: noopEvent,
    onDidChangeTextEditorVisibleRanges: noopEvent,
    onDidChangeTextEditorViewColumn: noopEvent,
    onDidChangeWindowState: noopEvent,
    createTextEditorDecorationType: () => ({ key: '', dispose() {} }),
    showTextDocument: (docOrUri, columnOrOptions, preserveFocus) => {
      const uri = docOrUri && docOrUri.uri ? docOrUri.uri : docOrUri;
      const uriStr = uri?.toString?.() || '';
      host.emit('event', { type: 'showTextDocument', uri: uriStr, options: typeof columnOrOptions === 'object' ? columnOrOptions : {} });
      return Promise.resolve(undefined);
    },
    withProgress(_opts, task) { return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: noopEvent }); },
    createTerminal: () => ({ name: '', processId: Promise.resolve(0), sendText() {}, show() {}, hide() {}, dispose() {} }),
    registerTreeDataProvider: () => noopDisposable,
    createTreeView: () => ({ onDidExpandElement: noopEvent, onDidCollapseElement: noopEvent, selection: [], onDidChangeSelection: noopEvent, visible: true, onDidChangeVisibility: noopEvent, message: '', title: '', description: '', reveal() { return Promise.resolve(); }, dispose() {} }),
    registerWebviewPanelSerializer: () => noopDisposable,
    registerWebviewViewProvider: () => noopDisposable,
    registerCustomEditorProvider: () => noopDisposable,
    registerUriHandler: () => noopDisposable,
    registerFileDecorationProvider: () => noopDisposable,
    registerTerminalLinkProvider: () => noopDisposable,
    registerTerminalProfileProvider: () => noopDisposable,
    createQuickPick() { return { items: [], onDidAccept: noopEvent, onDidChangeActive: noopEvent, onDidChangeSelection: noopEvent, onDidChangeValue: noopEvent, onDidHide: noopEvent, onDidTriggerButton: noopEvent, show() {}, hide() {}, dispose() {} }; },
    createInputBox() { return { value: '', onDidAccept: noopEvent, onDidChangeValue: noopEvent, onDidHide: noopEvent, show() {}, hide() {}, dispose() {} }; },
    createWebviewPanel: () => ({ webview: { html: '', onDidReceiveMessage: noopEvent, postMessage() { return Promise.resolve(true); }, asWebviewUri(uri) { return uri; }, cspSource: '' }, onDidDispose: noopEvent, onDidChangeViewState: noopEvent, dispose() {}, reveal() {} }),
    get state() { return { focused: true }; },
    get activeColorTheme() { return { kind: 2 }; },
    onDidChangeActiveColorTheme: noopEvent,
    get tabGroups() { return { all: [], activeTabGroup: { tabs: [], isActive: true, viewColumn: 1 }, onDidChangeTabGroups: noopEvent, onDidChangeTabs: noopEvent, close: () => Promise.resolve() }; },
    setStatusBarMessage: () => noopDisposable,
  };

  const extensions = {
    getExtension(id) { const ext = host._extensions.get(id); if (!ext) return undefined; return { id, extensionPath: ext.extensionPath, extensionUri: VscUri.file(ext.extensionPath), exports: ext.exports, isActive: ext.activated, packageJSON: ext.manifest, extensionKind: ExtensionKind.Workspace, activate: () => Promise.resolve(ext.exports) }; },
    get all() { const arr = []; for (const [id, ext] of host._extensions) arr.push({ id, extensionPath: ext.extensionPath, extensionUri: VscUri.file(ext.extensionPath), exports: ext.exports, isActive: ext.activated, packageJSON: ext.manifest, extensionKind: ExtensionKind.Workspace }); return arr; },
    onDidChange: noopEvent,
  };

  const env = {
    appName: 'SideX', appRoot: process.cwd(), language: 'en', machineId: 'sidex',
    sessionId: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`,
    uriScheme: 'sidex', shell: process.env.SHELL || '',
    clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() },
    openExternal: () => Promise.resolve(true),
    asExternalUri: (uri) => Promise.resolve(uri),
    createTelemetryLogger: () => ({ logUsage() {}, logError() {}, dispose() {} }),
    get isTelemetryEnabled() { return false; },
    onDidChangeTelemetryEnabled: noopEvent,
    get isNewAppInstall() { return true; },
    get remoteName() { return undefined; },
    logLevel: 2,
    onDidChangeLogLevel: noopEvent,
    get uiKind() { return 1; },
  };

  const tasks = {
    registerTaskProvider: () => noopDisposable,
    fetchTasks: () => Promise.resolve([]),
    executeTask: () => Promise.resolve({ terminate() {} }),
    taskExecutions: [],
    onDidStartTask: noopEvent,
    onDidEndTask: noopEvent,
    onDidStartTaskProcess: noopEvent,
    onDidEndTaskProcess: noopEvent,
  };

  const debug = {
    registerDebugConfigurationProvider: () => noopDisposable,
    registerDebugAdapterDescriptorFactory: () => noopDisposable,
    registerDebugAdapterTrackerFactory: () => noopDisposable,
    startDebugging: () => Promise.resolve(false),
    stopDebugging: () => Promise.resolve(),
    addBreakpoints: () => {},
    removeBreakpoints: () => {},
    get activeDebugSession() { return undefined; },
    get activeDebugConsole() { return { append() {}, appendLine() {} }; },
    get breakpoints() { return []; },
    onDidChangeActiveDebugSession: noopEvent,
    onDidStartDebugSession: noopEvent,
    onDidReceiveDebugSessionCustomEvent: noopEvent,
    onDidTerminateDebugSession: noopEvent,
    onDidChangeBreakpoints: noopEvent,
    asDebugSourceUri: () => VscUri.file(''),
  };

  const notebooks = {
    createNotebookController: () => ({ id: '', notebookType: '', onDidChangeSelectedNotebooks: noopEvent, dispose() {} }),
    registerNotebookCellStatusBarItemProvider: () => noopDisposable,
    createRendererMessaging: () => ({ onDidReceiveMessage: noopEvent, postMessage() { return Promise.resolve(true); } }),
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
  };

  const comments = {
    createCommentController: () => ({ createCommentThread() { return { comments: [], dispose() {} }; }, dispose() {} }),
  };

  const authentication = {
    getSession: () => Promise.resolve(undefined),
    registerAuthenticationProvider: () => noopDisposable,
    onDidChangeSessions: noopEvent,
  };

  return {
    Position: VscPosition, Range: VscRange, Selection: VscSelection, Uri: VscUri,
    Location, Diagnostic, DiagnosticRelatedInformation, DiagnosticSeverity, DiagnosticTag,
    CompletionItem, CompletionItemKind, CompletionItemTag, CompletionList, CompletionTriggerKind,
    TextEdit, WorkspaceEdit, Hover, CodeAction, CodeLens,
    DocumentSymbol, SymbolInformation, SymbolKind, DocumentHighlight, DocumentHighlightKind,
    FoldingRange, FoldingRangeKind, SelectionRange,
    CallHierarchyItem, TypeHierarchyItem,
    DocumentLink, Color, ColorInformation, ColorPresentation,
    InlayHint, InlayHintKind,
    SignatureHelp, SignatureInformation, ParameterInformation, SignatureHelpTriggerKind,
    SnippetString, MarkdownString, ThemeColor, ThemeIcon, TreeItem,
    SemanticTokensLegend, SemanticTokensBuilder, SemanticTokens,
    CodeActionKind, IndentAction, FileType,
    TextEditorCursorStyle, TextEditorLineNumbersStyle, DecorationRangeBehavior,
    TextDocumentSaveReason,
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
    EndOfLine: { LF: 1, CRLF: 2 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation,
    TreeItemCollapsibleState,
    ExtensionKind,
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
      cancel() { this.token.isCancellationRequested = true; this._emitter.fire(); }
      dispose() { this._emitter.dispose(); }
    },
    Disposable: class { constructor(fn) { this._fn = fn; } static from(...disposables) { return new this(() => disposables.forEach(d => d.dispose())); } dispose() { if (this._fn) { this._fn(); this._fn = null; } } },
    RelativePattern: class { constructor(base, pattern) { this.baseUri = typeof base === 'string' ? VscUri.file(base) : (base.uri || base); this.base = typeof base === 'string' ? base : (base.uri?.fsPath || base.fsPath || ''); this.pattern = pattern; } },
    ShellExecution: class { constructor(commandLine, args, options) { this.commandLine = commandLine; this.args = args; this.options = options; } },
    ProcessExecution: class { constructor(process, args, options) { this.process = process; this.args = args; this.options = options; } },
    CustomExecution: class { constructor(callback) { this.callback = callback; } },
    Task: class { constructor(definition, scope, name, source, execution, problemMatchers) { this.definition = definition; this.scope = scope; this.name = name; this.source = source; this.execution = execution; this.problemMatchers = problemMatchers || []; this.isBackground = false; this.presentationOptions = {}; this.runOptions = {}; this.group = undefined; } },
    TaskScope: { Global: 1, Workspace: 2 },
    TaskGroup: { Build: { id: 'build' }, Test: { id: 'test' }, Clean: { id: 'clean' }, Rebuild: { id: 'rebuild' } },
    TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
    TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
    languages, commands, workspace, window, extensions, env, tasks, debug, notebooks, scm, comments, authentication,
    version: '1.90.0',
    l10n: { t: (message, ...args) => typeof message === 'string' ? message : message.message || '', bundle: undefined, uri: undefined },
  };
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
}

installVscodeShim();
hostInstance = new ExtensionHost();
require.cache['__sidex_vscode_shim__'].exports = createVscodeShim();

// ── IPC mode: when forked by server.cjs, communicate via process messages ──

if (process.env.SIDEX_EXTENSION_HOST === 'true' && process.send) {
	const host = hostInstance;
	host.initialize();

	let initData = null;
	try {
		if (process.env.SIDEX_INIT_DATA) {
			initData = JSON.parse(process.env.SIDEX_INIT_DATA);
		}
	} catch (e) {
		log(`failed to parse init data: ${e.message}`);
	}

	if (initData && initData.extensions) {
		for (const ext of initData.extensions) {
			const extPath = ext.extensionLocation?.path || ext.location?.path;
			if (!extPath) continue;
			try {
				const manifest = host._readManifest(extPath);
				host._extensions.set(manifest.id, {
					manifest, extensionPath: extPath,
					module: null, context: null, exports: null, activated: false,
				});
				const activationEvents = manifest.activationEvents || [];
				if (activationEvents.includes('*') || activationEvents.includes('onStartupFinished') || activationEvents.length === 0) {
					try {
						host._activateExtension(manifest.id);
					} catch (e) {
						log(`auto-activate failed ${manifest.id}: ${e.message}`);
					}
				}
			} catch (e) {
				log(`load extension failed ${extPath}: ${e.message}`);
			}
		}
	}

	host.on('event', (event) => {
		if (process.send) {
			process.send({ type: 'sidex:host-event', event });
		}
	});

	process.on('message', (msg) => {
		if (!msg || typeof msg !== 'object') return;
		const reply = host.handleMessage(msg);
		if (reply && process.send) {
			process.send({ type: 'sidex:host-reply', reply });
		}
	});

	process.send({ type: 'VSCODE_EXTHOST_IPC_READY' });
	log('extension host process running in IPC mode');
} else {
	module.exports = hostInstance;
}
