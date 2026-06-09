import * as S from "../schema-compat"
import type { IpcMethodContract } from "../registry"

// ── Shared picker option schemas ──

/** Base picker options — title and defaultPath bounded to 512 characters */
const PickerOptsBase = S.Struct({
  multiple: S.Optional(S.Bool),
  title: S.Optional(S.Str),
  defaultPath: S.Optional(S.Str),
})

/** File picker options — adds accept MIME types and file-extension filters (max 32 extensions) */
const FilePickerOpts = S.Struct({
  multiple: S.Optional(S.Bool),
  title: S.Optional(S.Str),
  defaultPath: S.Optional(S.Str),
  accept: S.Optional(S.Arr(S.Str)),
  extensions: S.Optional(S.Arr(S.Str)),
})

/** Save picker options */
const SavePickerOpts = S.Struct({
  title: S.Optional(S.Str),
  defaultPath: S.Optional(S.Str),
})

// ── Parameter schemas ──

const OpenDirectoryPickerParams = PickerOptsBase
const OpenFilePickerParams = FilePickerOpts
const SaveFilePickerParams = SavePickerOpts
const OpenPathParams = S.Tuple([S.Str, S.Optional(S.Str)])
const ReadClipboardParams = S.Struct({})

// ── Success schemas ──

/** Picker returns a single path, an array of paths (multi-select), or null (cancelled). */
const PickerResult = S.Nullable(S.Union([S.Str, S.Arr(S.Str)]))

/** Single-result picker returns a path or null (cancelled). */
const SinglePickerResult = S.Nullable(S.Str)

/** openPath returns void on success; failures are communicated via error codes. */
const OpenPathSuccess = S.UndefinedConst

/** Clipboard image data — buffer is an opaque platform handle / ArrayBuffer. */
const ClipboardImageResult = S.Nullable(
  S.Struct({
    buffer: S.Unknown,
    width: S.Num,
    height: S.Num,
  }),
)

// ── Contracts ──

export const contracts: readonly IpcMethodContract[] = [
  {
    channel: "tribunus:fs:open-directory-picker",
    method: "fs.openDirectoryPicker",
    params: OpenDirectoryPickerParams,
    success: PickerResult,
    category: "fs",
    timeout: "standard",
    sensitivity: "internal",
    senderPolicy: "standard",
    errors: ["invalid_request", "unsupported", "internal"],
    description: "Open a native directory picker dialog. Returns selected path(s) or null if cancelled.",
  },
  {
    channel: "tribunus:fs:open-file-picker",
    method: "fs.openFilePicker",
    params: OpenFilePickerParams,
    success: PickerResult,
    category: "fs",
    timeout: "standard",
    sensitivity: "internal",
    senderPolicy: "standard",
    errors: ["invalid_request", "unsupported", "internal"],
    description: "Open a native file picker dialog with optional MIME/extension filters. Returns selected path(s) or null if cancelled.",
  },
  {
    channel: "tribunus:fs:save-file-picker",
    method: "fs.saveFilePicker",
    params: SaveFilePickerParams,
    success: SinglePickerResult,
    category: "fs",
    timeout: "standard",
    sensitivity: "internal",
    senderPolicy: "standard",
    errors: ["invalid_request", "unsupported", "internal"],
    description: "Open a native save-file dialog. Returns the chosen path or null if cancelled.",
  },
  {
    channel: "tribunus:fs:open-path",
    method: "fs.openPath",
    params: OpenPathParams,
    success: OpenPathSuccess,
    category: "fs",
    timeout: "short",
    sensitivity: "authority",
    senderPolicy: "strict",
    errors: ["invalid_request", "permission_denied", "not_found", "unsupported", "internal"],
    description: "Open a file or directory with the system-default (or specified) application. Returns void on success; errors on failure.",
  },
  {
    channel: "tribunus:fs:read-clipboard-image",
    method: "fs.readClipboardImage",
    params: ReadClipboardParams,
    success: ClipboardImageResult,
    category: "fs",
    timeout: "short",
    sensitivity: "internal",
    senderPolicy: "standard",
    errors: ["unsupported", "internal"],
    description: "Read an image from the system clipboard. Returns image data or null if no image is available.",
  },
]
