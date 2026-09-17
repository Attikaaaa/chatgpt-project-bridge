import { EventEmitter } from "node:events"

export type LogLevel = "error" | "warn" | "info" | "debug"

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

export interface LogFields {
  [key: string]: unknown
}

class Logger extends EventEmitter {
  level: LogLevel = (process.env.CGPT_LOG_LEVEL as LogLevel) || "info"
  verboseBodies = false
  private runId = Math.random().toString(36).slice(2, 10)

  setLevel(level: LogLevel) {
    this.level = level
  }

  private write(level: LogLevel, msg: string, fields?: LogFields) {
    if (LEVELS[level] > LEVELS[this.level]) return
    const entry = {
      ts: new Date().toISOString(),
      level,
      run: this.runId,
      msg,
      ...fields,
    }
    const line = JSON.stringify(entry)
    // stderr for CLI visibility; a log-file sink is attached by the daemon.
    process.stderr.write(line + "\n")
    this.emit("entry", entry)
  }

  error(msg: string, fields?: LogFields) {
    this.write("error", msg, fields)
  }
  warn(msg: string, fields?: LogFields) {
    this.write("warn", msg, fields)
  }
  info(msg: string, fields?: LogFields) {
    this.write("info", msg, fields)
  }
  debug(msg: string, fields?: LogFields) {
    this.write("debug", msg, fields)
  }
  /** Debug logging of prompt bodies requires the explicit unsafe flag. */
  body(msg: string, fields?: LogFields) {
    if (!this.verboseBodies) return
    this.write("debug", msg, fields)
  }
}

export const log = new Logger()
