// Narrow, dependency-free OTLP protobuf decoder for the metrics and logs
// envelopes used by Codex. Unknown fields are skipped so newer OTLP versions
// degrade without exposing or misinterpreting arbitrary payload bytes.

class Reader {
  constructor(buffer, start = 0, end = buffer.length) {
    this.buffer = buffer;
    this.offset = start;
    this.end = end;
  }

  get done() {
    return this.offset >= this.end;
  }

  varint() {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (this.offset >= this.end) throw new Error("truncated protobuf varint");
      const byte = this.buffer[this.offset++];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("invalid protobuf varint");
  }

  tag() {
    const raw = Number(this.varint());
    const field = raw >>> 3;
    const wire = raw & 7;
    if (!field) throw new Error("invalid protobuf field number");
    return { field, wire };
  }

  fixed64() {
    if (this.offset + 8 > this.end) throw new Error("truncated protobuf fixed64");
    const value = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  double() {
    if (this.offset + 8 > this.end) throw new Error("truncated protobuf double");
    const value = this.buffer.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }

  fixed32() {
    if (this.offset + 4 > this.end) throw new Error("truncated protobuf fixed32");
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  bytes() {
    const length = Number(this.varint());
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.end) {
      throw new Error("invalid protobuf length-delimited field");
    }
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  string() {
    return this.bytes().toString("utf8");
  }

  message() {
    return new Reader(this.bytes());
  }

  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.fixed64();
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.fixed32();
    else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
}

function safeInteger(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function unixNano(value) {
  if (value === 0n) return null;
  const milliseconds = value / 1_000_000n;
  if (milliseconds > BigInt(8_640_000_000_000_000)) return null;
  return new Date(Number(milliseconds)).toISOString();
}

function parseMessage(reader, handlers) {
  while (!reader.done) {
    const { field, wire } = reader.tag();
    const handler = handlers[field];
    if (handler) handler(reader, wire);
    else reader.skip(wire);
  }
}

function parseAnyValue(reader, depth = 0) {
  if (depth > 8) return null;
  let value = null;
  parseMessage(reader, {
    1: (item, wire) => {
      if (wire === 2) value = item.string();
      else item.skip(wire);
    },
    2: (item, wire) => {
      if (wire === 0) value = item.varint() !== 0n;
      else item.skip(wire);
    },
    3: (item, wire) => {
      if (wire === 0) value = safeInteger(item.varint());
      else item.skip(wire);
    },
    4: (item, wire) => {
      if (wire === 1) value = item.double();
      else item.skip(wire);
    },
    5: (item, wire) => {
      if (wire !== 2) return item.skip(wire);
      const values = [];
      parseMessage(item.message(), {
        1: (array, arrayWire) => {
          if (arrayWire === 2) values.push(parseAnyValue(array.message(), depth + 1));
          else array.skip(arrayWire);
        },
      });
      value = values;
    },
    6: (item, wire) => {
      if (wire !== 2) return item.skip(wire);
      value = parseKeyValueList(item.message(), depth + 1);
    },
    7: (item, wire) => {
      if (wire === 2) value = { bytesLength: item.bytes().length };
      else item.skip(wire);
    },
  });
  return value;
}

function parseKeyValue(reader, depth = 0) {
  let key = "";
  let value = null;
  parseMessage(reader, {
    1: (item, wire) => {
      if (wire === 2) key = item.string();
      else item.skip(wire);
    },
    2: (item, wire) => {
      if (wire === 2) value = parseAnyValue(item.message(), depth + 1);
      else item.skip(wire);
    },
  });
  return key ? [key, value] : null;
}

function parseKeyValueList(reader, depth = 0) {
  const result = {};
  parseMessage(reader, {
    1: (item, wire) => {
      if (wire !== 2) return item.skip(wire);
      const pair = parseKeyValue(item.message(), depth + 1);
      if (pair) result[pair[0]] = pair[1];
    },
  });
  return result;
}

function parseResource(reader) {
  const attributes = {};
  parseMessage(reader, {
    1: (item, wire) => {
      if (wire !== 2) return item.skip(wire);
      const pair = parseKeyValue(item.message());
      if (pair) attributes[pair[0]] = pair[1];
    },
  });
  return attributes;
}

function parseInstrumentationScope(reader) {
  const scope = { name: "", version: "", attributes: {} };
  parseMessage(reader, {
    1: (item, wire) => (wire === 2 ? (scope.name = item.string()) : item.skip(wire)),
    2: (item, wire) => (wire === 2 ? (scope.version = item.string()) : item.skip(wire)),
    3: (item, wire) => {
      if (wire !== 2) return item.skip(wire);
      const pair = parseKeyValue(item.message());
      if (pair) scope.attributes[pair[0]] = pair[1];
    },
  });
  return scope;
}

function parseNumberDataPoint(reader) {
  const point = { attributes: {}, startTime: null, time: null, value: null };
  parseMessage(reader, {
    2: (item, wire) => (wire === 1 ? (point.startTime = unixNano(item.fixed64())) : item.skip(wire)),
    3: (item, wire) => (wire === 1 ? (point.time = unixNano(item.fixed64())) : item.skip(wire)),
    4: (item, wire) => (wire === 1 ? (point.value = item.double()) : item.skip(wire)),
    6: (item, wire) => (wire === 1 ? (point.value = safeInteger(item.fixed64())) : item.skip(wire)),
    7: (item, wire) => {
      if (wire !== 2) return item.skip(wire);
      const pair = parseKeyValue(item.message());
      if (pair) point.attributes[pair[0]] = pair[1];
    },
  });
  return point;
}

function parseHistogramDataPoint(reader) {
  const point = {
    attributes: {},
    startTime: null,
    time: null,
    count: 0,
    sum: null,
    min: null,
    max: null,
  };
  parseMessage(reader, {
    2: (item, wire) => (wire === 1 ? (point.startTime = unixNano(item.fixed64())) : item.skip(wire)),
    3: (item, wire) => (wire === 1 ? (point.time = unixNano(item.fixed64())) : item.skip(wire)),
    4: (item, wire) => (wire === 1 ? (point.count = safeInteger(item.fixed64())) : item.skip(wire)),
    5: (item, wire) => (wire === 1 ? (point.sum = item.double()) : item.skip(wire)),
    9: (item, wire) => {
      if (wire !== 2) return item.skip(wire);
      const pair = parseKeyValue(item.message());
      if (pair) point.attributes[pair[0]] = pair[1];
    },
    11: (item, wire) => (wire === 1 ? (point.min = item.double()) : item.skip(wire)),
    12: (item, wire) => (wire === 1 ? (point.max = item.double()) : item.skip(wire)),
  });
  return point;
}

function parseNumberInstrument(reader) {
  const result = { temporality: null, monotonic: null, points: [] };
  parseMessage(reader, {
    1: (item, wire) => {
      if (wire === 2) result.points.push(parseNumberDataPoint(item.message()));
      else item.skip(wire);
    },
    2: (item, wire) => (wire === 0 ? (result.temporality = Number(item.varint())) : item.skip(wire)),
    3: (item, wire) => (wire === 0 ? (result.monotonic = item.varint() !== 0n) : item.skip(wire)),
  });
  return result;
}

function parseHistogram(reader) {
  const result = { temporality: null, points: [] };
  parseMessage(reader, {
    1: (item, wire) => {
      if (wire === 2) result.points.push(parseHistogramDataPoint(item.message()));
      else item.skip(wire);
    },
    2: (item, wire) => (wire === 0 ? (result.temporality = Number(item.varint())) : item.skip(wire)),
  });
  return result;
}

function parseMetric(reader) {
  const metric = { name: "", description: "", unit: "", type: "unknown", temporality: null, points: [] };
  parseMessage(reader, {
    1: (item, wire) => (wire === 2 ? (metric.name = item.string()) : item.skip(wire)),
    2: (item, wire) => (wire === 2 ? (metric.description = item.string()) : item.skip(wire)),
    3: (item, wire) => (wire === 2 ? (metric.unit = item.string()) : item.skip(wire)),
    5: (item, wire) => {
      if (wire !== 2) return item.skip(wire);
      metric.type = "gauge";
      Object.assign(metric, parseNumberInstrument(item.message()));
      metric.temporality = null;
      metric.monotonic = null;
    },
    7: (item, wire) => {
      if (wire !== 2) return item.skip(wire);
      metric.type = "sum";
      Object.assign(metric, parseNumberInstrument(item.message()));
    },
    9: (item, wire) => {
      if (wire !== 2) return item.skip(wire);
      metric.type = "histogram";
      Object.assign(metric, parseHistogram(item.message()));
    },
  });
  return metric;
}

function parseScopeMetrics(reader) {
  const result = { scope: { name: "", version: "", attributes: {} }, metrics: [] };
  parseMessage(reader, {
    1: (item, wire) => {
      if (wire === 2) result.scope = parseInstrumentationScope(item.message());
      else item.skip(wire);
    },
    2: (item, wire) => {
      if (wire === 2) result.metrics.push(parseMetric(item.message()));
      else item.skip(wire);
    },
  });
  return result;
}

function parseResourceMetrics(reader) {
  const result = { resource: {}, scopes: [] };
  parseMessage(reader, {
    1: (item, wire) => {
      if (wire === 2) result.resource = parseResource(item.message());
      else item.skip(wire);
    },
    2: (item, wire) => {
      if (wire === 2) result.scopes.push(parseScopeMetrics(item.message()));
      else item.skip(wire);
    },
  });
  return result;
}

export function decodeMetricsRequest(buffer) {
  const resources = [];
  parseMessage(new Reader(buffer), {
    1: (item, wire) => {
      if (wire === 2) resources.push(parseResourceMetrics(item.message()));
      else item.skip(wire);
    },
  });
  return { resources };
}

function parseLogRecord(reader) {
  const record = {
    time: null,
    observedTime: null,
    severityNumber: null,
    severityText: "",
    body: null,
    attributes: {},
  };
  parseMessage(reader, {
    1: (item, wire) => (wire === 1 ? (record.time = unixNano(item.fixed64())) : item.skip(wire)),
    2: (item, wire) => (wire === 0 ? (record.severityNumber = Number(item.varint())) : item.skip(wire)),
    3: (item, wire) => (wire === 2 ? (record.severityText = item.string()) : item.skip(wire)),
    5: (item, wire) => {
      if (wire === 2) record.body = parseAnyValue(item.message());
      else item.skip(wire);
    },
    6: (item, wire) => {
      if (wire !== 2) return item.skip(wire);
      const pair = parseKeyValue(item.message());
      if (pair) record.attributes[pair[0]] = pair[1];
    },
    11: (item, wire) => (wire === 1 ? (record.observedTime = unixNano(item.fixed64())) : item.skip(wire)),
  });
  return record;
}

function parseScopeLogs(reader) {
  const result = { scope: { name: "", version: "", attributes: {} }, records: [] };
  parseMessage(reader, {
    1: (item, wire) => {
      if (wire === 2) result.scope = parseInstrumentationScope(item.message());
      else item.skip(wire);
    },
    2: (item, wire) => {
      if (wire === 2) result.records.push(parseLogRecord(item.message()));
      else item.skip(wire);
    },
  });
  return result;
}

function parseResourceLogs(reader) {
  const result = { resource: {}, scopes: [] };
  parseMessage(reader, {
    1: (item, wire) => {
      if (wire === 2) result.resource = parseResource(item.message());
      else item.skip(wire);
    },
    2: (item, wire) => {
      if (wire === 2) result.scopes.push(parseScopeLogs(item.message()));
      else item.skip(wire);
    },
  });
  return result;
}

export function decodeLogsRequest(buffer) {
  const resources = [];
  parseMessage(new Reader(buffer), {
    1: (item, wire) => {
      if (wire === 2) resources.push(parseResourceLogs(item.message()));
      else item.skip(wire);
    },
  });
  return { resources };
}
