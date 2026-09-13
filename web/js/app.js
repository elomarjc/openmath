/**
 * OpenMath Web Application Coordinator
 * Integrates Web Worker CAS runtime, interactive worksheet, palettes, and mobile touch dock.
 */

import { WorksheetManager } from "./worksheet.js";
import { PaletteManager } from "./palette.js";

class OpenMathApp {
  constructor() {
    this.worker = null;
    this.worksheet = null;
    this.palette = null;
    let storedTheme = "dark";
    try {
      storedTheme = localStorage.getItem("openmath_theme") || "dark";
    } catch (e) {
      storedTheme = "dark";
    }
    this.theme = storedTheme;
    this.pendingEvaluations = new Map();
  }

  init() {
    this.initTheme();
    this.initWorksheet();
    this.initPalette();
    this.initWorker();
    this.bindHeaderEvents();
    this.bindExportModal();
    this.bindImportEvents();
  }

  initTheme() {
    this.applyTheme(this.theme);

    const themeToggleBtn = document.getElementById("theme-toggle-btn");
    if (themeToggleBtn) {
      themeToggleBtn.addEventListener("click", () => {
        const nextTheme = this.theme === "dark" ? "light" : "dark";
        this.applyTheme(nextTheme);
      });
    }

    const themeOptDark = document.getElementById("theme-opt-dark");
    const themeOptLight = document.getElementById("theme-opt-light");
    if (themeOptDark) {
      themeOptDark.addEventListener("click", () => {
        this.applyTheme("dark");
      });
    }
    if (themeOptLight) {
      themeOptLight.addEventListener("click", () => {
        this.applyTheme("light");
      });
    }
  }

  applyTheme(theme) {
    this.theme = theme;
    try {
      localStorage.setItem("openmath_theme", theme);
    } catch (e) {
      console.warn("Could not save theme to localStorage:", e);
    }
    document.body.className = `theme-${theme}`;
    document.documentElement.setAttribute("data-theme", theme);

    const moonIcon = document.getElementById("theme-icon-moon");
    const sunIcon = document.getElementById("theme-icon-sun");

    if (moonIcon && sunIcon) {
      if (theme === "dark") {
        moonIcon.style.display = "block";
        sunIcon.style.display = "none";
      } else {
        moonIcon.style.display = "none";
        sunIcon.style.display = "block";
      }
    }

    const themeOptDark = document.getElementById("theme-opt-dark");
    const themeOptLight = document.getElementById("theme-opt-light");
    if (themeOptDark && themeOptLight) {
      if (theme === "dark") {
        themeOptDark.classList.add("active");
        themeOptLight.classList.remove("active");
      } else {
        themeOptDark.classList.remove("active");
        themeOptLight.classList.add("active");
      }
    }

    if (this.worksheet) {
      this.worksheet.setTheme(theme);
    }
  }

  initWorker() {
    const loadingOverlay = document.getElementById("loading-overlay");
    const loadingStatus = document.getElementById("loading-status");
    const statusText = document.getElementById("status-text");
    const statusDot = document.getElementById("status-indicator");
    const engineTag = document.getElementById("engine-version");

    try {
      this.worker = new Worker("./js/cas-worker.js");

      this.worker.onerror = (err) => {
        console.error("Web Worker error:", err);
        const errDetail = err.message || (err.error && err.error.message) || "Worker initialization failed";
        if (loadingStatus) loadingStatus.textContent = `Worker Error: ${errDetail}`;
        if (statusText) statusText.textContent = `Worker Error: ${errDetail}`;
        if (statusDot) statusDot.className = "status-dot error";
      };

      this.worker.onmessage = (e) => {
        const data = e.data;
        if (!data) return;

        switch (data.type) {
          case "STATUS":
            if (loadingStatus) loadingStatus.textContent = data.message;
            if (statusText) statusText.textContent = data.message;
            break;

          case "READY":
            if (loadingOverlay) {
              loadingOverlay.classList.add("hidden");
              setTimeout(() => {
                loadingOverlay.style.display = "none";
              }, 400);
            }
            if (statusDot) statusDot.className = "status-dot ready";
            if (statusText) statusText.textContent = "Ready (Pyodide CAS Engine)";
            if (engineTag && data.info) {
              engineTag.textContent = `SymPy ${data.info.sympy_version} • NumPy ${data.info.numpy_version}`;
            }
            break;

          case "RESULT":
            if (this.worksheet) {
              this.worksheet.handleResult(data.id, data);
            }
            break;

          case "DOCUMENT_PARSED":
            if (data.error) {
              alert(`Could not parse document: ${data.error}`);
            } else if (data.cells && data.cells.length > 0) {
              if (this.worksheet) {
                this.worksheet.loadImportedCells(data.cells);
              }
              if (statusText) statusText.textContent = `Loaded ${data.cells.length} cells from document.`;
            } else {
              alert("No valid calculation cells found in this file.");
            }
            break;

          case "ERROR":
            if (loadingStatus) loadingStatus.textContent = data.message;
            if (statusDot) statusDot.className = "status-dot error";
            if (statusText) statusText.textContent = data.message;
            break;
        }
      };

      // Start initialization
      this.worker.postMessage({ type: "INIT", basePath: "../" });
    } catch (err) {
      console.error("Failed to start Web Worker:", err);
      if (loadingStatus) loadingStatus.textContent = `Worker Error: ${err.message}`;
    }
  }

  initWorksheet() {
    const container = document.getElementById("worksheet-container");
    this.worksheet = new WorksheetManager(
      container,
      (cellId, expr, precision) => {
        if (this.worker) {
          this.worker.postMessage({
            type: "EVALUATE",
            id: cellId,
            expr: expr,
            precision: precision
          });
        }
      },
      { theme: this.theme }
    );

    // Initial default cell with an example calculation
    const firstCell = this.worksheet.addCell("diff(sin(x)*cos(x), x)", true);

    const addCellTopBtn = document.getElementById("btn-add-cell-top");
    const addCellBottomBtn = document.getElementById("btn-add-cell-bottom");

    if (addCellTopBtn) addCellTopBtn.addEventListener("click", () => this.worksheet.addCell("", true));
    if (addCellBottomBtn) addCellBottomBtn.addEventListener("click", () => this.worksheet.addCell("", true));
  }

  initPalette() {
    this.palette = new PaletteManager((text, cursorOffset) => {
      if (this.worksheet) {
        this.worksheet.insertTextAtCursor(text, cursorOffset);
      }
    });
    this.palette.init();
  }

  bindHeaderEvents() {
    // Mode Switch (Exact / Numeric)
    const exactBtn = document.getElementById("global-mode-exact");
    const numBtn = document.getElementById("global-mode-numeric");

    if (exactBtn && numBtn) {
      exactBtn.addEventListener("click", () => {
        exactBtn.classList.add("active");
        numBtn.classList.remove("active");
        if (this.worksheet) this.worksheet.setGlobalMode("exact");
      });

      numBtn.addEventListener("click", () => {
        numBtn.classList.add("active");
        exactBtn.classList.remove("active");
        if (this.worksheet) this.worksheet.setGlobalMode("numeric");
      });
    }

    // Precision selectors (Global header and Sidebar drawer)
    const precSelect = document.getElementById("global-precision-select");
    const sidePrecSelect = document.getElementById("sidebar-precision-select");

    const updatePrecision = (val) => {
      if (precSelect) precSelect.value = val;
      if (sidePrecSelect) sidePrecSelect.value = val;
      if (this.worksheet) this.worksheet.setGlobalPrecision(val);
    };

    if (precSelect) {
      precSelect.addEventListener("change", (e) => updatePrecision(e.target.value));
    }
    if (sidePrecSelect) {
      sidePrecSelect.addEventListener("change", (e) => updatePrecision(e.target.value));
    }

    // Clear All
    const clearBtn = document.getElementById("btn-clear-all");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        if (confirm("Clear all calculation cells in worksheet?")) {
          if (this.worksheet) this.worksheet.clearWorksheet();
        }
      });
    }

    // Mobile Sidebar Drawer Toggle
    const mobileMenuBtn = document.getElementById("mobile-menu-toggle");
    const closeSidebarBtn = document.getElementById("close-sidebar-btn");
    const sidebar = document.getElementById("app-sidebar");

    if (mobileMenuBtn && sidebar) {
      mobileMenuBtn.addEventListener("click", () => {
        sidebar.classList.toggle("open");
      });
    }

    if (closeSidebarBtn && sidebar) {
      closeSidebarBtn.addEventListener("click", () => {
        sidebar.classList.remove("open");
      });
    }
  }

  bindExportModal() {
    const exportBtn = document.getElementById("btn-export");
    const exportModal = document.getElementById("export-modal");
    const closeExportBtn = document.getElementById("close-export-modal");

    if (exportBtn && exportModal) {
      exportBtn.addEventListener("click", () => exportModal.classList.add("open"));
    }
    if (closeExportBtn && exportModal) {
      closeExportBtn.addEventListener("click", () => exportModal.classList.remove("open"));
    }

    document.querySelectorAll(".export-opt-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const fmt = btn.dataset.format;
        if (this.worksheet) {
          this.worksheet.exportDocument(fmt);
        }
        if (exportModal) exportModal.classList.remove("open");
      });
    });
  }

  bindImportEvents() {
    const fileInputs = document.querySelectorAll(".file-import-input");

    const processFile = (file) => {
      if (!file) return;

      const statusText = document.getElementById("status-text");
      if (statusText) statusText.textContent = `Reading ${file.name}...`;

      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target.result;
        const fname = file.name.toLowerCase();

        // Check if JSON format
        if (fname.endsWith(".json")) {
          try {
            const doc = JSON.parse(content);
            const cellList = Array.isArray(doc) ? doc : (doc.cells || []);
            if (cellList.length > 0 && this.worksheet) {
              this.worksheet.loadImportedCells(cellList);
              if (statusText) statusText.textContent = `Loaded ${cellList.length} cells from ${file.name}.`;
              return;
            }
          } catch (err) {
            console.warn("Falling back to worker parser:", err);
          }
        }

        // Send to Web Worker to parse .mw, .mv, or formatted text
        if (this.worker) {
          if (statusText) statusText.textContent = `Parsing ${file.name}...`;
          this.worker.postMessage({ type: "PARSE_DOCUMENT", content: content, filename: file.name });
        }
      };

      reader.onerror = (err) => {
        console.error("FileReader error:", err);
        if (statusText) statusText.textContent = `Error reading ${file.name}`;
        alert(`Error reading file: ${file.name}`);
      };

      reader.readAsText(file);
    };

    fileInputs.forEach((inp) => {
      inp.addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        processFile(file);
        inp.value = "";
      });
    });

    // Drag and drop onto window
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        processFile(e.dataTransfer.files[0]);
      }
    });

    // Run All button in worksheet footer
    const runAllBtn = document.getElementById("btn-run-all");
    if (runAllBtn) {
      runAllBtn.addEventListener("click", () => {
        if (this.worksheet) {
          this.worksheet.evaluateAll();
        }
      });
    }
  }
}

// Safe startup handler for mobile browsers and standard DOM environments
function startApp() {
  if (window._openMathAppStarted) return;
  window._openMathAppStarted = true;
  try {
    const app = new OpenMathApp();
    app.init();
    window.openMathApp = app;
  } catch (err) {
    console.error("Fatal startup error in OpenMathApp:", err);
    const loadingStatus = document.getElementById("loading-status");
    if (loadingStatus) {
      loadingStatus.textContent = `Startup error: ${err.message}`;
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startApp);
} else {
  // DOM already parsed or interactive (common in iOS Safari module execution)
  startApp();
}
