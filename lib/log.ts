/**
 * Tiny logging shim that silences `debug` and `warn` in production while
 * leaving `error` always-on. Use this instead of `console.*` for anything
 * that's chatty or development-only.
 *
 *   log.debug("[pods/page] status response", data);  // dev-only
 *   log.warn("recoverable race condition", details); // dev-only
 *   log.error("Could not load profile", error);      // always logs
 *
 * Rationale: the previous pods code shipped ~150 `console.log/warn` calls
 * straight to production, which made the browser console useless for real
 * debugging. This keeps the debug breadcrumbs available locally without
 * polluting the user-facing console.
 *
 * Real errors stay on `console.error` because (a) they signal genuine
 * failures users may need to report and (b) error-tracking integrations
 * (Sentry-style) hook the global `console.error` to capture them.
 */

const isDev = process.env.NODE_ENV !== "production";

type LogFn = (...args: unknown[]) => void;

const noop: LogFn = () => {};

export const log = {
  debug: (isDev ? console.log.bind(console) : noop) as LogFn,
  warn: (isDev ? console.warn.bind(console) : noop) as LogFn,
  error: console.error.bind(console) as LogFn,
};
