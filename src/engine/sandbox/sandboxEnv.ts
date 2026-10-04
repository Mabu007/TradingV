import { TradingContext } from '../../types/trading';

/**
 * Sandboxed Strategy Code Executor
 * Wraps user strategy function inside a secure closure that shadows
 * sensitive browser globals and network access primitives.
 */

const FORBIDDEN_GLOBALS = [
  'window',
  'document',
  'fetch',
  'WebSocket',
  'XMLHttpRequest',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'location',
  'top',
  'parent',
  'opener',
  'importScripts',
];

/**
 * Transpiles or prepares user TypeScript/JavaScript code for execution.
 * Handles `export default async function strategy(ctx) { ... }` or raw async code.
 */
export function prepareStrategyFunction(code: string): (ctx: TradingContext) => Promise<void> {
  // Strip import / export statements to allow dynamic sandbox execution
  let cleanedCode = code
    .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, '')
    .replace(/export\s+default\s+async\s+function(\s+[a-zA-Z0-9_$]+)?\s*\(/, 'async function strategy(')
    .replace(/export\s+default\s+function(\s+[a-zA-Z0-9_$]+)?\s*\(/, 'async function strategy(')
    .replace(/export\s+default\s+/, 'const strategy = ')
    .replace(/export\s+\{[^}]*\};?/g, '');

  // Strip TypeScript type annotations (basic regex for param types like `: TradingContext`, `: number`, etc.)
  cleanedCode = cleanedCode
    .replace(/:\s*TradingContext/g, '')
    .replace(/:\s*number\[\]/g, '')
    .replace(/:\s*number/g, '')
    .replace(/:\s*string/g, '')
    .replace(/:\s*boolean/g, '')
    .replace(/:\s*void/g, '')
    .replace(/:\s*any/g, '')
    .replace(/as\s+number/g, '')
    .replace(/!\s*\./g, '.')
    .replace(/!\s*\)/g, ')')
    .replace(/!\s*;/g, ';');

  // Build the sandboxed wrapper string with shadowed globals
  const shadowArgs = FORBIDDEN_GLOBALS.join(', ');
  const shadowValues = FORBIDDEN_GLOBALS.map(() => 'undefined').join(', ');

  const wrapperCode = `
    return (function(${shadowArgs}) {
      return (async function(ctx) {
        "use strict";
        ${cleanedCode}
        if (typeof strategy === 'function') {
          return await strategy(ctx);
        }
      });
    })(${shadowValues});
  `;

  try {
    const factory = new Function(wrapperCode);
    return factory();
  } catch (err: unknown) {
    throw new Error(`Strategy Compilation Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Create a Web Worker Blob URL for running strategies in background isolation
 */
export function createWorkerBlobScript(): string {
  return `
    self.onmessage = async function(e) {
      const { type, code, contextData } = e.data;
      if (type === 'EXECUTE') {
        try {
          // Shadow forbidden globals inside worker scope
          const fetch = undefined;
          const XMLHttpRequest = undefined;
          const WebSocket = undefined;
          const indexedDB = undefined;
          const importScripts = undefined;

          // Strategy execution bridge
          self.postMessage({ type: 'STATUS', status: 'RUNNING' });
        } catch (err) {
          self.postMessage({ type: 'ERROR', message: err.message });
        }
      }
    };
  `;
}
