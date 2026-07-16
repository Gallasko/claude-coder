import { vi } from 'vitest';

/** Mutable, test-controlled state backing the stubs below. Reset with __reset() in afterEach/beforeEach. */
export const __state = {
  config: {} as Record<string, unknown>,
  workspaceFolders: [{ uri: { fsPath: '/workspace' } }] as any[] | undefined,
  diagnostics: new Map<string, any[]>(),
  tabs: [] as any[],
  findFilesResult: [] as Uri[],
};

export function __reset(): void {
  __state.config = {};
  __state.workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
  __state.diagnostics = new Map();
  __state.tabs = [];
  __state.findFilesResult = [];
}

export class Uri {
  private constructor(
    public scheme: string,
    public fsPath: string,
    public path: string
  ) {}
  static file(p: string): Uri {
    return new Uri('file', p, p);
  }
  static parse(s: string): Uri {
    const idx = s.indexOf(':');
    const scheme = idx >= 0 ? s.slice(0, idx) : s;
    const rest = idx >= 0 ? s.slice(idx + 1) : '';
    return new Uri(scheme, rest, rest);
  }
  static joinPath(base: Uri, ...segs: string[]): Uri {
    return Uri.file([base.fsPath, ...segs].join('/'));
  }
  toString(): string {
    return `${this.scheme}:${this.path}`;
  }
}

export class TabInputText {
  constructor(public uri: Uri) {}
}
export class TabInputTextDiff {
  constructor(
    public original: Uri,
    public modified: Uri
  ) {}
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
}
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}
export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}
export enum InputBoxValidationSeverity {
  Info = 1,
  Warning = 2,
  Error = 3,
}
export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
  Struct = 22,
  EnumMember = 23,
}

export interface Diagnostic {
  range: { start: { line: number } };
  severity: DiagnosticSeverity;
  message: string;
}

export interface ExtensionContext {
  subscriptions: { dispose(): void }[];
  globalStorageUri: { fsPath: string };
  secrets: { get(key: string): Thenable<string | undefined>; store(key: string, value: string): Thenable<void> };
}

export const workspace = {
  get workspaceFolders() {
    return __state.workspaceFolders;
  },
  getConfiguration: (_section?: string) => ({
    get: (key: string, dflt?: unknown) => (__state.config[key] !== undefined ? __state.config[key] : dflt),
    update: vi.fn(async () => undefined),
  }),
  findFiles: vi.fn(async (..._args: unknown[]) => __state.findFilesResult),
  asRelativePath: (u: Uri | string) => {
    const p = typeof u === 'string' ? u : u.fsPath;
    const root = __state.workspaceFolders?.[0]?.uri.fsPath;
    return root && p.startsWith(root) ? p.slice(root.length + 1) : p;
  },
  openTextDocument: vi.fn(async (uri: Uri) => ({ uri })),
  registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
  fs: {
    stat: vi.fn(async () => ({ mtime: 0 })),
  },
};

export const window = {
  createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
  createStatusBarItem: vi.fn(() => ({
    text: '',
    tooltip: '',
    command: '',
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  })),
  createWebviewPanel: vi.fn(() => ({
    webview: { html: '', postMessage: vi.fn(), onDidReceiveMessage: vi.fn(), asWebviewUri: (u: Uri) => u, cspSource: '' },
    onDidDispose: vi.fn(),
    reveal: vi.fn(),
    dispose: vi.fn(),
  })),
  showInformationMessage: vi.fn(async () => undefined),
  showWarningMessage: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
  showInputBox: vi.fn(async () => undefined),
  showQuickPick: vi.fn(async () => undefined),
  showTextDocument: vi.fn(async () => undefined),
  withProgress: vi.fn(async (_opts: unknown, task: (...a: any[]) => Promise<any>) => task({ report: vi.fn() })),
  terminals: [] as { name: string; exitStatus: unknown; show: () => void }[],
  createTerminal: vi.fn(() => ({ name: 'mock', exitStatus: undefined, show: vi.fn() })),
  tabGroups: {
    get all() {
      return [{ tabs: __state.tabs }];
    },
    close: vi.fn(async () => true),
  },
};

export const commands = { executeCommand: vi.fn(async () => undefined) };

export const languages = {
  getDiagnostics: vi.fn((uri?: Uri) =>
    uri
      ? (__state.diagnostics.get(uri.toString()) ?? [])
      : [...__state.diagnostics.entries()].map(([k, v]) => [Uri.parse(k), v])
  ),
};

export const env = {
  openExternal: vi.fn(async () => true),
};
