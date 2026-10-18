/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TableEditor Subview methods
 * CVM-Role:        Utility Functions
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This module contains a set of methods that are used to
 *                  create and manage subviews within table editor widgets. A
 *                  subview is a CodeMirror instance that mirrors the main
 *                  document, but only allows editing the span of text within a
 *                  given table cell.
 *
 * END HEADER
 */

import { syntaxHighlighting, defaultHighlightStyle, syntaxTree } from '@codemirror/language'
import { EditorState, MapMode, Prec, StateField, EditorSelection, type ChangeSpec, type Extension, type Range } from '@codemirror/state'
import { EditorView, drawSelection, type DecorationSet, Decoration, ViewPlugin, type ViewUpdate, BlockType } from '@codemirror/view'
import markdownParser from '../parser/markdown-parser'
import { tableEditorKeymap } from '../keymaps/table-editor'
import { dispatchFromSubview, maybeDispatchToSubview, syncAnnotation } from './util/data-exchange'
import { configField, type EditorConfiguration } from '../util/configuration'
import { getMainEditorThemes } from '../editor-extension-sets'
import { darkMode, useDarkModeEditor } from '../theme/dark-mode'
import { markdownSyntaxHighlighter } from '../theme/syntax'
import { clickListeners } from '../plugins/click-listeners'
import { vimPlugin } from '../plugins/vim-mode'
import { getCM } from '@replit/codemirror-vim'
import { undo, redo } from '@codemirror/commands'
import { moveNextRow, movePrevRow } from './commands/rows'
import { findColumnIndexByRange, findRowIndexByRange, getTableCellOffsets, mapSelectionsWithTables } from './commands/util'
import { parseTableNode } from '../../markdown-utils/markdown-ast/parse-table-node'

/**
 * A transaction filter that ensures that any changes made to the view that
 * don't come from the main view (i.e., are not synchronizing) are sanitized so
 * that they never exceed the cell's boundaries.
 */
const ensureBoundariesFilter = EditorState.transactionFilter.of((tr) => {
  if (tr.annotation(syncAnnotation) === true) {
    return tr // Do not mess with synchronizing transactions
  }

  // NOTE: There are also cell boundaries written to the TD/TH's dataset, but
  // we can't use those since they strictly exclude *any* whitespace from the
  // cell's contents. This means that, would we use those to determine the
  // selection ranges, any time a user enters a space, this space would be
  // considered "out of the cell", and as such the user could not enter any
  // text afterwards. By looking at the hide-decorations (which are
  // constantly mapped through any changes and thus constitute a "moving
  // target") we can account for that. Basically, the hideDeco field "freezes"
  // the spaces outside of the table cell on editing, and therefore adds any
  // manually added space to the cell's content.

  // Here, we retrieve the boundaries from the given StateField. By mapping
  // only those through the ChangeSet and not recomputing the entire state
  // (e.g., by accessing tr.state), we keep the computational overhead small.
  // NOTE the associations (also in the hidden state updater)
  const [ cellFrom, cellTo ] = tr.startState.field(hiddenSpanField).cellRange

  // TODO: Right now it works all adequately for our purposes. There is one
  // edge-case, though: The CodeMirror parser counts as TableCell contents
  // exclusively non-whitespace within the cell, and excludes any whitespace
  // before and after. This means that, if the user types a space, and then
  // attempts to write something, this would prevent this, as the cursor is
  // now outside of what is considered the cell range for CodeMirror. However,
  // it should be noted that the hide-decorations still accurately reflect the
  // proper boundaries (they include any whitespace that was in the cell
  // before the view got instantiated, but exclude any whitespace added to the
  // cell after the fact.)
  const mappedFrom = tr.changes.mapPos(cellFrom, -1, MapMode.TrackBefore)
  const mappedTo =  tr.changes.mapPos(cellTo, 1, MapMode.TrackAfter)

  const wasDeleted = mappedFrom === null || mappedTo === null

  if (wasDeleted) {
    return [] // Disallow this transaction
  }

  let newSelection = tr.selection
  if (tr.selection !== undefined) {
    // Check if ANY range (not just the main selection) exceeds the cell
    // boundaries. If so, clamp all ranges to the cell's bounds.
    const anyOutOfBounds = tr.selection.ranges.some(
      range => range.from < mappedFrom || range.to > mappedTo
    )

    if (anyOutOfBounds) {
      const clampedRanges = tr.selection.ranges.map(range => {
        const clampedAnchor = Math.max(mappedFrom, Math.min(mappedTo, range.anchor))
        const clampedHead = Math.max(mappedFrom, Math.min(mappedTo, range.head))
        return EditorSelection.range(clampedAnchor, clampedHead)
      })
      newSelection = EditorSelection.create(clampedRanges, tr.selection.mainIndex)
    }
  }

  if (!tr.docChanged) {
    if (newSelection !== tr.selection) {
      return { ...tr, selection: newSelection }
    }
    return tr
  }

  // Ensure that any changes are safe to apply without breaking the table or
  // removing things people don't want to remove.
  const safeChanges: ChangeSpec[] = []
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    // Only pass through changes which are within the cell boundaries.
    if (fromA >= cellFrom && toA <= cellTo) {
      // Ensure that no newlines will be inserted into the table cell
      const ins = inserted.toString()
      const safeInsertion = ins.replace(/\n+/g, ' ')
      safeChanges.push({ from: fromA, to: toA, insert: safeInsertion })
    }
  })

  return { ...tr, changes: safeChanges, selection: newSelection }
})

/**
 * Creates a transaction filter for Vim mode. In Normal mode, Vim keeps the
 * cursor on a character, never after the last one. But since a subview's line
 * is the entire table row, Vim lets the cursor rest on the hidden text after
 * the cell. This filter moves such a cursor back onto the cell's last
 * character, also after changes from the main view, such as an undo, which
 * restores the main view's selection. It leaves Insert mode alone, which needs the position after the
 * last character, and Visual mode, whose selections aren't empty.
 *
 * @param   {() => EditorView|undefined}  getView  Returns the subview
 *
 * @return  {Extension}                            The transaction filter
 */
function vimCursorFilter (getView: () => EditorView|undefined): Extension {
  return EditorState.transactionFilter.of((tr) => {
    const view = getView()
    const vim = view !== undefined ? getCM(view)?.state.vim : undefined
    if (tr.selection === undefined || vim == null || vim.insertMode) {
      return tr
    }

    const [ cellFrom, cellTo ] = tr.startState.field(hiddenSpanField).cellRange
    const from = tr.changes.mapPos(cellFrom, -1)
    const to = tr.changes.mapPos(cellTo, 1)
    if (to <= from || !tr.selection.ranges.some(range => range.empty && range.head >= to)) {
      return tr
    }

    const ranges = tr.selection.ranges.map(range => {
      return range.empty && range.head >= to ? EditorSelection.cursor(to - 1) : range
    })
    return { ...tr, selection: EditorSelection.create(ranges, tr.selection.mainIndex) }
  })
}

/**
 * Returns whether Vim is in Normal mode with no count, operator, register or
 * pending command (such as `f` or `r`) typed yet.
 *
 * @param   {EditorView}  view  The view
 *
 * @return  {boolean}           Whether the next key starts a new command
 */
function vimNormalModeIdle (view: EditorView): boolean {
  const vim = getCM(view)?.state.vim
  if (vim == null || vim.insertMode || vim.visualMode) {
    return false
  }
  const input = vim.inputState
  return input.keyBuffer.length === 0 && input.prefixRepeat.length === 0 && input.operator == null && input.registerName == null
}

/**
 * Returns the key of a bare `h`, `j`, `k` or `l` press that Vim would take as
 * a plain motion in Normal mode: no modifiers, count, operator, register or
 * pending command.
 *
 * @param   {KeyboardEvent}       event  The keydown event
 * @param   {EditorView}          view   The view that received it
 *
 * @return  {string|undefined}           The key, or undefined
 */
function plainVimMotionKey (event: KeyboardEvent, view: EditorView): string|undefined {
  if (![ 'h', 'j', 'k', 'l' ].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || !vimNormalModeIdle(view)) {
    return undefined
  }
  return event.key
}

/**
 * Moves the main selection out of the table it is in, to the start of the line
 * below (forward) or above it, and focuses the main view.
 *
 * @param   {EditorView}  mainView  The main view
 * @param   {boolean}     forward   Whether to leave below the table
 */
function leaveTable (mainView: EditorView, forward: boolean): void {
  const table = mapSelectionsWithTables(mainView, ctx => ctx.tableNode)[0]
  const pos = table === undefined ? -1 : forward ? table.to + 1 : table.from - 1
  if (pos < 0 || pos > mainView.state.doc.length) {
    return
  }
  mainView.dispatch({ selection: { anchor: mainView.state.doc.lineAt(pos).from }, scrollIntoView: true })
  mainView.focus()
}

/**
 * Moves the main selection to the end of the previous cell or the start of the
 * next cell in the same row, if there is one.
 *
 * @param   {EditorView}  mainView  The main view
 * @param   {number}      step      -1 for the previous cell, 1 for the next
 */
function moveInRow (mainView: EditorView, step: number): void {
  const anchor = mapSelectionsWithTables(mainView, ctx => {
    const range = mainView.state.selection.main
    const row = findRowIndexByRange(range, ctx.offsets.outer, 'anchor')
    const col = findColumnIndexByRange(range, ctx.offsets.outer, 'anchor')
    return row !== undefined && col !== undefined ? ctx.offsets.inner[row][col + step]?.[step < 0 ? 1 : 0] : undefined
  })[0]
  if (anchor !== undefined) {
    mainView.dispatch({ selection: { anchor } })
  }
}

/**
 * Creates a keydown handler for Vim mode, which runs before Vim's. Vim maps
 * Enter in Normal mode to `j^`, which in a cell lands on the start of the same
 * cell; this handler moves to the cell below instead, like Enter in Insert
 * mode. It also lets `hjkl` leave the cell at its edges: `h` and `l` to the
 * neighbouring cell in the row, `j` and `k` to the cell below or above, or
 * out of the table from its last or first row. Lastly, it maps `u` and Ctrl-r
 * to the main view's undo and redo.
 *
 * @param   {EditorView}  mainView  The main view
 *
 * @return  {Extension}             The event handler
 */
function vimKeyHandler (mainView: EditorView): Extension {
  return Prec.highest(EditorView.domEventHandlers({
    keydown (event, view) {
      const vim = getCM(view)?.state.vim
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
        vim != null && !vim.insertMode && !vim.visualMode) {
        moveNextRow(mainView)
        return true
      }

      // The subview has no history: `u` and Ctrl-r undo and redo in the main view
      const isUndo = event.key === 'u' && !event.ctrlKey
      if ((isUndo || (event.key === 'r' && event.ctrlKey)) && !event.altKey && !event.metaKey && vimNormalModeIdle(view)) {
        if (isUndo) {
          undo(mainView)
        } else {
          redo(mainView)
        }
        return true
      }

      const key = plainVimMotionKey(event, view)
      const range = view.state.selection.main
      if (key === undefined || view.state.selection.ranges.length > 1) {
        return false
      }

      const [ cellFrom, cellTo ] = view.state.field(hiddenSpanField).cellRange
      if (key === 'h' || key === 'l') {
        if (key === 'h' ? range.head > cellFrom : range.head < Math.max(cellFrom, cellTo - 1)) {
          return false
        }
        moveInRow(mainView, key === 'h' ? -1 : 1)
        return true
      }

      // `j` and `k` move by visual line, so stay in the cell while it wraps
      const target = view.moveVertically(range, key === 'j').head
      if (target !== range.head && target >= cellFrom && target <= cellTo) {
        return false
      }
      if (!(key === 'j' ? moveNextRow(mainView) : movePrevRow(mainView))) {
        leaveTable(mainView, key === 'j')
      }
      return true
    }
  }))
}

/**
 * Creates a keydown handler for Vim mode in the main view: `j` on the last
 * visual line before a table enters its first cell, and `k` on the first
 * visual line after a table enters the first cell of its last row. Otherwise,
 * Vim's `gj` and `gk` skip the table, since it is a single block widget.
 *
 * @return  {Extension}  The event handler
 */
export const vimTableEntryHandler = Prec.highest(EditorView.domEventHandlers({
  keydown (event, view) {
    const key = plainVimMotionKey(event, view)
    const range = view.state.selection.main
    if ((key !== 'j' && key !== 'k') || view.state.selection.ranges.length > 1) {
      return false
    }

    const forward = key === 'j'
    const line = view.state.doc.lineAt(range.head)
    const pos = forward ? line.to + 1 : line.from - 1
    const target = view.moveVertically(range, forward).head
    if (pos < 0 || pos > view.state.doc.length || (target >= line.from && target <= line.to)) {
      return false
    }

    const block = view.lineBlockAt(pos)
    const table = syntaxTree(view.state).topNode.getChildren('Table').find(node => node.from === block.from)
    if (block.type !== BlockType.WidgetRange || table === undefined || (forward ? table.from : table.to) !== pos) {
      return false
    }
    const ast = parseTableNode(table, view.state.sliceDoc())
    if (ast.type !== 'Table') {
      return false
    }

    const { inner } = getTableCellOffsets(ast)
    view.dispatch({ selection: { anchor: inner[forward ? 0 : inner.length - 1][0][0] }, scrollIntoView: true })
    return true
  }
}))

interface hiddenSpanState {
  decorations: DecorationSet
  cellRange: [number, number]
}

/**
 * A StateField whose sole purpose is to hide the two stretches of content
 * before and after the table cell contents.
 */
export const hiddenSpanField = StateField.define<hiddenSpanState>({
  create (state) {
    // NOTE: Override using `init`! Otherwise this extension won't do much.
    return {
      decorations: Decoration.none,
      cellRange: [ 0, state.doc.length ]
    }
  },
  update (value, tr) {
    if (!tr.docChanged) {
      return value
    } else {
      // Ensure the range always stays the same
      return {
        decorations: value.decorations.map(tr.changes),
        cellRange: [
          // The assocs ensure that it's really an "outer" bound and any text
          // inserted in there stays within this cell range. If we didn't
          // provide it, inserting a character in an empty range (from === to)
          // would cause that inserted character to end up right to the `to`.
          tr.changes.mapPos(value.cellRange[0], -1),
          tr.changes.mapPos(value.cellRange[1], 1)
        ]
      }
    }
  },
  provide: f => EditorView.decorations.from(f, (value) => value.decorations)
})

/**
 * Creates a set of four decorations that hide the spans before and after the
 * provided cell range. Provide the result of this function to the hiddenSpanField's init method.
 *
 * @param   {EditorState}                    state   The main editor state
 * @param   {{ from: number, to: number }}  cellRange  The cell range
 *
 * @return  {DecorationSet}                            The initial deco set
 */
function createHiddenDecorations (state: EditorState, cellRange: { from: number, to: number }): DecorationSet {
  const { from, to } = state.doc.lineAt(cellRange.from)
  // The table cell can be at the start/end of a line/document, and CodeMirror
  // does not allow atomic ranges where from === to. Therefore, conditional
  // ranges

  const decorations: Array<Range<Decoration>> = []

  // 1: Block before
  if (from - 1 > 0) {
    decorations.push(
      Decoration.replace({ block: true, inclusive: true }).range(0, from - 1)
    )
  }
  // 2: Line until cellRange.from
  if (cellRange.from > from) {
    decorations.push(
      Decoration.replace({ block: false, inclusive: false })
        .range(from, cellRange.from)
    )
  }
  // 3: Line after cellRange.to
  if (to > cellRange.to) {
    decorations.push(
      Decoration.replace({ block: false, inclusive: false })
        .range(cellRange.to, to)
    )
  }
  // 4: Block after
  if (state.doc.length > to + 1) {
    decorations.push(
      Decoration.replace({ block: true, inclusive: true })
        .range(to + 1, state.doc.length)
    )
  }

  return Decoration.set(decorations)
}

/**
* Creates and mounts a sub-EditorView within the provided targetCell.
*
* @param  {EditorView}      mainView        The main view
* @param  {HTMLDivElement}  contentWrapper  The cell's content wrapper
*/
export function createSubviewForCell (
  mainView: EditorView,
  contentWrapper: HTMLDivElement,
  cellRange: { from: number, to: number }
): void {
  const cfg: EditorConfiguration = JSON.parse(JSON.stringify(mainView.state.field(configField)))
  const themes = getMainEditorThemes()

  const state = EditorState.create({
    // Subviews always hold the entire document. This is to make synchronizing
    // updates between main and subviews faster and simpler. This should only
    // become a problem on very old computers for people working with 100MB
    // documents. This assumes that this would be an edge case. Note to future
    // me: "You knew there was going to be this guy who now keeps peskering me
    // because he can't edit his ten-million line JSON files without waiting
    // three seconds for the changes to be applied to his overweight text file."
    doc: mainView.state.sliceDoc(),
    selection: mainView.state.selection,
    extensions: [
      // Vim mode needs to be included first, before any other keymap.
      cfg.inputMode === 'vim' ? vimPlugin() : [],
      // A minimal set of extensions
      tableEditorKeymap(mainView, cfg.shortcuts),
      drawSelection({ drawRangeCursor: false, cursorBlinkRate: 1000 }),
      EditorState.allowMultipleSelections.of(true),
      // Add the configuration and preset it with whatever is in the main view.
      // The config field will automagically update since we forward any effects
      // to the subview.
      configField.init(_state => cfg),
      darkMode({ darkMode: useDarkModeEditor(cfg.darkMode, cfg.darkModeEditor), ...themes[cfg.theme] }),
      syntaxHighlighting(defaultHighlightStyle),
      markdownSyntaxHighlighter(),
      EditorView.lineWrapping,
      markdownParser(), // TODO: Config?
      // Two custom extensions that are required for the specific use-case of
      // this single-line minimal EditorView
      hiddenSpanField.init(s => {
        return {
          decorations: createHiddenDecorations(s, cellRange),
          cellRange: [ cellRange.from, cellRange.to ]
        }
      }),
      ensureBoundariesFilter,
      cfg.inputMode === 'vim' ? vimCursorFilter(() => subview) : [],
      cfg.inputMode === 'vim' ? vimKeyHandler(mainView) : [],
      EditorView.domEventHandlers(clickListeners())
    ]
  })

  const subview = new EditorView({
    state,
    parent: contentWrapper,
    // Route any updates to the main view. Apply those coming in from the main
    // view.
    dispatch: dispatchFromSubview(mainView)
  })

  // Apply the Vim cursor filter to the initial selection as well
  if (cfg.inputMode === 'vim') {
    subview.dispatch({ selection: subview.state.selection })
  }

  // We must delay the subview focusing until the DOM has been updated and any
  // other callbacks and event listeners have been attached. We achieve this
  // using `setTimeout` which will execute its callback once the main loop is
  // empty.
  setTimeout(() => subview.focus(), 0)
}

/**
 * A view plugin that passes any transaction from the main view into the various
 * subviews.
 */
export const subviewUpdatePlugin = ViewPlugin.define(view => ({
  update (u: ViewUpdate) {
    const cells = [
      ...view.dom.querySelectorAll('.cm-table-editor-widget-wrapper td'),
      ...view.dom.querySelectorAll('.cm-table-editor-widget-wrapper th')
    ] as HTMLTableCellElement[]

    for (const cell of cells) {
      const subview = EditorView.findFromDOM(cell)
      if (subview !== null) {
        for (const tr of u.transactions) {
          maybeDispatchToSubview(subview, tr)
        }
      }
    }
  }
}))
