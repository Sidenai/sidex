'use strict';

const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');

// ── RFC 6455 WebSocket helpers (zero dependencies) ──────────────────────

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(key + WS_MAGIC)
    .digest('base64');
}

function decodeFrame(buf) {
  if (buf.length < 2) {
    return null;
  }
  const secondByte = buf[1];
  const masked = (secondByte & 0x80) !== 0;
  let payloadLen = secondByte & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < 4) {
      return null;
    }
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) {
      return null;
    }
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) {
      return null;
    }
    maskKey = buf.slice(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + payloadLen) {
    return null;
  }
  const payload = buf.slice(offset, offset + payloadLen);
  if (maskKey) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i & 3];
    }
  }
  return { opcode: buf[0] & 0x0f, payload, totalLength: offset + payloadLen };
}

function encodeFrame(opcode, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// ── Constants (from Rust via env vars) ──────────────────────────────────

const SIDEX_DATA_DIR = path.join(os.homedir(), '.sidex');
const EXTENSIONS_DIR = process.env.SIDEX_EXTENSIONS_DIR || path.join(SIDEX_DATA_DIR, 'extensions');
const USER_DATA_DIR = path.join(SIDEX_DATA_DIR, 'data');
const GLOBAL_STORAGE_DIR = process.env.SIDEX_GLOBAL_STORAGE_DIR || path.join(USER_DATA_DIR, 'User', 'globalStorage');

[EXTENSIONS_DIR, USER_DATA_DIR, GLOBAL_STORAGE_DIR].forEach((d) => {
  try {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  } catch {
    // best-effort
  }
});

// ── Init data: prefer Rust-provided, fallback to self-built ─────────────

let rustInitData = null;
try {
  if (process.env.SIDEX_INIT_DATA_FILE) {
    const raw = fs.readFileSync(process.env.SIDEX_INIT_DATA_FILE, 'utf8');
    rustInitData = JSON.parse(raw);
    log(`received Rust-generated init data with ${(rustInitData.extensions || []).length} extensions`);
    try { fs.unlinkSync(process.env.SIDEX_INIT_DATA_FILE); } catch {}
  } else if (process.env.SIDEX_INIT_DATA) {
    rustInitData = JSON.parse(process.env.SIDEX_INIT_DATA);
    log(`received Rust-generated init data with ${(rustInitData.extensions || []).length} extensions`);
  }
} catch (e) {
  log(`failed to parse init data: ${e.message}`);
}

// ── Extension search paths (from Rust) ──────────────────────────────────

function getExtensionSearchPaths() {
  if (process.env.SIDEX_EXTENSION_SEARCH_PATHS) {
    try {
      const parsed = JSON.parse(process.env.SIDEX_EXTENSION_SEARCH_PATHS);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter((p) => typeof p === 'string' && p.length > 0);
      }
    } catch (e) {
      log(`bad SIDEX_EXTENSION_SEARCH_PATHS: ${e.message}`);
    }
  }

  const builtinExt = process.env.SIDEX_BUILTIN_EXTENSIONS_DIR;
  // NOTE: do NOT scan ~/.vscode or ~/.cursor extension dirs — loading foreign
  // user extensions pulls in incompatible/platform-specific extensions and
  // can mutate the user's other-editor runtimes (e.g. redhat.java touching a
  // VS Code-managed JDK). SideX only loads its own extension dirs.
  const candidates = [
    EXTENSIONS_DIR,
    builtinExt,
    path.resolve(process.cwd(), 'dist', 'extensions'),
    path.join(process.cwd(), 'extensions'),
    path.resolve(__dirname, '..', 'extensions'),
    path.resolve(__dirname, '..', '..', 'extensions'),
  ];

  const seen = new Set();
  const paths = [];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

// ── Extension Host Process Management ───────────────────────────────────

class ExtensionHostManager {
  constructor() {
    this._sharedEntry = null;
    this._connectionToken = crypto.randomUUID();
    this._listeners = new Set();
  }

  get connectionToken() {
    return this._connectionToken;
  }

  getOrCreateSharedProcess(initData) {
    if (this._sharedEntry && this._sharedEntry.child.connected) {
      return this._sharedEntry;
    }

    const reconnectionToken = crypto.randomUUID();
    const initDataFile = path.join(os.tmpdir(), `sidex-host-${reconnectionToken}.json`);
    try {
      fs.writeFileSync(initDataFile, JSON.stringify(initData));
    } catch (e) {
      log(`failed to write host init data file: ${e.message}`);
    }

    const hostPath = path.join(__dirname, 'host.cjs');
    const child = cp.fork(hostPath, ['--type=extensionHost'], {
      silent: true,
      env: {
        ...process.env,
        VSCODE_HANDLES_UNCAUGHT_ERRORS: 'true',
        SIDEX_EXTENSION_HOST: 'true',
        SIDEX_INIT_DATA_FILE: initDataFile,
      },
    });

    const entry = { child, reconnectionToken, initData };
    this._sharedEntry = entry;

    child.on('exit', (code, signal) => {
      log(`ext-host process <${child.pid}> exited: code=${code} signal=${signal}`);
      if (this._sharedEntry === entry) {
        this._sharedEntry = null;
      }
    });

    child.on('error', (err) => {
      log(`ext-host process error: ${err.message}`);
      if (this._sharedEntry === entry) {
        this._sharedEntry = null;
      }
    });

    child.on('message', (msg) => {
      for (const listener of this._listeners) {
        try {
          listener(msg);
        } catch {}
      }
    });

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => log(`<${child.pid}> ${d.trimEnd()}`));
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => log(`<${child.pid}><stderr> ${d.trimEnd()}`));
    }

    log(`spawned shared ext-host process <${child.pid}>`);
    return entry;
  }

  addMessageListener(listener) {
    this._listeners.add(listener);
  }

  removeMessageListener(listener) {
    this._listeners.delete(listener);
  }

  sendToHost(msg) {
    if (this._sharedEntry && this._sharedEntry.child.connected) {
      this._sharedEntry.child.send(msg);
      return true;
    }
    return false;
  }

  shutdown() {
    if (this._sharedEntry) {
      try {
        this._sharedEntry.child.kill();
      } catch {}
      this._sharedEntry = null;
    }
    this._listeners.clear();
  }
}

// ── WebSocket Connection Handler ────────────────────────────────────────

const hostManager = new ExtensionHostManager();

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = acceptKey(key);
  const protocol = req.headers['sec-websocket-protocol'];
  const protocolHeader = protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '';

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      protocolHeader +
      '\r\n',
  );

  const client = new ClientConnection(socket, req.url || '/');
  client.start();
}

class ClientConnection {
  constructor(socket, urlPath) {
    this._socket = socket;
    this._urlPath = urlPath;
    this._buffer = Buffer.alloc(0);
    this._disposed = false;
    this._messageListener = null;
    this._pendingClientIds = new Set();
  }

  start() {
    log('client connected');

    this._socket.on('data', (chunk) => this._onData(chunk));
    this._socket.on('close', () => this._onClose());
    this._socket.on('error', (err) => {
      log(`socket error: ${err.message}`);
      this._dispose();
    });

    this._performHandshake();
  }

  _performHandshake() {
    const initData = rustInitData || this._buildFallbackInitData();
    const extensions = initData.extensions || [];

    log(`handshake with ${extensions.length} extensions (source: ${rustInitData ? 'rust' : 'fallback'})`);

    const reconnectionToken = crypto.randomUUID();
    const connectionToken = hostManager.connectionToken;

    hostManager.getOrCreateSharedProcess(initData);
    this._setupIPC();

    this._sendJson({
      type: 'sidex:handshake',
      connectionToken,
      reconnectionToken,
      extensionCount: extensions.length,
      extensions: extensions.map((e) => ({
        id: e.identifier?.id || e.id || 'unknown',
        location: e.extensionLocation?.path || e.location?.path || '',
        name: e.packageJSON?.displayName || e.packageJSON?.name || e.identifier?.id || '',
        version: e.packageJSON?.version || '0.0.0',
        activationEvents: e.packageJSON?.activationEvents || [],
        main: e.packageJSON?.main,
        browser: e.packageJSON?.browser,
        contributes: Object.keys(e.packageJSON?.contributes || {}),
      })),
    });
  }

  _buildFallbackInitData() {
    const searchPaths = getExtensionSearchPaths();
    const extensions = scanExtensionsFallback(searchPaths);
    return {
      version: '1.93.0',
      commit: undefined,
      parentPid: process.pid,
      environment: {
        isExtensionDevelopmentDebug: false,
        appRoot: process.cwd(),
        appName: 'SideX',
        appHost: 'desktop',
        appUriScheme: 'sidex',
        appLanguage: 'en',
        extensionTelemetryLogResource: { scheme: 'file', path: '' },
        isExtensionTelemetryLoggingOnly: false,
        globalStorageHome: { scheme: 'file', path: GLOBAL_STORAGE_DIR },
        workspaceStorageHome: { scheme: 'file', path: path.join(USER_DATA_DIR, 'workspaceStorage') },
        extensionDevelopmentLocationURI: undefined,
        extensionTestsLocationURI: undefined,
      },
      workspace: undefined,
      remote: { isRemote: false, authority: undefined, connectionData: null },
      extensions,
      telemetryInfo: {
        sessionId: crypto.randomUUID(),
        machineId: crypto.randomUUID(),
        sqmId: crypto.randomUUID(),
        devDeviceId: crypto.randomUUID(),
        firstSessionDate: new Date().toISOString(),
        msftInternal: false,
      },
      logLevel: 2,
      loggers: [],
      logsLocation: { scheme: 'file', path: path.join(USER_DATA_DIR, 'logs') },
      autoStart: true,
      uiKind: 1,
    };
  }

  _setupIPC() {
    this._messageListener = (msg) => {
      if (msg && msg.type === 'VSCODE_EXTHOST_IPC_READY') {
        return;
      }

      if (msg && msg.type === 'sidex:host-event') {
        const event = msg.event;
        if (event && event.id !== undefined && this._pendingClientIds.has(event.id)) {
          this._pendingClientIds.delete(event.id);
          this._sendJson(event);
        } else if (event && event.id === undefined) {
          this._sendJson(event);
        } else if (event && event.type) {
          this._sendJson(event);
        }
        return;
      }

      if (msg && msg.type === 'sidex:host-reply') {
        const reply = msg.reply;
        if (reply && reply.id !== undefined && this._pendingClientIds.has(reply.id)) {
          this._pendingClientIds.delete(reply.id);
          this._sendJson(reply);
        }
        return;
      }
    };

    hostManager.addMessageListener(this._messageListener);
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (true) {
      const frame = decodeFrame(this._buffer);
      if (!frame) {
        break;
      }
      this._buffer = this._buffer.slice(frame.totalLength);

      if (frame.opcode === 0x08) {
        this._socket.write(encodeFrame(0x08, Buffer.alloc(0)));
        this._socket.end();
        return;
      }
      if (frame.opcode === 0x09) {
        this._socket.write(encodeFrame(0x0a, frame.payload));
        continue;
      }
      if (frame.opcode === 0x01) {
        this._handleTextMessage(frame.payload.toString('utf-8'));
      }
    }
  }

  _handleTextMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      log('bad JSON from client');
      return;
    }

    const { id, type, method, params } = msg;
    const handler = type || method;

    switch (handler) {
      case 'ping':
        this._sendJson({ id, type: 'pong' });
        break;

      case 'initialize':
        this._handleInitialize(id, params);
        break;

      default:
        this._forwardToExtHost(id, msg);
        break;
    }
  }

  _handleInitialize(id, params) {
    this._forwardToExtHost(undefined, {
      type: 'initialize',
      params: {
        extensionPaths: getExtensionSearchPaths(),
        workspaceFolders: Array.isArray(params?.workspaceFolders) ? params.workspaceFolders : [],
      },
    });

    this._sendJson({
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
        connectionToken: hostManager.connectionToken,
        pid: process.pid,
      },
    });
  }

  _forwardToExtHost(id, msg) {
    if (id !== undefined) {
      this._pendingClientIds.add(id);
    }
    const sent = hostManager.sendToHost({ ...msg, _clientId: id });
    if (!sent) {
      if (id !== undefined) {
        this._pendingClientIds.delete(id);
      }
      this._sendJson({ id, error: 'extension host not connected' });
    }
  }

  _sendJson(obj) {
    if (this._disposed) {
      return;
    }
    try {
      this._socket.write(encodeFrame(0x01, JSON.stringify(obj)));
    } catch {
      // best-effort
    }
  }

  _onClose() {
    log('client disconnected');
    this._dispose();
  }

  _dispose() {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    if (this._messageListener) {
      hostManager.removeMessageListener(this._messageListener);
      this._messageListener = null;
    }
    this._pendingClientIds.clear();
  }
}

// ── Fallback extension scanner (only used when Rust init data unavailable)

function scanExtensionsFallback(searchPaths) {
  const disableIds = new Set(
    (process.env.SIDEX_DISABLE_EXTENSION_IDS || 'ms-python.vscode-pylance')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const byId = new Map();
  const versionWeight = (v) => {
    if (!v || typeof v !== 'string') {
      return [0];
    }
    return v.split(/[.-]/).map((p) => {
      const n = Number(p);
      return Number.isFinite(n) ? n : 0;
    });
  };
  const isVersionGreater = (a, b) => {
    const wa = versionWeight(a);
    const wb = versionWeight(b);
    const len = Math.max(wa.length, wb.length);
    for (let i = 0; i < len; i++) {
      const av = wa[i] || 0;
      const bv = wb[i] || 0;
      if (av > bv) {
        return true;
      }
      if (av < bv) {
        return false;
      }
    }
    return false;
  };

  for (const searchPath of searchPaths) {
    try {
      if (!fs.existsSync(searchPath)) {
        continue;
      }
      const entries = fs.readdirSync(searchPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const extDir = path.join(searchPath, entry.name);
        const pkgPath = path.join(extDir, 'package.json');
        if (!fs.existsSync(pkgPath)) {
          continue;
        }
        try {
          const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          const entryPoint = raw.main || raw.browser;
          if (!entryPoint || typeof entryPoint !== 'string') {
            continue;
          }
          const entryPath = path.resolve(extDir, entryPoint);
          if (!fs.existsSync(entryPath) && !fs.existsSync(entryPath + '.js')) {
            continue;
          }
          const publisher = raw.publisher || 'unknown';
          const name = raw.name || entry.name;
          const id = `${publisher}.${name}`;
          if (disableIds.has(id)) {
            continue;
          }
          const candidate = {
            identifier: { id, uuid: undefined },
            extensionLocation: { scheme: 'file', path: extDir, authority: '' },
            packageJSON: raw,
            isBuiltin: false,
            isUnderDevelopment: false,
            targetPlatform: 'undefined',
          };
          const existing = byId.get(id);
          if (!existing || isVersionGreater(raw.version, existing.packageJSON?.version)) {
            byId.set(id, candidate);
          }
        } catch (e) {
          log(`skip ${entry.name}: ${e.message}`);
        }
      }
    } catch (e) {
      log(`scan error ${searchPath}: ${e.message}`);
    }
  }
  return [...byId.values()];
}

// ── HTTP Server ─────────────────────────────────────────────────────────

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function log(msg) {
  process.stderr.write(`[ext-host] ${msg}\n`);
}

async function main() {
  const port = await findFreePort();

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        pid: process.pid,
        connectionToken: hostManager.connectionToken,
        sessionId: process.env.SIDEX_SESSION_ID || null,
        extensionCount: rustInitData ? (rustInitData.extensions || []).length : null,
      }),
    );
  });

  server.on('upgrade', (req, socket, _head) => {
    handleUpgrade(req, socket);
  });

  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ port }) + '\n');
    log(`listening on 127.0.0.1:${port} (session=${process.env.SIDEX_SESSION_ID || 'unknown'})`);
  });

  const shutdown = () => {
    log('shutting down');
    hostManager.shutdown();
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.resume();
  process.stdin.on('end', shutdown);
}

main().catch((err) => {
  process.stderr.write(`[ext-host] fatal: ${err.stack || err}\n`);
  process.exit(1);
});
