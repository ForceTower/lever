/**
 * Structured JSON logging: LogLayer over pino (spec 0001 §9.2). A per-request
 * child logger is bound via AsyncLocalStorage so every line in a request
 * shares its context (request id, environment id once authenticated). Single
 * node, `docker logs` is the observability story; this module is the seam for
 * any future transport.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { PinoTransport } from "@loglayer/transport-pino";
import { LogLayer, type ILogLayer } from "loglayer";
import { pino } from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error";

const requestLogger = new AsyncLocalStorage<ILogLayer>();

let root: ILogLayer | undefined;

export function initLogger(level: LogLevel): ILogLayer {
  root = new LogLayer({ transport: new PinoTransport({ logger: pino({ level }) }) });
  return root;
}

/** The request-scoped child when inside `runWithLogger`, the root otherwise. */
export function getLogger(): ILogLayer {
  return requestLogger.getStore() ?? root ?? initLogger("info");
}

export function runWithLogger<T>(context: Record<string, string>, fn: () => T): T {
  return requestLogger.run(getLogger().child().withContext(context), fn);
}
