"use strict";

const { Plugin, Menu, setIcon, Notice } = require("obsidian");

const DEFAULT_DATA = { pins: [] };

module.exports = class StarPinsPlugin extends Plugin {
  async onload() {
    this.data = Object.assign({}, DEFAULT_DATA, await this.loadData());
    if (!Array.isArray(this.data.pins)) this.data.pins = [];

    // Add / refresh the star button + keep the explorer grid mounted.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshHeaders();
        this.mountGrid();
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.refreshHeaders();
        this.mountGrid();
      })
    );

    // Keep pins consistent when files are renamed or deleted.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const i = this.data.pins.indexOf(oldPath);
        if (i !== -1) {
          this.data.pins[i] = file.path;
          this.persistAndRender();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        const i = this.data.pins.indexOf(file.path);
        if (i !== -1) {
          this.data.pins.splice(i, 1);
          this.persistAndRender();
        }
      })
    );

    // Command palette + hotkey support.
    this.addCommand({
      id: "toggle-pin-active-file",
      name: "Pin / unpin current file",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.togglePin(file.path);
        return true;
      },
    });

    this.app.workspace.onLayoutReady(() => {
      this.mountGrid();
      this.refreshHeaders();
    });
  }

  onunload() {
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    if (this.gridEl) this.gridEl.remove();
    this.gridEl = null;
    // Remove our header buttons.
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf && leaf.view;
      if (view && view.__starPinEl) {
        view.__starPinEl.remove();
        view.__starPinEl = null;
      }
    });
  }

  /* ---------- data ---------- */

  isPinned(path) {
    return !!path && this.data.pins.includes(path);
  }

  async togglePin(path) {
    if (!path) return;
    const i = this.data.pins.indexOf(path);
    if (i === -1) this.data.pins.push(path);
    else this.data.pins.splice(i, 1);
    await this.persistAndRender();
  }

  async unpin(path) {
    const i = this.data.pins.indexOf(path);
    if (i !== -1) {
      this.data.pins.splice(i, 1);
      await this.persistAndRender();
    }
  }

  // Reorder: drop `fromPath` next to `toPath` (toPath null = move to the end).
  async movePin(fromPath, toPath, placeAfter) {
    if (!fromPath || fromPath === toPath) return;
    const pins = this.data.pins;
    const from = pins.indexOf(fromPath);
    if (from === -1) return;
    pins.splice(from, 1);
    let to = toPath == null ? pins.length : pins.indexOf(toPath);
    if (to === -1) to = pins.length;
    if (placeAfter) to += 1;
    pins.splice(to, 0, fromPath);
    await this.persistAndRender();
  }

  async persistAndRender() {
    await this.saveData(this.data);
    this.renderGrid();
    this.refreshHeaders();
  }

  /* ---------- header star button ---------- */

  forEachMarkdownView(cb) {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      if (leaf.view) cb(leaf.view);
    });
  }

  refreshHeaders() {
    // Any open view that is backed by a file and supports header actions
    // (markdown, bases, canvas, …) gets a star button.
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf && leaf.view;
      if (view && view.file && typeof view.addAction === "function") {
        this.ensureStarButton(view);
      }
    });
  }

  ensureStarButton(view) {
    const path = view.file ? view.file.path : null;

    if (!view.__starPinEl) {
      const el = view.addAction("star", "Pin file", () => {
        if (view.file) this.togglePin(view.file.path);
      });
      el.addClass("star-pin-action");
      view.__starPinEl = el;
    }

    const pinned = this.isPinned(path);
    view.__starPinEl.toggleClass("is-pinned", pinned);
    view.__starPinEl.setAttr("aria-label", pinned ? "Unpin file" : "Pin file");
  }

  /* ---------- Iconize integration ---------- */

  // Read the icon name that Iconize (obsidian-icon-folder) assigned to a path.
  getIconizeIcon(path) {
    const ip = this.app.plugins && this.app.plugins.plugins
      ? this.app.plugins.plugins["obsidian-icon-folder"]
      : null;
    if (!ip) return null;
    const data = ip.data || (typeof ip.getData === "function" ? ip.getData() : null);
    if (!data || typeof data !== "object") return null;
    let raw = data[path];
    if (raw && typeof raw === "object") raw = raw.iconName || raw.icon || null;
    return typeof raw === "string" && raw.length ? raw : null;
  }

  // Render an Iconize icon into `container`. Returns true on success.
  applyIcon(container, iconName) {
    if (!iconName) return false;

    // Prefixed icon-pack names: "Li" (native Lucide), "Fa", "Bi", ...
    if (/^[A-Z][a-z][A-Z0-9]/.test(iconName)) {
      // Native Lucide -> Obsidian's bundled setIcon understands the kebab id.
      if (iconName.startsWith("Li")) {
        const kebab = iconName
          .slice(2)
          .replace(/([a-zA-Z])([0-9])/g, "$1-$2")
          .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
          .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
          .toLowerCase();
        const span = container.createSpan();
        setIcon(span, kebab);
        if (span.childElementCount > 0) return true;
        span.remove();
      }
      // Any icon pack: ask Iconize to give us the SVG.
      if (this.renderViaIconize(container, iconName)) return true;
      return false;
    }

    // Otherwise treat it as an emoji / text glyph.
    container.createSpan({ cls: "star-pin-emoji", text: iconName });
    return true;
  }

  renderViaIconize(container, iconName) {
    try {
      const ip = this.app.plugins.plugins["obsidian-icon-folder"];
      const api = ip && ip.api;
      const icon =
        api && typeof api.getIconByName === "function" ? api.getIconByName(iconName) : null;
      const svg = icon && (icon.svgElement || icon.svg || icon.iconName);
      if (typeof svg === "string" && svg.indexOf("<svg") !== -1) {
        container.innerHTML = svg;
        return true;
      }
    } catch (e) {
      /* Iconize API shape varies between versions; fall back silently. */
    }
    return false;
  }

  /* ---------- explorer grid ---------- */

  getExplorerContainer() {
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    if (!leaf || !leaf.view || !leaf.view.containerEl) return null;
    return leaf.view.containerEl;
  }

  mountGrid() {
    const container = this.getExplorerContainer();
    if (!container) return;

    // Already mounted and still in the DOM -> just refresh contents.
    if (this.gridEl && container.contains(this.gridEl)) {
      this.renderGrid();
      this.watchExplorer(container);
      return;
    }
    if (this.gridEl) this.gridEl.remove();

    const filesContainer = container.querySelector(".nav-files-container");
    this.gridEl = createDiv("star-pins-grid");
    if (filesContainer && filesContainer.parentElement) {
      filesContainer.parentElement.insertBefore(this.gridEl, filesContainer);
    } else {
      container.appendChild(this.gridEl);
    }
    this.attachGridDnd();
    this.renderGrid();
    this.watchExplorer(container);
  }

  // Grid-level drop target: dropping in the empty gap moves the tile to the end.
  attachGridDnd() {
    this.gridEl.addEventListener("dragover", (e) => {
      if (this._dragPath) e.preventDefault();
    });
    this.gridEl.addEventListener("drop", (e) => {
      if (!this._dragPath) return;
      e.preventDefault();
      const from = this._dragPath;
      this._dragPath = null;
      this.movePin(from, null, false);
    });
  }

  // Re-insert the grid whenever the explorer rebuilds its DOM and drops our node.
  watchExplorer(container) {
    if (this.observedContainer === container && this.observer) return;
    if (this.observer) this.observer.disconnect();
    this.observedContainer = container;
    this.observer = new MutationObserver(() => {
      if (this.gridEl && !container.contains(this.gridEl)) {
        this.mountGrid();
      }
    });
    this.observer.observe(container, { childList: true, subtree: true });
  }

  renderGrid() {
    // Re-mount if the explorer was closed/reopened and our node is gone.
    const container = this.getExplorerContainer();
    if (!this.gridEl || (container && !container.contains(this.gridEl))) {
      this.mountGrid();
      return;
    }
    if (this.data.pins.length === 0) {
      this.gridEl.addClass("is-empty");
      this.gridEl.empty();
      this._renderKey = "";
      return;
    }
    this.gridEl.removeClass("is-empty");

    // Only rebuild the tiles when the pins (or their icons) actually changed.
    // Otherwise an active-leaf-change on click would replace the tile mid-click.
    const key = this.data.pins
      .map((p) => p + "|" + (this.getIconizeIcon(p) || ""))
      .join("~");
    if (key === this._renderKey && this.gridEl.childElementCount === this.data.pins.length) {
      return;
    }
    this._renderKey = key;
    this.gridEl.empty();

    this.data.pins.forEach((path) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      const name = file ? file.basename || file.name : path.split("/").pop();
      const label = (name || "?").replace(/\.[^.]+$/, "");

      const tile = this.gridEl.createDiv("star-pin-tile");
      tile.setAttr("aria-label", label);
      if (!file) tile.addClass("is-missing");

      // Drag & drop reordering.
      tile.setAttr("draggable", "true");
      tile.addEventListener("dragstart", (e) => {
        this._dragPath = path;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", path);
        tile.addClass("is-dragging");
      });
      tile.addEventListener("dragend", () => {
        this._dragPath = null;
        tile.removeClass("is-dragging");
        tile.removeClass("drop-before");
        tile.removeClass("drop-after");
      });
      tile.addEventListener("dragover", (e) => {
        if (!this._dragPath || this._dragPath === path) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const r = tile.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        tile.toggleClass("drop-after", after);
        tile.toggleClass("drop-before", !after);
      });
      tile.addEventListener("dragleave", () => {
        tile.removeClass("drop-before");
        tile.removeClass("drop-after");
      });
      tile.addEventListener("drop", (e) => {
        if (!this._dragPath) return;
        e.preventDefault();
        e.stopPropagation();
        const r = tile.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        const from = this._dragPath;
        this._dragPath = null;
        tile.removeClass("drop-before");
        tile.removeClass("drop-after");
        this.movePin(from, path, after);
      });

      const iconWrap = tile.createDiv("star-pin-icon");
      const iconName = file ? this.getIconizeIcon(file.path) : null;
      if (!this.applyIcon(iconWrap, iconName)) {
        iconWrap.addClass("is-mono");
        iconWrap.setText(label.trim().slice(0, 1).toUpperCase() || "?");
      }

      tile.addEventListener("click", (evt) => {
        if (!file) {
          new Notice("Pinned file no longer exists.");
          return;
        }
        this.app.workspace.getLeaf(evt.ctrlKey || evt.metaKey).openFile(file);
      });

      tile.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        const menu = new Menu();
        menu.addItem((item) =>
          item
            .setTitle("Unpin")
            .setIcon("star-off")
            .onClick(() => this.unpin(path))
        );
        if (file) {
          menu.addItem((item) =>
            item
              .setTitle("Open in new tab")
              .setIcon("file-plus")
              .onClick(() => this.app.workspace.getLeaf(true).openFile(file))
          );
        }
        menu.showAtMouseEvent(evt);
      });
    });
  }
};
