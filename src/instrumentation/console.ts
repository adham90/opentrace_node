type LogFn = (...args: unknown[]) => void;

let installed = false;
let originalLog: LogFn | null = null;
let originalWarn: LogFn | null = null;
let originalError: LogFn | null = null;

interface ConsoleForwarder {
  (level: string, message: string, metadata: Record<string, unknown>): void;
}

let forwarder: ConsoleForwarder | null = null;

export function installConsoleCapture(forward: ConsoleForwarder): void {
  if (installed) return;
  installed = true;
  forwarder = forward;

  originalLog = console.log;
  originalWarn = console.warn;
  originalError = console.error;

  console.log = function (...args: unknown[]) {
    originalLog!.apply(console, args);
    safeForward('info', args);
  };

  console.warn = function (...args: unknown[]) {
    originalWarn!.apply(console, args);
    safeForward('warn', args);
  };

  console.error = function (...args: unknown[]) {
    originalError!.apply(console, args);
    safeForward('error', args);
  };
}

export function uninstallConsoleCapture(): void {
  if (!installed) return;
  installed = false;
  if (originalLog) console.log = originalLog;
  if (originalWarn) console.warn = originalWarn;
  if (originalError) console.error = originalError;
  originalLog = null;
  originalWarn = null;
  originalError = null;
  forwarder = null;
}

function safeForward(level: string, args: unknown[]): void {
  try {
    if (!forwarder) return;
    const message = args.map(formatArg).join(' ');
    forwarder(level, message, { source: 'console' });
  } catch {
    // Never throw
  }
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
