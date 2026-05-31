import type { BrowserWindow, IpcMainInvokeEvent, IpcMainEvent, WebContents } from "electron"

/**
 * Create a minimal mock function that tracks calls.
 * Avoids importing bun:test or jest in the utils file.
 */
type MockFn<T extends (...args: any[]) => any> = T & {
  _impl?: T
  mock: { calls: Array<{ args: any[]; this: any }> }
  mockReturnValue: (val: ReturnType<T>) => MockFn<T>
  mockImplementation: (impl: T) => MockFn<T>
  mockReset: () => void
}

export function mockFn<T extends (...args: any[]) => any = (...args: any[]) => any>() {
  const calls: Array<{ args: any[]; this: any }> = []
  const fn = ((...args: any[]) => {
    const ctx = { args, this: fn }
    calls.push(ctx)
    // @ts-ignore — default implementation returns undefined
    return fn._impl?.(...args)
  }) as MockFn<T>

  fn.mock = { calls }
  fn.mockReturnValue = (val: ReturnType<T>) => {
    fn._impl = (() => val) as T
    return fn
  }
  fn.mockImplementation = (impl: T) => {
    fn._impl = impl
    return fn
  }
  fn.mockReset = () => {
    calls.length = 0
    fn._impl = undefined
  }
  return fn
}

export type MockIpcHandler = {
  channel: string
  handler: (...args: any[]) => any
}

export type MockElectron = {
  ipcMain: {
    handle: ReturnType<typeof mockFn>
    on: ReturnType<typeof mockFn>
    removeHandler: ReturnType<typeof mockFn>
    _handlers: Map<string, (...args: any[]) => any>
    _listeners: Map<string, (...args: any[]) => void>
  }
  BrowserWindow: {
    getAllWindows: ReturnType<typeof mockFn>
    fromWebContents: ReturnType<typeof mockFn>
  }
  app: {
    getPath: ReturnType<typeof mockFn>
    isPackaged: boolean
    relaunch: ReturnType<typeof mockFn>
    exit: ReturnType<typeof mockFn>
    quit: ReturnType<typeof mockFn>
    on: ReturnType<typeof mockFn>
    dock: { setIcon: ReturnType<typeof mockFn> }
  }
  dialog: {
    showSaveDialog: ReturnType<typeof mockFn>
    showOpenDialog: ReturnType<typeof mockFn>
    showMessageBox: ReturnType<typeof mockFn>
  }
  shell: {
    openExternal: ReturnType<typeof mockFn>
    openPath: ReturnType<typeof mockFn>
  }
  clipboard: {
    readImage: ReturnType<typeof mockFn>
  }
  Notification: ReturnType<typeof mockFn> & { prototype: any }
  nativeTheme: {
    shouldUseDarkColors: boolean
    on: ReturnType<typeof mockFn>
  }
  safeStorage: {
    encryptString: ReturnType<typeof mockFn>
    decryptString: ReturnType<typeof mockFn>
    isEncryptionAvailable: ReturnType<typeof mockFn>
  }
  net: {
    fetch: ReturnType<typeof mockFn>
  }
}

export function createMockIpcMainInvokeEvent(sender?: Partial<WebContents>): IpcMainInvokeEvent {
  return {
    sender: createMockWebContents(sender),
    frameId: 1,
    processId: 1,
    ports: [],
    reply: () => {},
  } as unknown as IpcMainInvokeEvent
}

export function createMockIpcMainEvent(sender?: Partial<WebContents>): IpcMainEvent {
  return {
    sender: createMockWebContents(sender),
    frameId: 1,
    processId: 1,
    ports: [],
    reply: () => {},
  } as unknown as IpcMainEvent
}

export function createMockWebContents(overrides?: Partial<WebContents>): WebContents {
  return {
    send: overrides?.send ?? (() => {}),
    getZoomFactor: overrides?.getZoomFactor ?? (() => 1),
    setZoomFactor: overrides?.setZoomFactor ?? (() => {}),
    getURL: overrides?.getURL ?? (() => "https://app.opencode.ai"),
    id: 1,
    session: {} as any,
    ...overrides,
  } as unknown as WebContents
}

export function createMockBrowserWindow(overrides?: Partial<BrowserWindow>): BrowserWindow {
  const webContents = overrides?.webContents ?? createMockWebContents()
  return {
    isDestroyed: overrides?.isDestroyed ?? (() => false),
    focus: overrides?.focus ?? (() => {}),
    show: overrides?.show ?? (() => {}),
    isFocused: overrides?.isFocused ?? (() => true),
    setBackgroundColor: overrides?.setBackgroundColor ?? (() => {}),
    setTitleBarOverlay: overrides?.setTitleBarOverlay ?? (() => {}),
    loadURL: overrides?.loadURL ?? (async () => {}),
    webContents,
    id: 1,
    on: () => {},
    once: () => {},
    ...overrides,
  } as unknown as BrowserWindow
}

export function createElectronMock(): MockElectron {
  const handlers = new Map<string, (...args: any[]) => any>()
  const listeners = new Map<string, (...args: any[]) => void>()
  const mockWin = createMockBrowserWindow()

  const ipcHandle = mockFn<(channel: string, handler: (...args: any[]) => any) => void>()
  ipcHandle.mockImplementation((channel: string, handler: (...args: any[]) => any) => {
    handlers.set(channel, handler)
  })

  const ipcOn = mockFn<(channel: string, listener: (...args: any[]) => void) => void>()
  ipcOn.mockImplementation((channel: string, listener: (...args: any[]) => void) => {
    listeners.set(channel, listener)
  })

  const ipcRemoveHandler = mockFn<(channel: string) => void>()
  ipcRemoveHandler.mockImplementation((channel: string) => {
    handlers.delete(channel)
  })

  const clipboardReadImage = mockFn<() => any>()
  clipboardReadImage.mockReturnValue({
    isEmpty: () => true,
    toPNG: () => ({ buffer: Buffer.alloc(0) }),
    getSize: () => ({ width: 0, height: 0 }),
  })

  const notifMock = mockFn<any>()
  notifMock.mockImplementation(function (this: any, opts: { title: string; body?: string }) {
    this.title = opts.title
    this.body = opts.body
    this.show = () => {}
  })

  const safeEncrypt = mockFn<(plain: string) => Buffer>()
  safeEncrypt.mockImplementation((plain: string) => Buffer.from(`encrypted:${plain}`))

  const safeDecrypt = mockFn<(enc: Buffer) => string>()
  safeDecrypt.mockImplementation((enc: Buffer) => {
    const str = enc.toString()
    if (!str.startsWith("encrypted:")) throw new Error("Decrypt failed")
    return str.slice("encrypted:".length)
  })

  return {
    ipcMain: {
      handle: ipcHandle,
      on: ipcOn,
      removeHandler: ipcRemoveHandler,
      _handlers: handlers,
      _listeners: listeners,
    },
    BrowserWindow: {
      getAllWindows: mockFn<() => BrowserWindow[]>().mockReturnValue([mockWin]),
      fromWebContents: mockFn<() => BrowserWindow | null>().mockReturnValue(mockWin),
    },
    app: {
      getPath: mockFn<(name: string) => string>().mockReturnValue("/mock/user-data/settings"),
      isPackaged: false,
      relaunch: mockFn(),
      exit: mockFn(),
      quit: mockFn(),
      on: mockFn(),
      dock: { setIcon: mockFn() },
    },
    dialog: {
      showSaveDialog: mockFn().mockReturnValue(Promise.resolve({ canceled: true, filePath: undefined })),
      showOpenDialog: mockFn().mockReturnValue(Promise.resolve({ canceled: true, filePaths: [] })),
      showMessageBox: mockFn().mockReturnValue(Promise.resolve({ response: 0 })),
    },
    shell: {
      openExternal: mockFn().mockReturnValue(Promise.resolve()),
      openPath: mockFn().mockReturnValue(Promise.resolve("")),
    },
    clipboard: {
      readImage: clipboardReadImage,
    },
    Notification: notifMock,
    nativeTheme: {
      shouldUseDarkColors: false,
      on: mockFn(),
    },
    safeStorage: {
      encryptString: safeEncrypt,
      decryptString: safeDecrypt,
      isEncryptionAvailable: mockFn<() => boolean>().mockReturnValue(true),
    },
    net: {
      fetch: mockFn().mockReturnValue(Promise.resolve(new Response("ok"))),
    },
  }
}
