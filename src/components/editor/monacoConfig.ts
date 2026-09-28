import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

// In monaco-editor 0.52+, typescript is exported as monaco.typescript
// Ensure monaco.languages.typescript aliases to monaco.typescript for backward compatibility
if (monaco && (monaco as any).typescript) {
  if (monaco.languages && !(monaco.languages as any).typescript) {
    (monaco.languages as any).typescript = (monaco as any).typescript;
  }
}

// Configure Monaco Environment with safe mock worker for sandboxed iframe
if (typeof window !== 'undefined') {
  (window as any).MonacoEnvironment = {
    getWorker() {
      return {
        postMessage() {},
        addEventListener() {},
        removeEventListener() {},
        terminate() {},
      };
    },
  };
}

loader.config({ monaco });

export { monaco };
