// Minimal JSONL logger: file (append stream) + stdout. Zero deps. child()
// merges extra fields into every call so the orchestrator can scope each
// cycle by account name. beforeExit drains the stream so SIGINT-after-write
// does not lose the last lines.

import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createLogger(filePath) {
  if (filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const stream = filePath ? createWriteStream(filePath, { flags: "a" }) : null;
  if (stream) {
    stream.on("error", (err) => {
      console.error(`[logger] stream error: ${err.message}`);
    });
  }

  let drainPromise = null;
  function drain() {
    if (drainPromise) return drainPromise;
    if (!stream) return Promise.resolve();
    drainPromise = new Promise((res) => stream.end(res));
    return drainPromise;
  }
  process.once("beforeExit", () => { drain(); });

  function emit(level, event, fields) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    });
    if (level === "error") console.error(line);
    else console.log(line);
    if (stream) stream.write(line + "\n");
  }

  function build(baseFields) {
    return {
      info: (event, fields) => emit("info", event, { ...baseFields, ...fields }),
      warn: (event, fields) => emit("warn", event, { ...baseFields, ...fields }),
      error: (event, fields) => emit("error", event, { ...baseFields, ...fields }),
      child: (extra) => build({ ...baseFields, ...extra }),
      drain,
    };
  }

  return build({});
}
