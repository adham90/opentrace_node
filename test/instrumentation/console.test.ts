import { describe, it, expect, afterEach } from 'vitest';
import { installConsoleCapture, uninstallConsoleCapture } from '../../src/instrumentation/console.js';

afterEach(() => {
  uninstallConsoleCapture();
});

describe('Console capture', () => {
  it('forwards console.log as info level', () => {
    const captured: { level: string; message: string }[] = [];
    installConsoleCapture((level, message) => {
      captured.push({ level, message });
    });

    console.log('hello', 'world');

    expect(captured).toHaveLength(1);
    expect(captured[0].level).toBe('info');
    expect(captured[0].message).toBe('hello world');
  });

  it('forwards console.warn as warn level', () => {
    const captured: { level: string; message: string }[] = [];
    installConsoleCapture((level, message) => {
      captured.push({ level, message });
    });

    console.warn('deprecation notice');

    expect(captured).toHaveLength(1);
    expect(captured[0].level).toBe('warn');
  });

  it('forwards console.error as error level', () => {
    const captured: { level: string; message: string }[] = [];
    installConsoleCapture((level, message) => {
      captured.push({ level, message });
    });

    console.error('something failed');

    expect(captured).toHaveLength(1);
    expect(captured[0].level).toBe('error');
  });

  it('still calls the original console methods', () => {
    const originalLog = console.log;
    let originalCalled = false;

    // Temporarily replace to detect calls
    console.log = (..._args: unknown[]) => { originalCalled = true; };

    installConsoleCapture(() => {});

    console.log('test');
    expect(originalCalled).toBe(true);

    uninstallConsoleCapture();
    // Restore
    console.log = originalLog;
  });

  it('formats objects as JSON', () => {
    const captured: { message: string }[] = [];
    installConsoleCapture((_level, message) => {
      captured.push({ message });
    });

    console.log('data:', { id: 1, name: 'test' });

    expect(captured[0].message).toContain('"id":1');
  });

  it('formats errors with stack', () => {
    const captured: { message: string }[] = [];
    installConsoleCapture((_level, message) => {
      captured.push({ message });
    });

    console.error(new Error('test error'));

    expect(captured[0].message).toContain('test error');
  });

  it('restores original methods on uninstall', () => {
    const originalLog = console.log;
    installConsoleCapture(() => {});
    expect(console.log).not.toBe(originalLog);

    uninstallConsoleCapture();
    expect(console.log).toBe(originalLog);
  });

  it('ignores duplicate install calls', () => {
    const captured: { message: string }[] = [];
    installConsoleCapture((_level, message) => {
      captured.push({ message });
    });
    // Second install should be ignored
    installConsoleCapture((_level, message) => {
      captured.push({ message });
      captured.push({ message }); // would double-push if installed twice
    });

    console.log('once');
    expect(captured).toHaveLength(1);
  });
});
