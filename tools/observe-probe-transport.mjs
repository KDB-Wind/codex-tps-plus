import net from "node:net";

const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0:0:0:0:0:0:0:1";
}

export function parseEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !endpoint.trim()) throw new Error("endpoint_required");
  const value = endpoint.trim();
  if (value === "stdio://" || value === "stdio:") return { kind: "stdio", endpointKind: "stdio" };
  if (value.startsWith("unix://")) {
    let socketPath = value.slice("unix://".length);
    if (socketPath.startsWith("localhost/")) socketPath = socketPath.slice("localhost".length);
    try {
      socketPath = decodeURIComponent(socketPath);
    } catch {
      throw new Error("unix_endpoint_invalid");
    }
    if (!socketPath) throw new Error("unix_endpoint_path_required");
    return { kind: "unix", endpointKind: "unix", socketPath };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("endpoint_scheme_unsupported");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("endpoint_scheme_unsupported");
  }
  if (url.username || url.password) throw new Error("endpoint_credentials_not_allowed");
  if (!isLoopbackHost(url.hostname)) throw new Error("endpoint_must_be_loopback");
  return {
    kind: "websocket",
    endpointKind: url.protocol === "wss:" ? "wss" : "ws",
    url: url.toString(),
    hostLoopback: true,
  };
}

export class TransportClosedError extends Error {
  constructor(code = "transport_closed") {
    super(code);
    this.name = "TransportClosedError";
    this.code = code;
  }
}

export class JsonRpcTransport {
  constructor(endpoint, options = {}) {
    this.endpoint = endpoint;
    this.parsedEndpoint = parseEndpoint(endpoint);
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    this.netImpl = options.netImpl || net;
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.maxMessageBytes = finitePositive(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES);
    this.onMessage = typeof options.onMessage === "function" ? options.onMessage : () => {};
    this.onClose = typeof options.onClose === "function" ? options.onClose : () => {};
    this.onError = typeof options.onError === "function" ? options.onError : () => {};
    this.socket = null;
    this.connected = false;
    this.closed = false;
    this.closeNotified = false;
    this.buffer = "";
    this.inputListener = null;
  }

  async connect() {
    if (this.connected) return;
    if (this.parsedEndpoint.kind === "websocket") return this.connectWebSocket();
    if (this.parsedEndpoint.kind === "unix") return this.connectSocket();
    return this.connectStdio();
  }

  async connectWebSocket() {
    if (typeof this.WebSocketImpl !== "function") throw new Error("websocket_unavailable");
    const socket = new this.WebSocketImpl(this.parsedEndpoint.url);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const open = () => {
        this.connected = true;
        finish(resolve);
      };
      const error = () => finish(reject, new Error("websocket_connect_failed"));
      const close = () => {
        this.connected = false;
        finish(reject, new TransportClosedError("websocket_closed_during_connect"));
        this.notifyClose("websocket_closed");
      };
      this.addSocketListener(socket, "open", open);
      this.addSocketListener(socket, "error", error);
      this.addSocketListener(socket, "close", close);
      this.addSocketListener(socket, "message", (event) => {
        this.handleWebSocketData(event?.data ?? event);
      });
    });
  }

  connectSocket() {
    return new Promise((resolve, reject) => {
      const socket = this.netImpl.createConnection(this.parsedEndpoint.socketPath);
      this.socket = socket;
      let settled = false;
      const fail = () => {
        if (!settled) {
          settled = true;
          reject(new Error("unix_connect_failed"));
        }
        this.notifyClose("unix_socket_error");
      };
      socket.once?.("connect", () => {
        if (settled) return;
        settled = true;
        this.connected = true;
        resolve();
      });
      socket.on?.("data", (chunk) => this.handleStreamData(chunk));
      socket.on?.("error", fail);
      socket.on?.("close", () => {
        this.connected = false;
        if (!settled) {
          settled = true;
          reject(new TransportClosedError("unix_closed_during_connect"));
        }
        this.notifyClose("unix_socket_closed");
      });
    });
  }

  connectStdio() {
    if (!this.input || typeof this.input.on !== "function" || !this.output) {
      throw new Error("stdio_transport_unavailable");
    }
    this.inputListener = (chunk) => this.handleStreamData(chunk);
    this.input.on("data", this.inputListener);
    this.input.on("end", () => {
      this.connected = false;
      this.notifyClose("stdio_eof");
    });
    this.input.on("error", () => {
      this.connected = false;
      this.notifyError("stdio_read_error");
      this.notifyClose("stdio_error");
    });
    this.connected = true;
  }

  addSocketListener(socket, event, listener) {
    if (typeof socket.addEventListener === "function") socket.addEventListener(event, listener);
    else if (typeof socket.on === "function") socket.on(event, listener);
    else socket[`on${event}`] = listener;
  }

  handleWebSocketData(data) {
    if (typeof data === "string") {
      this.handleFrame(data);
      return;
    }
    if (Buffer.isBuffer(data)) {
      this.handleFrame(data.toString("utf8"));
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.handleFrame(Buffer.from(data).toString("utf8"));
      return;
    }
    if (typeof data?.text === "function") {
      Promise.resolve(data.text())
        .then((text) => this.handleFrame(text))
        .catch(() => this.notifyError("websocket_message_decode_failed"));
      return;
    }
    this.notifyError("websocket_message_type_invalid");
  }

  handleStreamData(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    this.buffer += text;
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxMessageBytes && !this.buffer.includes("\n")) {
      this.notifyError("message_too_large");
      this.close("message_too_large");
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.handleFrame(line);
    }
  }

  handleFrame(text) {
    if (typeof text !== "string") return;
    if (Buffer.byteLength(text, "utf8") > this.maxMessageBytes) {
      this.notifyError("message_too_large");
      this.close("message_too_large");
      return;
    }
    if (!text.trim()) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.notifyError("message_json_invalid");
      return;
    }
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      this.notifyError("message_object_required");
      return;
    }
    try {
      this.onMessage(message);
    } catch {
      this.notifyError("message_handler_failed");
    }
  }

  send(message) {
    if (this.closed || !this.connected) throw new TransportClosedError("transport_not_connected");
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized, "utf8") > this.maxMessageBytes) {
      throw new Error("outgoing_message_too_large");
    }
    if (this.parsedEndpoint.kind === "websocket") {
      this.socket.send(serialized);
    } else {
      this.socket?.write?.(`${serialized}\n`);
      if (this.parsedEndpoint.kind === "stdio") this.output.write(`${serialized}\n`);
    }
  }

  close(reason = "transport_closed") {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    if (this.parsedEndpoint.kind === "websocket") {
      try {
        this.socket?.close?.();
      } catch {}
    } else if (this.parsedEndpoint.kind === "unix") {
      try {
        this.socket?.end?.();
      } catch {}
    } else if (this.inputListener && typeof this.input.off === "function") {
      this.input.off("data", this.inputListener);
    }
    this.notifyClose(reason);
  }

  notifyError(code) {
    try {
      this.onError(code);
    } catch {}
  }

  notifyClose(reason) {
    if (this.closeNotified) return;
    this.closeNotified = true;
    try {
      this.onClose(reason);
    } catch {}
  }
}

export class JsonRpcClient {
  constructor(transport, options = {}) {
    this.transport = transport;
    this.requestTimeoutMs = finitePositive(options.requestTimeoutMs, 10_000);
    this.onNotification = typeof options.onNotification === "function" ? options.onNotification : () => {};
    this.onServerRequest = typeof options.onServerRequest === "function" ? options.onServerRequest : () => {};
    this.onResponse = typeof options.onResponse === "function" ? options.onResponse : () => {};
    this.onClose = typeof options.onClose === "function" ? options.onClose : () => {};
    this.onTransportError = typeof options.onTransportError === "function" ? options.onTransportError : () => {};
    this.beforeSend = typeof options.beforeSend === "function" ? options.beforeSend : () => {};
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.transport.onMessage = (message) => this.handleMessage(message);
    this.transport.onClose = (reason) => this.handleClose(reason);
    this.transport.onError = (code) => this.onTransportError(code);
  }

  async connect() {
    await this.transport.connect();
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new TransportClosedError("rpc_client_closed"));
    const id = this.nextId++;
    const message = { id, method, params };
    this.beforeSend(method, params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("rpc_request_timeout"));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.transport.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    if (this.closed) throw new TransportClosedError("rpc_client_closed");
    this.beforeSend(method, params);
    const message = params === undefined ? { method } : { method, params };
    this.transport.send(message);
  }

  handleMessage(message) {
    const hasMethod = typeof message?.method === "string";
    const hasId = message?.id !== undefined && message?.id !== null;
    if (hasMethod && hasId) {
      this.onServerRequest(message);
      return;
    }
    if (hasId && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const error = message.error || null;
      this.onResponse(pending.method, message.result, error);
      if (error) pending.reject(Object.assign(new Error("rpc_error"), { code: error.code }));
      else pending.resolve(message.result);
      return;
    }
    if (hasMethod) {
      this.onNotification(message);
      return;
    }
    this.onTransportError("unmatched_rpc_message");
  }

  handleClose(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new TransportClosedError(reason || "transport_closed"));
    }
    this.pending.clear();
    this.onClose(reason || "transport_closed");
  }

  close(reason = "rpc_client_closed") {
    if (this.closed) return;
    this.transport.close(reason);
    this.handleClose(reason);
  }
}
