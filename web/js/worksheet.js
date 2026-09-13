/**
 * OpenMath Web Worksheet Manager & KaTeX Typeset Renderer
 * Manages calculation cells [In n] / [Out n], precision switches, and copy/export capabilities.
 */

import { MathPlotter } from "./plotter.js";

export class WorksheetManager {
  constructor(containerEl, onEvaluateRequest, options = {}) {
    this.container = containerEl;
    this.onEvaluate = onEvaluateRequest;
    this.theme = options.theme || "dark";
    this.globalPrecision = 6;
    this.globalMode = "exact"; // "exact" | "numeric"

    this.cells = [];
    this.cellCounter = 0;
    this.activeCellId = null;

    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => this.updateSectionBraces()).observe(this.container);
    } else {
      window.addEventListener("resize", () => this.updateSectionBraces());
    }
  }

  setTheme(theme) {
    this.theme = theme;
    // Re-render any existing plots
    this.cells.forEach((cell) => {
      if (cell.result && cell.result.is_plot && cell.plotInstance) {
        cell.plotInstance.options.theme = theme;
        cell.plotInstance.render();
      }
    });
    this.updateSectionBraces();
  }

  setGlobalPrecision(precision) {
    this.globalPrecision = parseInt(precision, 10);
  }

  setGlobalMode(mode) {
    this.globalMode = mode;
    this.cells.forEach((cell) => {
      if (cell.result && !cell.result.is_plot && !cell.result.error) {
        this.renderMathOutput(cell);
      }
    });
  }

  getActiveInput() {
    if (!this.activeCellId) {
      if (this.cells.length > 0) {
        return this.cells[this.cells.length - 1].inputEl;
      }
      return null;
    }
    const cell = this.cells.find((c) => c.id === this.activeCellId);
    return cell ? cell.inputEl : null;
  }

  insertTextAtCursor(text, cursorOffset = 0) {
    let inputEl = this.getActiveInput();
    if (!inputEl) {
      const newCell = this.addCell("", true);
      inputEl = newCell.inputEl;
    }

    const start = inputEl.selectionStart || inputEl.value.length;
    const end = inputEl.selectionEnd || inputEl.value.length;
    const val = inputEl.value;

    inputEl.value = val.substring(0, start) + text + val.substring(end);
    const newCursor = start + text.length + cursorOffset;
    inputEl.focus();
    inputEl.setSelectionRange(newCursor, newCursor);
  }

  addCell(initialText = "", focus = true, cachedResult = null, options = {}) {
    this.cellCounter++;
    const idx = this.cellCounter;
    const cellId = `cell_${idx}`;

    const isWsMode = options.is_worksheet_mode !== undefined ? Boolean(options.is_worksheet_mode) : true;
    const inputMode = options.input_mode !== undefined ? options.input_mode : 0;
    const secLevel = options.section_level || 0;
    const spans = options.spans || [];
    const isNonExec = inputMode === 3;
    const isText = inputMode === 2;
    const isDocumentMode = !isWsMode || isNonExec;
    const showPromptAndBracket = isWsMode && !isNonExec && !isText;

    const cellObj = {
      id: cellId,
      index: idx,
      mode: this.globalMode,
      precision: this.globalPrecision,
      result: null,
      plotInstance: null,
      dom: null,
      inputEl: null,
      isDocumentMode: isDocumentMode,
      spans: spans
    };

    const cellEl = document.createElement("div");
    cellEl.className = `worksheet-cell cell-execution-group${isDocumentMode ? " document-mode" : ""}${secLevel > 0 ? ` level-${secLevel}` : ""}`;
    cellEl.id = cellId;
    cellEl.dataset.cellId = cellId;
    cellEl.dataset.sectionLevel = secLevel;

    const formattedText = this.formatSubscriptsAndSuperscripts(initialText);

    cellEl.innerHTML = `
      <div class="cell-bracket" ${showPromptAndBracket ? "" : 'style="display: none;"'} title="Execution Group ["></div>
      <div class="cell-content">
        <div class="cell-input-row">
          <span class="math-prompt" ${showPromptAndBracket ? "" : 'style="display: none;"'}>&gt;</span>
          <textarea class="cell-input" placeholder="" rows="1" spellcheck="false">${this.escapeHtml(formattedText)}</textarea>
        </div>
        <div class="cell-output-row" style="display: none;">
          <div class="math-output-wrapper">
            <div class="output-content"></div>
            <span class="math-equation-label">(${idx})</span>
          </div>
        </div>
      </div>
    `;

    const inputEl = cellEl.querySelector(".cell-input");
    cellObj.dom = cellEl;
    cellObj.inputEl = inputEl;

    // Auto-expand textarea height
    const autoResize = () => {
      inputEl.style.height = "auto";
      inputEl.style.height = `${Math.max(24, inputEl.scrollHeight)}px`;
    };

    inputEl.addEventListener("input", autoResize);

    // Focus tracking
    inputEl.addEventListener("focus", () => {
      this.activeCellId = cellId;
      document.querySelectorAll(".worksheet-cell").forEach((c) => c.classList.remove("focused"));
      cellEl.classList.add("focused");
    });

    const bracketEl = cellEl.querySelector(".cell-bracket");
    if (bracketEl) {
      bracketEl.addEventListener("click", () => {
        inputEl.focus();
      });
    }

    // Keyboard navigation and evaluation shortcuts (Enter evaluates like desktop OpenMath)
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.evaluateCell(cellId);
      } else if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        this.evaluateCell(cellId);
      } else if (e.key === "Backspace" && inputEl.value === "") {
        if (this.cells.length > 1) {
          e.preventDefault();
          const currIdx = this.cells.findIndex((c) => c.id === cellId);
          this.deleteCell(cellId);
          const targetIdx = Math.max(0, currIdx - 1);
          if (this.cells[targetIdx]) {
            this.cells[targetIdx].inputEl.focus();
          }
        }
      } else if (e.key === "ArrowUp") {
        if (inputEl.selectionStart === 0 && inputEl.selectionEnd === 0) {
          const currIdx = this.cells.findIndex((c) => c.id === cellId);
          if (currIdx > 0) {
            e.preventDefault();
            this.cells[currIdx - 1].inputEl.focus();
          }
        }
      } else if (e.key === "ArrowDown") {
        if (inputEl.selectionStart === inputEl.value.length) {
          const currIdx = this.cells.findIndex((c) => c.id === cellId);
          if (currIdx < this.cells.length - 1) {
            e.preventDefault();
            this.cells[currIdx + 1].inputEl.focus();
          }
        }
      }
    });

    this.container.appendChild(cellEl);
    this.cells.push(cellObj);

    if (cachedResult) {
      cellObj.result = cachedResult;
      const outputRow = cellEl.querySelector(".cell-output-row");
      if (outputRow) {
        outputRow.style.display = "block";
        this.renderMathOutput(cellObj);
      }
    }

    if (focus) {
      inputEl.focus();
      this.activeCellId = cellId;
    }
    autoResize();
    return cellObj;
  }

  addSectionHeader(title, level = 0, html = "", isCollapsed = false) {
    this.cellCounter++;
    const idx = this.cellCounter;
    const secId = `section_${idx}`;

    const secEl = document.createElement("div");
    secEl.className = `worksheet-cell cell-section-header level-${level}`;
    secEl.id = secId;
    secEl.dataset.sectionLevel = level;
    secEl.dataset.collapsed = isCollapsed ? "true" : "false";

    const displayHtml = (html && html.trim()) ? html : `<span class="section-title-text">${this.escapeHtml(title || "Section")}</span>`;

    secEl.innerHTML = `
      <div class="section-header-inner">
        <button class="section-toggle-btn" title="Expand / Collapse section">
          <span class="chevron-arrow">${isCollapsed ? "▶" : "▼"}</span>
        </button>
        <div class="section-title-display">${displayHtml}</div>
      </div>
    `;

    const toggleBtn = secEl.querySelector(".section-toggle-btn");
    const chevron = secEl.querySelector(".chevron-arrow");
    toggleBtn.addEventListener("click", () => {
      const collapsed = secEl.dataset.collapsed === "true";
      const nextCollapsed = !collapsed;
      secEl.dataset.collapsed = nextCollapsed ? "true" : "false";
      chevron.textContent = nextCollapsed ? "▶" : "▼";
      this.toggleSectionCollapse(secEl, level, nextCollapsed);
      this.updateSectionBraces();
    });

    this.container.appendChild(secEl);
    this.updateSectionBraces();
    return secEl;
  }

  toggleSectionCollapse(sectionEl, sectionLevel, isCollapsed) {
    let sibling = sectionEl.nextElementSibling;
    while (sibling) {
      if (sibling.classList.contains("cell-section-header")) {
        const sibLevel = parseInt(sibling.dataset.sectionLevel || "0", 10);
        if (sibLevel <= sectionLevel) {
          break; // Stop at next peer or higher section
        }
      }
      sibling.style.display = isCollapsed ? "none" : "";
      sibling = sibling.nextElementSibling;
    }
    this.updateSectionBraces();
  }

  addTextCell(content = "", embeddedImages = {}, options = {}) {
    this.cellCounter++;
    const idx = this.cellCounter;
    const cellId = `text_cell_${idx}`;
    const secLevel = options.section_level || 0;

    const textEl = document.createElement("div");
    textEl.className = `worksheet-cell cell-text-mode${secLevel > 0 ? ` level-${secLevel}` : ""}`;
    textEl.id = cellId;
    textEl.dataset.sectionLevel = secLevel;

    let formatted = content || "";
    if (embeddedImages && typeof embeddedImages === "object") {
      for (const [imgId, b64] of Object.entries(embeddedImages)) {
        const dataUri = `data:image/png;base64,${b64}`;
        formatted = formatted.split(imgId).join(dataUri);
      }
    }

    // Header styling if markdown heading
    if (formatted.startsWith("# ")) {
      formatted = `<h2 class="text-heading-1">${formatted.substring(2)}</h2>`;
    } else if (formatted.startsWith("## ")) {
      formatted = `<h3 class="text-heading-2">${formatted.substring(3)}</h3>`;
    }

    textEl.innerHTML = `
      <div class="text-cell-body" contenteditable="true" spellcheck="false">${formatted}</div>
    `;

    this.container.appendChild(textEl);
    this.updateSectionBraces();
    return textEl;
  }

  deleteCell(cellId) {
    const idx = this.cells.findIndex((c) => c.id === cellId);
    if (idx !== -1) {
      const cell = this.cells[idx];
      cell.dom.remove();
      this.cells.splice(idx, 1);
    }
    if (this.cells.length === 0) {
      this.addCell();
    }
    this.updateSectionBraces();
  }

  clearWorksheet() {
    this.container.innerHTML = "";
    this.cells = [];
    this.cellCounter = 0;
    this.activeCellId = null;
    this.addCell();
    this.updateSectionBraces();
  }

  loadImportedCells(cells) {
    if (!cells || !cells.length) return;
    this.container.innerHTML = "";
    this.cells = [];
    this.cellCounter = 0;
    this.activeCellId = null;

    let pendingCollapsedSection = null;

    cells.forEach((c) => {
      const inp = c.input !== undefined ? c.input : "";
      const isSec = Boolean(c.is_section_header || c.mode === "section");
      const isText = Boolean(c.input_mode === 2 || c.mode === "text");
      const secLevel = c.section_level || 0;

      if (pendingCollapsedSection && secLevel <= pendingCollapsedSection.level) {
        pendingCollapsedSection = null;
      }

      if (isSec) {
        const title = c.section_title || inp || "Section";
        const secEl = this.addSectionHeader(title, secLevel, c.section_html, c.is_collapsed);
        if (pendingCollapsedSection) {
          secEl.style.display = "none";
        }
        if (c.is_collapsed && !pendingCollapsedSection) {
          pendingCollapsedSection = { el: secEl, level: secLevel };
        }
      } else if (isText) {
        if (inp.trim() !== "") {
          const textEl = this.addTextCell(inp, c.embedded_images, { section_level: secLevel });
          if (pendingCollapsedSection) {
            textEl.style.display = "none";
          }
        }
      } else {
        // Math calculation cell with cached result & Document Mode support
        const cellObj = this.addCell(inp, false, c.result, {
          is_worksheet_mode: c.is_worksheet_mode,
          input_mode: c.input_mode,
          section_level: secLevel,
          spans: c.spans || []
        });
        if (pendingCollapsedSection) {
          cellObj.dom.style.display = "none";
        }
      }
    });

    if (this.cells.length === 0) {
      this.addCell("", true);
    } else {
      this.activeCellId = this.cells[0].id;
      this.cells[0].dom.classList.add("focused");
    }

    // Redraw continuous section tree brackets matching Desktop OpenMath
    requestAnimationFrame(() => {
      this.updateSectionBraces();
    });
  }

  updateSectionBraces() {
    let svg = this.container.querySelector("#section-tree-overlay");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "section-tree-overlay");
      svg.setAttribute("id", "section-tree-overlay");
      this.container.insertBefore(svg, this.container.firstChild);
    }

    while (svg.firstChild) {
      svg.removeChild(svg.firstChild);
    }

    const containerRect = this.container.getBoundingClientRect();
    const cells = Array.from(this.container.children).filter((el) =>
      el.classList.contains("worksheet-cell")
    );

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (!cell.classList.contains("cell-section-header")) continue;
      if (cell.dataset.collapsed === "true") continue;
      if (cell.offsetParent === null) continue;

      const secLevel = parseInt(cell.dataset.sectionLevel || "0", 10);
      const toggleBtn = cell.querySelector(".section-toggle-btn");
      if (!toggleBtn) continue;

      const btnRect = toggleBtn.getBoundingClientRect();
      const startX = Math.round(btnRect.left + btnRect.width / 2 - containerRect.left);
      const startY = Math.round(btnRect.bottom - 2 - containerRect.top);

      let lastCell = null;
      for (let j = i + 1; j < cells.length; j++) {
        const child = cells[j];
        if (child.offsetParent === null) continue;

        if (child.classList.contains("cell-section-header")) {
          const childLevel = parseInt(child.dataset.sectionLevel || "0", 10);
          if (childLevel <= secLevel) {
            break;
          }
        } else {
          const childLevel = parseInt(child.dataset.sectionLevel || "0", 10);
          if (childLevel < secLevel) {
            break;
          }
        }
        lastCell = child;
      }

      if (lastCell) {
        const lastRect = lastCell.getBoundingClientRect();
        const endY = Math.round(lastRect.bottom - 4 - containerRect.top);
        if (endY > startY) {
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", `M ${startX} ${startY} V ${endY} H ${startX + 8}`);
          path.setAttribute("stroke", "var(--bracket-color, #8e9aaf)");
          path.setAttribute("stroke-width", "1.5");
          path.setAttribute("fill", "none");
          path.setAttribute("stroke-linecap", "square");
          svg.appendChild(path);
        }
      }
    }
  }

  formatSubscriptsAndSuperscripts(text) {
    if (!text || (text.indexOf('_') === -1 && text.indexOf('^') === -1)) {
      return text || "";
    }
    const SUB_MAP = {
      '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
      '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
      '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
      'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'j': 'ⱼ',
      'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ',
      'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ', 't': 'ₜ', 'u': 'ᵤ',
      'v': 'ᵥ', 'x': 'ₓ'
    };
    const SUPER_MAP = {
      '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
      '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
      '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
      'n': 'ⁿ', 'i': 'ⁱ'
    };

    let formatted = text;
    // Superscripts: ^{...} or ^\d+
    formatted = formatted.replace(/\^{([0-9\+\-\=]+)}/g, (m, g) => {
      return g.split('').map((c) => SUPER_MAP[c] || c).join('');
    });
    formatted = formatted.replace(/\^([0-9]+)/g, (m, g) => {
      return g.split('').map((c) => SUPER_MAP[c] || c).join('');
    });

    // Subscripts: _{...} or _[0-9a-zA-Z]+
    formatted = formatted.replace(/(?<=[a-zA-Z0-9_\)\]\}])_+{([0-9a-zA-Z\+\-\=]+)}/g, (m, g) => {
      return g.split('').map((c) => SUB_MAP[c.toLowerCase()] || c).join('');
    });
    formatted = formatted.replace(/(?<=[a-zA-Z0-9_\)\]\}])_+([0-9a-zA-Z]+)(?![a-zA-Z0-9])/g, (m, g) => {
      return g.split('').map((c) => SUB_MAP[c.toLowerCase()] || c).join('');
    });

    return formatted;
  }

  evaluateCell(cellId) {
    const cell = this.cells.find((c) => c.id === cellId);
    if (!cell) return;

    const expr = cell.inputEl.value.trim();
    if (!expr) return;

    const outputRow = cell.dom.querySelector(".cell-output-row");
    const outputContent = cell.dom.querySelector(".output-content");
    outputRow.style.display = "block";
    outputContent.innerHTML = `<div class="cell-calculating"><div class="spinner-sm"></div><span>Computing with CAS engine...</span></div>`;

    cell.dom.classList.add("calculating");

    this.onEvaluate(cellId, expr, this.globalPrecision);
  }

  evaluateAll() {
    this.cells.forEach((cell) => {
      if (cell.inputEl.value.trim()) {
        this.evaluateCell(cell.id);
      }
    });
  }

  handleResult(cellId, result) {
    const cell = this.cells.find((c) => c.id === cellId);
    if (!cell) return;

    cell.dom.classList.remove("calculating");
    cell.result = result;

    const outputRow = cell.dom.querySelector(".cell-output-row");
    const timingBadge = cell.dom.querySelector(".timing-badge");
    outputRow.style.display = "block";

    if (timingBadge && result.execution_time_ms !== undefined) {
      timingBadge.textContent = `${result.execution_time_ms} ms`;
    }

    if (result.error) {
      const outputContent = cell.dom.querySelector(".output-content");
      outputContent.innerHTML = `
        <div class="cell-error-banner">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>${this.escapeHtml(result.error)}</span>
        </div>
      `;
      return;
    }

    this.renderMathOutput(cell);

    // If this was the last cell and has non-empty input, auto-append a new cell for flow
    const cellIndex = this.cells.indexOf(cell);
    if (cellIndex === this.cells.length - 1) {
      this.addCell("", true);
    }
  }

  renderMathOutput(cell) {
    const res = cell.result;
    if (!res) return;

    const outputContent = cell.dom.querySelector(".output-content");
    if (!outputContent) return;
    outputContent.innerHTML = "";

    const eqLabel = cell.dom.querySelector(".math-equation-label");
    if (eqLabel) {
      eqLabel.textContent = `(${cell.index})`;
    }

    if (res.is_plot && res.plot_data) {
      // Render plot canvas
      const canvas = document.createElement("canvas");
      canvas.className = "plot-canvas";
      canvas.style.width = "100%";
      canvas.style.height = "360px";
      outputContent.appendChild(canvas);

      cell.plotInstance = new MathPlotter(canvas, res.plot_data, {
        theme: this.theme
      });
      return;
    }

    // Mathematical formula rendering via KaTeX
    const isNum = cell.mode === "numeric" || this.globalMode === "numeric";
    const latexStr = isNum ? (res.numeric_latex || res.exact_latex) : (res.exact_latex || res.numeric_latex);
    const plainText = isNum ? (res.numeric_text || res.exact_text) : (res.exact_text || res.numeric_text);

    if (latexStr && typeof katex !== "undefined") {
      const mathEl = document.createElement("div");
      mathEl.className = "katex-rendered-output";
      try {
        katex.render(latexStr, mathEl, {
          throwOnError: false,
          displayMode: true
        });
        outputContent.appendChild(mathEl);
      } catch (err) {
        outputContent.textContent = plainText || latexStr;
      }
    } else {
      const preEl = document.createElement("pre");
      preEl.className = "plain-text-output";
      preEl.textContent = plainText || "";
      outputContent.appendChild(preEl);
    }
  }

  copyToClipboard(text, triggerBtn) {
    navigator.clipboard.writeText(text).then(() => {
      const origText = triggerBtn.textContent;
      triggerBtn.textContent = "Copied!";
      triggerBtn.classList.add("copied");
      setTimeout(() => {
        triggerBtn.textContent = origText;
        triggerBtn.classList.remove("copied");
      }, 1500);
    });
  }

  escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  exportDocument(format = "markdown") {
    let content = "";
    const date = new Date().toISOString().split("T")[0];

    if (format === "markdown") {
      content = `# OpenMath Worksheet Export\n*Exported on ${date}*\n\n---\n\n`;
      this.cells.forEach((cell) => {
        const inp = cell.inputEl.value.trim();
        if (!inp) return;
        content += `### In [${cell.index}]\n\`\`\`\n${inp}\n\`\`\`\n\n`;
        if (cell.result) {
          const out = cell.result.exact_text || cell.result.exact_latex;
          content += `### Out [${cell.index}]\n$$${cell.result.exact_latex || out}$$\n\n`;
        }
      });
      this.downloadFile(content, "worksheet.md", "text/markdown");
    } else if (format === "latex") {
      content = `\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage{amssymb}\n\\begin{document}\n\\title{OpenMath Worksheet}\n\\date{${date}}\n\\maketitle\n\n`;
      this.cells.forEach((cell) => {
        const inp = cell.inputEl.value.trim();
        if (!inp) return;
        content += `\\textbf{In [${cell.index}]:} \\texttt{${inp}}\\\\\n`;
        if (cell.result && cell.result.exact_latex) {
          content += `\\textbf{Out [${cell.index}]:} \\[ ${cell.result.exact_latex} \\]\n\\vspace{1em}\n\n`;
        }
      });
      content += "\\end{document}\n";
      this.downloadFile(content, "worksheet.tex", "application/x-latex");
    } else if (format === "json") {
      const data = this.cells.map((c) => ({
        index: c.index,
        input: c.inputEl.value,
        mode: c.mode,
        result: c.result
      }));
      content = JSON.stringify(data, null, 2);
      this.downloadFile(content, "worksheet.json", "application/json");
    }
  }

  downloadFile(content, filename, contentType) {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
