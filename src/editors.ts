import { defaultKeymap, indentWithTab } from "@codemirror/commands"
import { cpp } from "@codemirror/lang-cpp"
import {
  HighlightStyle,
  syntaxHighlighting
} from "@codemirror/language"
import {
  lintGutter,
  setDiagnostics,
  type Diagnostic as CodeMirrorDiagnostic
} from "@codemirror/lint"
import { EditorState } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { tags } from "@lezer/highlight"
import { basicSetup } from "codemirror"
import { csoundMode } from "@hlolli/codemirror-lang-csound"

import {
  DEFAULT_CPP_SOURCE,
  DEFAULT_CSD_SOURCE,
  DEFAULT_C_SOURCE
} from "./examples"

interface EditorStorageKeys {
  c: string
  cpp: string
  csd: string
  language: string
}

export function editorStorageKeys(): EditorStorageKeys {
  const prefix = "csoundOpcodeWorkbench"
  return {
    c: `${prefix}.cSource.v1`,
    cpp: `${prefix}.cppSource.v1`,
    csd: `${prefix}.csdSource.v1`,
    language: `${prefix}.sourceLanguage.v1`
  }
}

const ROOT_STORAGE_KEYS = editorStorageKeys()

export const C_SOURCE_STORAGE_KEY = ROOT_STORAGE_KEYS.c
export const CPP_SOURCE_STORAGE_KEY = ROOT_STORAGE_KEYS.cpp
export const CSD_SOURCE_STORAGE_KEY = ROOT_STORAGE_KEYS.csd
export const SOURCE_LANGUAGE_STORAGE_KEY = ROOT_STORAGE_KEYS.language

export type SourceLanguage = "c" | "cpp"

export interface EditorDiagnostic {
  file: string
  line: number | null
  column: number | null
  severity: "fatal error" | "error" | "warning" | "note"
  message: string
}

export interface EditorSources {
  source: string
  csd: string
  language: SourceLanguage
}

export interface EditorWorkspace {
  c: string
  cpp: string
  csd: string
  language: SourceLanguage
}

export interface EditorWorkspacePatch {
  c?: string
  cpp?: string
  csd?: string
  language?: SourceLanguage
}

export interface CreateEditorsOptions {
  cParent: HTMLElement
  csdParent: HTMLElement
  onRun: () => void
  onSourceChange?: () => void
  onWorkspaceChange?: () => void
  initialWorkspace?: EditorWorkspace
  defaultWorkspace?: EditorWorkspace
  persistToLocalStorage?: boolean
}

export interface EditorsController {
  getSources: () => EditorSources
  getWorkspace: () => EditorWorkspace
  updateWorkspace: (patch: EditorWorkspacePatch) => EditorWorkspace
  setLanguage: (language: SourceLanguage) => void
  setCompilerDiagnostics: (diagnostics: readonly EditorDiagnostic[]) => void
  focusSourceLine: (line: number, column?: number | null) => void
  destroy: () => void
}

const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--color-editor-paper)",
      color: "var(--color-editor-ink)",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-sm)"
    },
    ".cm-content": {
      paddingBlock: "var(--space-sm)",
      caretColor: "var(--color-editor-focus)"
    },
    ".cm-line": {
      paddingInline: "var(--space-sm)"
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--color-editor-focus)"
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "var(--color-editor-selection)"
    },
    ".cm-panels": {
      backgroundColor: "var(--color-editor-paper-2)",
      color: "var(--color-editor-ink)"
    },
    ".cm-gutters": {
      backgroundColor: "var(--color-editor-paper-2)",
      color: "var(--color-editor-muted)",
      borderRight: "var(--rule-hair) solid var(--color-editor-rule)"
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--color-editor-active)",
      color: "var(--color-editor-ink)"
    },
    ".cm-activeLine": {
      backgroundColor: "var(--color-editor-active)"
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--color-editor-paper-2)",
      borderColor: "var(--color-editor-rule)",
      color: "var(--color-editor-muted)"
    },
    ".cm-tooltip": {
      border: "var(--rule-hair) solid var(--color-editor-rule)",
      backgroundColor: "var(--color-editor-paper-2)",
      color: "var(--color-editor-ink)"
    },
    ".cm-tooltip-lint": {
      fontFamily: "var(--font-mono)"
    },
    ".cm-diagnostic-error": {
      borderLeftColor: "var(--color-syntax-invalid)"
    },
    ".cm-diagnostic-warning": {
      borderLeftColor: "var(--color-editor-warning)"
    },
    ".cm-csound-global-var": {
      fontWeight: "var(--weight-bold)"
    },
    ".cm-csound-i-rate-var, .cm-csound-number, .cm-csound-p-field-var": {
      color: "var(--color-syntax-number)"
    },
    ".cm-csound-opcode, .cm-csound-xml-tag, .cm-csound-f-rate-var": {
      color: "var(--color-syntax-type)"
    },
    ".cm-csound-global-constant, .cm-csound-s-rate-var": {
      color: "var(--color-syntax-string)"
    },
    ".cm-csound-a-rate-var, .cm-csound-define, .cm-csound-control-flow, .cm-csound-goto-token": {
      color: "var(--color-syntax-keyword)"
    },
    ".cm-csound-k-rate-var": {
      color: "var(--color-syntax-name)"
    },
    ".cm-csound-comment": {
      color: "var(--color-syntax-comment)"
    },
    ".cm-csound-bracket": {
      color: "var(--color-editor-muted)"
    },
    ".cm-csound-macro, .cm-csound-macro-token, .cm-csound-boolean": {
      color: "var(--color-editor-warning)"
    }
  }
)

const darkEditorMode = EditorView.theme({}, { dark: true })

const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword], color: "var(--color-syntax-keyword)" },
  { tag: [tags.name, tags.variableName, tags.propertyName], color: "var(--color-syntax-name)" },
  { tag: [tags.typeName, tags.className, tags.tagName], color: "var(--color-syntax-type)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--color-syntax-number)" },
  { tag: [tags.string, tags.character], color: "var(--color-syntax-string)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--color-syntax-comment)" },
  { tag: tags.invalid, color: "var(--color-syntax-invalid)" }
])

function storedValue(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function storeValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    return
  }
}

function storedLanguage(
  key: string,
  fallback: SourceLanguage
): SourceLanguage {
  try {
    const stored = localStorage.getItem(key)
    return stored === "c" || stored === "cpp" ? stored : fallback
  } catch {
    return fallback
  }
}

export function sourceFileName(language: SourceLanguage): string {
  return language === "cpp" ? "plugin.cpp" : "plugin.c"
}

function sourceStorageKey(
  language: SourceLanguage,
  keys: EditorStorageKeys
): string {
  return language === "cpp" ? keys.cpp : keys.c
}

function createPersistListener(
  key: string | (() => string),
  onChange: (() => void) | undefined,
  persistToLocalStorage: boolean
) {
  let timer: ReturnType<typeof setTimeout> | undefined

  const save = (value: string) => {
    storeValue(typeof key === "function" ? key() : key, value)
  }

  const extension = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return
    onChange?.()
    if (!persistToLocalStorage) return

    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      save(update.state.doc.toString())
    }, 120)
  })

  return {
    extension,
    flush: (value: string) => {
      if (!persistToLocalStorage) return
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      save(value)
    }
  }
}

function commonExtensions(onRun: () => void, darkMode = true) {
  return [
    basicSetup,
    lintGutter(),
    editorTheme,
    ...(darkMode ? [darkEditorMode] : []),
    syntaxHighlighting(highlightStyle),
    EditorView.lineWrapping,
    keymap.of([
      {
        key: "Mod-Enter",
        run: () => {
          onRun()
          return true
        }
      },
      indentWithTab,
      ...defaultKeymap
    ])
  ]
}

export function createEditors(options: CreateEditorsOptions): EditorsController {
  const initialWorkspace = options.initialWorkspace
  const defaultWorkspace = options.defaultWorkspace ?? {
    c: DEFAULT_C_SOURCE,
    cpp: DEFAULT_CPP_SOURCE,
    csd: DEFAULT_CSD_SOURCE,
    language: "c"
  }
  const persistToLocalStorage = options.persistToLocalStorage ?? true
  const storageKeys = editorStorageKeys()
  let language = initialWorkspace?.language ?? (
    persistToLocalStorage
      ? storedLanguage(storageKeys.language, defaultWorkspace.language)
      : defaultWorkspace.language
  )
  let suppressChangeCallbacks = false

  if (initialWorkspace && persistToLocalStorage) {
    storeValue(storageKeys.c, initialWorkspace.c)
    storeValue(storageKeys.cpp, initialWorkspace.cpp)
    storeValue(storageKeys.csd, initialWorkspace.csd)
    storeValue(storageKeys.language, initialWorkspace.language)
  }

  const notifySourceChange = () => {
    if (suppressChangeCallbacks) return
    options.onSourceChange?.()
    options.onWorkspaceChange?.()
  }
  const notifyWorkspaceChange = () => {
    if (!suppressChangeCallbacks) options.onWorkspaceChange?.()
  }

  const sourcePersistence = createPersistListener(
    () => sourceStorageKey(language, storageKeys),
    notifySourceChange,
    persistToLocalStorage
  )
  const csdPersistence = createPersistListener(
    storageKeys.csd,
    notifyWorkspaceChange,
    persistToLocalStorage
  )
  const sourceExtensions = [
    ...commonExtensions(options.onRun),
    cpp(),
    sourcePersistence.extension
  ]
  const sourceStates: Record<SourceLanguage, EditorState> = {
    c: EditorState.create({
      doc: initialWorkspace?.c ?? (persistToLocalStorage
        ? storedValue(storageKeys.c, defaultWorkspace.c)
        : defaultWorkspace.c),
      extensions: sourceExtensions
    }),
    cpp: EditorState.create({
      doc: initialWorkspace?.cpp ?? (persistToLocalStorage
        ? storedValue(storageKeys.cpp, defaultWorkspace.cpp)
        : defaultWorkspace.cpp),
      extensions: sourceExtensions
    })
  }

  const cView = new EditorView({
    parent: options.cParent,
    state: sourceStates[language]
  })

  const csdView = new EditorView({
    parent: options.csdParent,
    state: EditorState.create({
      doc: initialWorkspace?.csd ?? (persistToLocalStorage
        ? storedValue(storageKeys.csd, defaultWorkspace.csd)
        : defaultWorkspace.csd),
      extensions: [
        ...commonExtensions(options.onRun, false),
        csoundMode({ fileType: "csd" }),
        csdPersistence.extension
      ]
    })
  })

  const focusSourceLine = (lineNumber: number, column: number | null = 1) => {
    const safeLine = Math.min(
      Math.max(Math.trunc(lineNumber), 1),
      cView.state.doc.lines
    )
    const line = cView.state.doc.line(safeLine)
    const safeColumn = Math.max(Math.trunc(column ?? 1), 1)
    const position = Math.min(line.from + safeColumn - 1, line.to)

    cView.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: "center" })
    })
    cView.focus()
  }

  const getWorkspace = (): EditorWorkspace => {
    sourceStates[language] = cView.state
    return {
      c: sourceStates.c.doc.toString(),
      cpp: sourceStates.cpp.doc.toString(),
      csd: csdView.state.doc.toString(),
      language
    }
  }

  const updateWorkspace = (patch: EditorWorkspacePatch): EditorWorkspace => {
    const before = getWorkspace()
    const next: EditorWorkspace = {
      c: patch.c ?? before.c,
      cpp: patch.cpp ?? before.cpp,
      csd: patch.csd ?? before.csd,
      language: patch.language ?? before.language
    }

    if (
      next.c === before.c &&
      next.cpp === before.cpp &&
      next.csd === before.csd &&
      next.language === before.language
    ) {
      return before
    }

    const activeSourceBefore = before.language === "c" ? before.c : before.cpp
    const activeSourceAfter = next.language === "c" ? next.c : next.cpp
    suppressChangeCallbacks = true

    try {
      for (const sourceLanguage of ["c", "cpp"] as const) {
        const nextSource = next[sourceLanguage]
        const state = sourceLanguage === language
          ? cView.state
          : sourceStates[sourceLanguage]
        const currentSource = state.doc.toString()
        if (nextSource === currentSource) continue

        const change = {
          from: 0,
          to: state.doc.length,
          insert: nextSource
        }
        if (sourceLanguage === language) {
          cView.dispatch({ changes: change })
          sourceStates[sourceLanguage] = cView.state
        } else {
          sourceStates[sourceLanguage] = state.update({ changes: change }).state
        }
      }

      if (next.csd !== before.csd) {
        csdView.dispatch({
          changes: {
            from: 0,
            to: csdView.state.doc.length,
            insert: next.csd
          }
        })
      }

      if (next.language !== language) {
        sourcePersistence.flush(cView.state.doc.toString())
        sourceStates[language] = cView.state
        language = next.language
        cView.setState(sourceStates[language])
        cView.dispatch(setDiagnostics(cView.state, []))
      }
    } finally {
      suppressChangeCallbacks = false
    }

    if (persistToLocalStorage) {
      storeValue(storageKeys.c, next.c)
      storeValue(storageKeys.cpp, next.cpp)
      storeValue(storageKeys.csd, next.csd)
      storeValue(storageKeys.language, next.language)
    }

    if (
      next.language !== before.language ||
      activeSourceAfter !== activeSourceBefore
    ) {
      options.onSourceChange?.()
    }
    options.onWorkspaceChange?.()
    return getWorkspace()
  }

  return {
    getSources: () => ({
      source: cView.state.doc.toString(),
      csd: csdView.state.doc.toString(),
      language
    }),
    getWorkspace,
    updateWorkspace,
    setLanguage: (nextLanguage) => {
      if (language === nextLanguage) return

      sourcePersistence.flush(cView.state.doc.toString())
      sourceStates[language] = cView.state
      language = nextLanguage
      if (persistToLocalStorage) {
        storeValue(storageKeys.language, language)
      }
      cView.setState(sourceStates[language])
      cView.dispatch(setDiagnostics(cView.state, []))
      options.onSourceChange?.()
      options.onWorkspaceChange?.()
    },
    setCompilerDiagnostics: (diagnostics) => {
      const marks: CodeMirrorDiagnostic[] = []

      for (const diagnostic of diagnostics) {
        if (
          diagnostic.file !== sourceFileName(language) ||
          diagnostic.line === null
        ) continue
        if (diagnostic.line < 1 || diagnostic.line > cView.state.doc.lines) continue

        const line = cView.state.doc.line(diagnostic.line)
        const column = Math.max(diagnostic.column ?? 1, 1)
        const from = Math.min(line.from + column - 1, line.to)
        const to = Math.min(Math.max(from + 1, from), line.to)

        marks.push({
          from,
          to,
          severity:
            diagnostic.severity === "warning"
              ? "warning"
              : diagnostic.severity === "note"
                ? "info"
                : "error",
          message: diagnostic.message
        })
      }

      cView.dispatch(setDiagnostics(cView.state, marks))
    },
    focusSourceLine,
    destroy: () => {
      sourcePersistence.flush(cView.state.doc.toString())
      csdPersistence.flush(csdView.state.doc.toString())
      cView.destroy()
      csdView.destroy()
    }
  }
}
