/**
 * Mock vscode namespace for unit testing outside of VS Code.
 * Provides minimal implementations of the APIs used by headsdown-vscode.
 */

import { vi } from "vitest";

// === Status Bar ===

export class MockStatusBarItem {
  text = "";
  tooltip: unknown = "";
  color: unknown = undefined;
  backgroundColor: unknown = undefined;
  command: string | undefined = undefined;
  alignment = 2; // StatusBarAlignment.Right
  priority = 50;
  name: string | undefined = undefined;
  accessibilityInformation: unknown = undefined;

  show = vi.fn();
  hide = vi.fn();
  dispose = vi.fn();
}

// === ThemeColor ===

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

// === MarkdownString ===

export class MarkdownString {
  isTrusted = false;
  supportThemeIcons = false;

  constructor(public value: string = "") {}

  appendMarkdown(value: string): this {
    this.value += value;
    return this;
  }

  appendText(value: string): this {
    this.value += value;
    return this;
  }
}

// === Uri ===

export class Uri {
  private constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
    public readonly query: string,
    public readonly fragment: string,
  ) {}

  static parse(value: string): Uri {
    try {
      const url = new URL(value);
      return new Uri(url.protocol.replace(":", ""), url.host, url.pathname, url.search, url.hash);
    } catch {
      return new Uri("", "", value, "", "");
    }
  }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}${this.query}${this.fragment}`;
  }
}

// === Event Emitter ===

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];

  event = (listener: (e: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(data: T): void {
    this.listeners.forEach((l) => l(data));
  }

  dispose(): void {
    this.listeners = [];
  }
}

// === Output Channel ===

export class MockOutputChannel {
  name: string;
  lines: string[] = [];

  constructor(name: string) {
    this.name = name;
  }

  appendLine = vi.fn((value: string) => {
    this.lines.push(value);
  });
  append = vi.fn();
  clear = vi.fn();
  show = vi.fn();
  hide = vi.fn();
  dispose = vi.fn();
  replace = vi.fn();
}

// === Disposable ===

export class Disposable {
  constructor(private callOnDispose: () => void) {}
  dispose(): void {
    this.callOnDispose();
  }
  static from(...disposables: { dispose: () => void }[]): Disposable {
    return new Disposable(() => disposables.forEach((d) => d.dispose()));
  }
}

// === Configuration ===

export class MockWorkspaceConfiguration {
  private values: Record<string, unknown> = {};
  private globalValues: Record<string, unknown> = {};
  private workspaceValues: Record<string, unknown> = {};
  private defaults: Record<string, unknown> = {};

  constructor(defaults: Record<string, unknown> = {}) {
    this.defaults = defaults;
    this.values = { ...defaults };
  }

  get<T>(key: string, defaultValue?: T): T {
    const value = this.values[key];
    return (value !== undefined ? value : defaultValue) as T;
  }

  has(key: string): boolean {
    return key in this.values;
  }

  inspect<T>(key: string):
    | {
        defaultValue?: T;
        globalValue?: T;
        workspaceValue?: T;
      }
    | undefined {
    return {
      defaultValue: this.defaults[key] as T | undefined,
      globalValue: this.globalValues[key] as T | undefined,
      workspaceValue: this.workspaceValues[key] as T | undefined,
    };
  }

  update = vi.fn();

  /** Test helpers */
  _setGlobal(key: string, value: unknown): void {
    this.globalValues[key] = value;
    this.values[key] = value;
  }

  _setWorkspace(key: string, value: unknown): void {
    this.workspaceValues[key] = value;
    this.values[key] = value;
  }

  _setValue(key: string, value: unknown): void {
    this.values[key] = value;
  }
}

// === Window ===

const documentChangeEmitter = new EventEmitter<unknown>();

export const window = {
  createStatusBarItem: vi.fn(() => new MockStatusBarItem()),
  createOutputChannel: vi.fn((name: string) => new MockOutputChannel(name)),
  createQuickPick: vi.fn(() => ({
    title: "",
    placeholder: "",
    items: [],
    buttons: [],
    selectedItems: [],
    onDidTriggerButton: vi.fn(),
    onDidAccept: vi.fn(),
    onDidHide: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  })),
  createWebviewPanel: vi.fn(() => ({
    iconPath: undefined,
    reveal: vi.fn(),
    onDidDispose: vi.fn(),
    webview: {
      html: "",
      cspSource: "vscode-resource:",
      postMessage: vi.fn(),
      onDidReceiveMessage: vi.fn(),
    },
    dispose: vi.fn(),
  })),
  showInformationMessage: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
  showWarningMessage: vi.fn(async () => undefined),
  showQuickPick: vi.fn(),
  withProgress: vi.fn(),
};

// === Workspace ===

const configMap = new Map<string, MockWorkspaceConfiguration>();

export const workspace = {
  workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
  getConfiguration: vi.fn((section?: string) => {
    const key = section ?? "";
    if (!configMap.has(key)) {
      configMap.set(key, new MockWorkspaceConfiguration());
    }
    return configMap.get(key)!;
  }),
  onDidChangeTextDocument: documentChangeEmitter.event,
  onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  _documentChangeEmitter: documentChangeEmitter,
  _setConfig: (section: string, config: MockWorkspaceConfiguration) => {
    configMap.set(section, config);
  },
  _clearConfigs: () => configMap.clear(),
};

// === Commands ===

export const commands = {
  registerCommand: vi.fn((_command: string, _callback: (...args: unknown[]) => unknown) => ({
    dispose: vi.fn(),
  })),
  executeCommand: vi.fn(),
};

// === Env ===

export const env = {
  openExternal: vi.fn(),
  sessionId: "mock-session-id",
  isAppPortable: false,
  clipboard: {
    writeText: vi.fn(),
  },
};

// === Enums ===

export const StatusBarAlignment = {
  Left: 1,
  Right: 2,
};

export const ProgressLocation = {
  SourceControl: 1,
  Window: 10,
  Notification: 15,
};

export const ViewColumn = {
  One: 1,
  Two: 2,
  Three: 3,
};

export const QuickInputButtonLocation = {
  Title: 1,
  Inline: 2,
  Input: 3,
};
