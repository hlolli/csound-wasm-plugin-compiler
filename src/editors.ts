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

export const C_SOURCE_STORAGE_KEY = "csoundOpcodeWorkbench.cSource.v1"
export const CPP_SOURCE_STORAGE_KEY = "csoundOpcodeWorkbench.cppSource.v1"
export const CSD_SOURCE_STORAGE_KEY = "csoundOpcodeWorkbench.csdSource.v1"
export const SOURCE_LANGUAGE_STORAGE_KEY = "csoundOpcodeWorkbench.sourceLanguage.v1"

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

export interface CreateEditorsOptions {
  cParent: HTMLElement
  csdParent: HTMLElement
  onRun: () => void
  onSourceChange?: () => void
}

export interface EditorsController {
  getSources: () => EditorSources
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

function storedLanguage(): SourceLanguage {
  try {
    return localStorage.getItem(SOURCE_LANGUAGE_STORAGE_KEY) === "cpp"
      ? "cpp"
      : "c"
  } catch {
    return "c"
  }
}

export function sourceFileName(language: SourceLanguage): string {
  return language === "cpp" ? "plugin.cpp" : "plugin.c"
}

function sourceStorageKey(language: SourceLanguage): string {
  return language === "cpp" ? CPP_SOURCE_STORAGE_KEY : C_SOURCE_STORAGE_KEY
}

function createPersistListener(
  key: string | (() => string),
  onChange?: () => void
) {
  let timer: ReturnType<typeof setTimeout> | undefined

  const save = (value: string) => {
    storeValue(typeof key === "function" ? key() : key, value)
  }

  const extension = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return
    onChange?.()

    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      save(update.state.doc.toString())
    }, 120)
  })

  return {
    extension,
    flush: (value: string) => {
      if (timer !== undefined) clearTimeout(timer)
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
  let language = storedLanguage()
  const sourcePersistence = createPersistListener(
    () => sourceStorageKey(language),
    options.onSourceChange,
  )
  const csdPersistence = createPersistListener(CSD_SOURCE_STORAGE_KEY)
  const sourceExtensions = [
    ...commonExtensions(options.onRun),
    cpp(),
    sourcePersistence.extension
  ]
  const sourceStates: Record<SourceLanguage, EditorState> = {
    c: EditorState.create({
      doc: storedValue(C_SOURCE_STORAGE_KEY, DEFAULT_C_SOURCE),
      extensions: sourceExtensions
    }),
    cpp: EditorState.create({
      doc: storedValue(CPP_SOURCE_STORAGE_KEY, DEFAULT_CPP_SOURCE),
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
      doc: storedValue(CSD_SOURCE_STORAGE_KEY, DEFAULT_CSD_SOURCE),
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

  return {
    getSources: () => ({
      source: cView.state.doc.toString(),
      csd: csdView.state.doc.toString(),
      language
    }),
    setLanguage: (nextLanguage) => {
      if (language === nextLanguage) return

      sourcePersistence.flush(cView.state.doc.toString())
      sourceStates[language] = cView.state
      language = nextLanguage
      storeValue(SOURCE_LANGUAGE_STORAGE_KEY, language)
      cView.setState(sourceStates[language])
      cView.dispatch(setDiagnostics(cView.state, []))
      options.onSourceChange?.()
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
