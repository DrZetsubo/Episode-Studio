const { Plugin, ItemView, normalizePath, TFile } = require("obsidian");

const VIEW_TYPE = "episode-studio-view";
const DEFAULT_FOLDER = "Episodes";

class EpisodeStudioView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.mode = "episodes";
    this.currentPath = null;
    this._saveTimer = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Episode Studio"; }
  getIcon() { return "book-open"; }

  async onOpen() {
    await this.plugin.ensureFolder();
    await this.renderEpisodesPage();
  }

  async onClose() {
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
  }

  el(tag, cls, parent, text) {
    const node = parent.createEl(tag, { cls: cls || "" });
    if (text !== undefined) node.textContent = text;
    return node;
  }

  clear() { this.contentEl.empty(); }

  async getEpisodes() {
    const folder = this.plugin.folderPath();
    
    
    const files = this.app.vault.getMarkdownFiles().filter(f =>
      f.path.startsWith(folder + "/") && /^Ep\.\s+\d+\.md$/i.test(f.name)
    );
    const episodes = [];
    for (const file of files) {
      let title = "Untitled";
      try {
        const content = await this.app.vault.read(file);
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
        if (fmMatch) {
          const titleMatch = fmMatch[1].match(/^episodeTitle:\s*(.*)$/m);
          if (titleMatch) title = titleMatch[1].trim().replace(/^['"]|['"]$/g, "") || "Untitled";
        }
      } catch (e) { console.warn("Could not read episode", file.path, e); }
      const match = file.basename.match(/^Ep\.\s+(\d+)$/i);
      const number = match ? Number(match[1]) : 0;
      episodes.push({ file, number, title });
    }
    return episodes.sort((a,b) => a.number - b.number || a.file.name.localeCompare(b.file.name));
  }

  async migrateToStableFiles() {
    // Compatibility migration: older builds stored episodes as Episode-<id>.md.
    // Convert them to fixed Ep. N.md filenames via a two-phase rename. File contents
    // are not rewritten, so titles, scripts, and frontmatter are preserved.
    const folder = this.plugin.folderPath();
    const all = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(folder + "/"));
    const canonical = all.filter(f => /^Ep\.\s+\d+\.md$/i.test(f.name));
    const stable = all.filter(f => /^Episode-[a-z0-9-]+\.md$/i.test(f.name));
    if (!stable.length) return;
    const records = [];
    for (const file of [...canonical, ...stable]) {
      let number = 0;
      try {
        const content = await this.app.vault.read(file);
        const fm = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
        const numMatch = fm && fm[1].match(/^episodeNumber:\s*(\d+)\s*$/m);
        if (numMatch) number = Number(numMatch[1]);
      } catch (e) { console.warn("Could not read episode number during migration", file.path, e); }
      if (!number) {
        const match = file.basename.match(/^Ep\.\s*(\d+)$/i);
        if (match) number = Number(match[1]);
      }
      records.push({ file, number });
    }
    records.sort((a,b) => a.number - b.number || a.file.name.localeCompare(b.file.name));
    if (records.length > 200) throw new Error("Episode Studio supports up to 200 episodes. No migration was performed.");
    const staged = [];
    try {
      for (const record of records) {
        const file = record.file;
        const live = this.app.vault.getAbstractFileByPath(file.path);
        if (!(live instanceof TFile)) continue;
        const tempPath = normalizePath(`${folder}/.episode-stage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}.md`);
        if (this.app.vault.getAbstractFileByPath(tempPath)) throw new Error("Temporary filename collision; migration stopped safely.");
        await this.app.vault.rename(live, tempPath);
        staged.push({ tempPath, original: file.path });
      }
      for (let i = 0; i < staged.length; i++) {
        const target = normalizePath(`${folder}/Ep. ${i + 1}.md`);
        const live = this.app.vault.getAbstractFileByPath(staged[i].tempPath);
        if (!(live instanceof TFile)) throw new Error("A staged episode could not be found; migration stopped.");
        if (this.app.vault.getAbstractFileByPath(target)) throw new Error(`Target already exists: ${target}`);
        await this.app.vault.rename(live, target);
      }
    } catch (e) {
      console.error("Episode filename migration failed. Staged files are preserved for recovery.", e);
      throw e;
    }
  }

  async renumberEpisodes() {
    // Change filenames only; contents are never rewritten.
    const folder = this.plugin.folderPath();
    const episodes = await this.getEpisodes();
    if (episodes.length > 200) throw new Error("Episode Studio supports a maximum of 200 episodes.");

    // Fast path: every file is exactly "Ep. N.md" with a unique N. Closing a gap
    // then only moves files DOWN (Ep. 3 -> Ep. 2), and the target is always free
    // because episodes are processed in ascending order. No temporary files are
    // created at all, so nothing can be left behind.
    const seen = new Set();
    const simple = episodes.every(ep => {
      if (ep.file.name !== `Ep. ${ep.number}.md` || seen.has(ep.number)) return false;
      seen.add(ep.number);
      return true;
    });

    if (simple) {
      for (let i = 0; i < episodes.length; i++) {
        const target = normalizePath(`${folder}/Ep. ${i + 1}.md`);
        const live = this.app.vault.getAbstractFileByPath(episodes[i].file.path);
        if (!(live instanceof TFile)) throw new Error(`Episode file missing: ${episodes[i].file.path}`);
        if (live.path === target) continue;
        if (this.app.vault.getAbstractFileByPath(target)) throw new Error(`Unexpected filename conflict: ${target}`);
        await this.app.vault.rename(live, target);
      }
    } else {
      // Unusual names (e.g. "Ep. 02.md" or duplicate numbers): stage every file
      // first so a rename can never collide, then move each to its final name.
      const staged = [];
      for (const ep of episodes) {
        const live = this.app.vault.getAbstractFileByPath(ep.file.path);
        if (!(live instanceof TFile)) throw new Error(`Episode file missing: ${ep.file.path}`);
        const tempPath = normalizePath(`${folder}/.episode-stage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}.md`);
        if (this.app.vault.getAbstractFileByPath(tempPath)) throw new Error("Could not allocate a safe temporary filename.");
        await this.app.vault.rename(live, tempPath);
        staged.push(tempPath);
      }
      for (let i = 0; i < staged.length; i++) {
        const target = normalizePath(`${folder}/Ep. ${i + 1}.md`);
        const live = this.app.vault.getAbstractFileByPath(staged[i]);
        if (!(live instanceof TFile)) throw new Error(`Staged episode missing: ${staged[i]}`);
        if (this.app.vault.getAbstractFileByPath(target)) throw new Error(`Unexpected filename conflict: ${target}`);
        await this.app.vault.rename(live, target);
      }
    }
    await this.plugin.saveData(this.plugin.settings);
    await this.purgeLeftoverCopies();
  }

  async purgeLeftoverCopies() {
    // Removes stale files that are byte-for-byte copies of a real episode:
    //  - "Ep. N.md" on disk with N beyond the episode count (a leftover of a rename)
    //  - leftover staging files in the episode folder
    // A file whose content matches no episode is NEVER deleted; it is left for you.
    try {
      const adapter = this.app.vault.adapter;
      const folder = this.plugin.folderPath();
      const episodes = await this.getEpisodes();
      const live = new Set(episodes.map(ep => ep.file.path));
      const candidates = [];
      const scan = async (dir, test) => {
        let listing;
        try { listing = await adapter.list(dir); } catch (e) { return; }
        for (const path of (listing.files || [])) {
          const name = path.split("/").pop();
          if (test(name, path)) candidates.push(path);
        }
      };
      await scan(folder, (name, path) => {
        const m = name.match(/^Ep\.\s*(\d+)\.md$/i);
        return !!m && Number(m[1]) > episodes.length && !live.has(path);
      });
      await scan(folder, name => /^\.episode-stage-.+\.md$/i.test(name));
      if (!candidates.length) return;

      const known = new Set();
      for (const ep of episodes) {
        try { known.add(await adapter.read(ep.file.path)); } catch (e) { /* ignore */ }
      }
      for (const path of candidates) {
        try {
          const content = await adapter.read(path);
          if (!known.has(content)) { console.warn("Episode Studio: kept unmatched leftover file", path); continue; }
          const tracked = this.app.vault.getAbstractFileByPath(path);
          if (tracked instanceof TFile) await this.app.vault.delete(tracked, true);
          else await adapter.remove(path);
        } catch (e) { console.warn("Episode Studio: could not remove leftover file", path, e); }
      }
    } catch (e) { console.warn("Episode Studio: leftover cleanup skipped", e); }
  }

  async renderEpisodesPage() {
    this.mode = "episodes";
    this.currentPath = null;
    this.clear();
    const root = this.el("div", "es-root", this.contentEl);
    const header = this.el("div", "es-header", root);
    const headingWrap = this.el("div", "es-heading-wrap", header);
    this.el("h2", "es-page-title", headingWrap, "Episodes");
    const add = this.el("button", "es-primary-btn", header, "+ New Episode");
    add.addEventListener("click", () => this.createEpisode());

    const listWrap = this.el("div", "es-list-wrap", root);
    await this.migrateToStableFiles();
    await this.purgeLeftoverCopies();
    const episodes = await this.getEpisodes();
    if (!episodes.length) {
      const empty = this.el("div", "es-empty", listWrap);
      this.el("div", "es-empty-icon", empty, "✦");
      this.el("h3", "", empty, "Your story starts here");
      this.el("p", "", empty, "Create your first episode. It will be saved as a Markdown file in your vault.");
      const first = this.el("button", "es-primary-btn", empty, "Create Ep. 1");
      first.addEventListener("click", () => this.createEpisode());
      return;
    }

    for (const ep of episodes) {
      const row = this.el("div", "es-episode-row", listWrap);
      const info = this.el("div", "es-episode-info", row);
      this.el("div", "es-episode-name", info, `Ep. ${ep.number}  ${ep.title}`);
      const actions = this.el("div", "es-actions", row);
      const read = this.el("button", "es-small-btn es-read-btn", actions, "Read");
      read.addEventListener("click", () => this.openEpisode(ep.file.path, "read"));
    }
  }

  async createEpisode() {
    await this.plugin.ensureFolder();
    await this.migrateToStableFiles();
    const episodes = await this.getEpisodes();
    if (episodes.length >= 200) {
      console.warn("Episode Studio supports a maximum of 200 episodes.");
      return;
    }
    const number = episodes.length + 1;
    const path = normalizePath(`${this.plugin.folderPath()}/Ep. ${number}.md`);
    const content = `---\nepisodeTitle: "Untitled"\n---\n\n`;
    try {
      if (this.app.vault.getAbstractFileByPath(path)) {
        // Normalize filenames before creating; never let Obsidian make Ep. N 2.md.
        await this.renumberEpisodes();
      }
      const freshPath = normalizePath(`${this.plugin.folderPath()}/Ep. ${number}.md`);
      if (this.app.vault.getAbstractFileByPath(freshPath)) throw new Error(`Episode filename already exists: ${freshPath}`);
      await this.app.vault.create(freshPath, content);
      await this.plugin.saveData(this.plugin.settings);
      await this.openEpisode(freshPath, "edit");
    } catch (e) {
      console.error(e);
    }
  }

  async deleteEpisode(ep) {
    const confirmed = window.confirm(`Delete Ep. ${ep.number} — "${ep.title}"? This Markdown file will be deleted from your vault.`);
    if (!confirmed) return;
    try {
      const live = this.app.vault.getAbstractFileByPath(ep.file.path);
      if (!(live instanceof TFile)) throw new Error("Episode file no longer exists.");
      // Permanent delete. trash() sends the file to the .trash folder on Android,
      // where it keeps taking up space and shows up in the file manager.
      await this.app.vault.delete(live, true);
      await this.renumberEpisodes();
      await this.renderEpisodesPage();
    } catch (e) {
      console.error("Could not safely delete and renumber episodes", e);
    }
  }

  async openEpisode(path, mode) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return;
    }
    this.currentPath = path;
    this.mode = mode;
    this.clear();
    const root = this.el("div", "es-root es-editor-root", this.contentEl);
    const toolbar = this.el("div", "es-toolbar", root);
    const back = this.el("button", "es-back-btn", toolbar, "← Episodes");
    back.addEventListener("click", async () => {
      await this.flushSave();
      await this.renderEpisodesPage();
    });

    const fileContent = await this.app.vault.read(file);
    const parsed = this.parseEpisode(fileContent, file);
    const titleInput = this.el("input", "es-title-input", toolbar);
    titleInput.type = "text";
    titleInput.value = parsed.title;
    titleInput.placeholder = "Episode title";
    titleInput.setAttribute("aria-label", "Episode title");
    const modeLabel = this.el("div", "es-mode-label", toolbar, mode === "read" ? "READ MODE" : "EDIT MODE");
    const modeButton = this.el("button", "es-small-btn es-mode-switch", toolbar, mode === "read" ? "Edit" : "Read");
    modeButton.addEventListener("click", async () => {
      await this.flushSave();
      await this.openEpisode(path, mode === "read" ? "edit" : "read");
    });
    const deleteButton = this.el("button", "es-small-btn es-delete-episode", toolbar, "Delete");
    deleteButton.addEventListener("click", async () => {
      await this.flushSave();
      const current = this.app.vault.getAbstractFileByPath(path);
      if (current instanceof TFile) {
        const listed = (await this.getEpisodes()).find(item => item.file.path === current.path);
        const ep = { file: current, number: listed ? listed.number : 0, title: titleInput.value || "Untitled" };
        await this.deleteEpisode(ep);
      }
    });

    const body = this.el("div", "es-body", root);
    const panels = this.parsePanels(parsed.body);
    if (mode === "edit") {
      titleInput.disabled = false;
      this.panelState = panels;
      // Opening Edit Mode starts compact: collapse every existing panel.
      this.collapsedPanels = new Set(panels.map(panel => panel.id));
      titleInput.addEventListener("input", () => this.queuePanelSave(path, titleInput.value));
      this.renderPanelEditor(body, path, titleInput.value);
      const footer = this.el("div", "es-editor-footer", root);
      this.el("span", "es-markdown-hint", footer, "Panel-based webtoon script · changes save automatically");
      this.saveStatus = this.el("span", "es-save-status", footer, "Saved");
    } else {
      titleInput.disabled = true;
      titleInput.classList.add("es-title-readonly");
      const readPane = this.el("div", "es-read-pane es-panel-read-pane", body);
      this.renderPanelPreview(readPane, panels);
      this.saveStatus = null;
    }
  }

  parsePanels(body) {
    const match = body.match(/<!-- EPISODE_STUDIO_PANELS\n([\s\S]*?)\n-->/);
    if (match) {
      try {
        const value = JSON.parse(match[1]);
        if (Array.isArray(value)) return value.map((p, i) => ({
          scene: p.scene || "", characters: Array.isArray(p.characters) ? p.characters : [], sfx: Array.isArray(p.sfx) ? p.sfx : [], id: p.id || `${Date.now()}-${i}`
        }));
      } catch (e) { console.warn("Could not parse Episode Studio panels", e); }
    }
    const legacy = body.trim();
    if (!legacy) return [];
    return [{ id: `${Date.now()}-1`, scene: legacy, characters: [], sfx: [] }];
  }

  panelBody() {
    const panels = (this.panelState || []).map((panel, index) => ({
      id: panel.id || `${Date.now()}-${index}`,
      scene: String(panel.scene || ""),
      characters: (Array.isArray(panel.characters) ? panel.characters : []).map(ch => ({
        name: String(ch.name || ""),
        type: ["Dialogue", "Thought", "Monologue"].includes(ch.type) ? ch.type : "Dialogue",
        text: String(ch.text || "")
      })),
      sfx: (Array.isArray(panel.sfx) ? panel.sfx : []).map(sound => String(sound || ""))
    }));
    // Compact serialization avoids whitespace bloat and strips unknown legacy keys.
    return `<!-- EPISODE_STUDIO_PANELS\n${JSON.stringify(panels)}\n-->`;
  }

  currentEpisodeTitle() {
    const input = this.contentEl.querySelector(".es-title-input");
    return input ? input.value : "Untitled";
  }

  renderPanelEditor(container, path, title) {
    container.empty();
    const add = this.el("button", "es-primary-btn es-add-panel", container, "+ Add Panel");
    add.addEventListener("click", () => {
      const newPanel = { id: `${Date.now()}-${Math.random()}`, scene: "", characters: [], sfx: [] };
      this.panelState.push(newPanel);
      if (!this.collapsedPanels) this.collapsedPanels = new Set();
      this.collapsedPanels.delete(newPanel.id);
      this.renderPanelEditor(container, path, title);
      this.queuePanelSave(path, this.currentEpisodeTitle());
    });
    const list = this.el("div", "es-panel-list", container);
    this.panelState.forEach((panel, index) => {
      const card = this.el("section", "es-panel-card", list);
      const heading = this.el("div", "es-panel-card-heading", card);
      this.el("h3", "es-panel-heading", heading, `Panel ${index + 1}`);
      const actions = this.el("div", "es-panel-actions", heading);
      const isCollapsed = this.collapsedPanels && this.collapsedPanels.has(panel.id);
      const toggle = this.el("button", "es-icon-btn es-panel-toggle", actions, isCollapsed ? "＋" : "−");
      toggle.title = isCollapsed ? `Expand Panel ${index + 1}` : `Collapse Panel ${index + 1}`;
      toggle.setAttribute("aria-label", toggle.title);
      toggle.addEventListener("click", () => {
        if (!this.collapsedPanels) this.collapsedPanels = new Set();
        if (this.collapsedPanels.has(panel.id)) this.collapsedPanels.delete(panel.id);
        else this.collapsedPanels.add(panel.id);
        this.renderPanelEditor(container, path, title);
      });
      const del = this.el("button", "es-icon-btn es-panel-delete", actions, "×"); del.title = "Delete panel";
      del.addEventListener("click", () => { if (window.confirm(`Delete Panel ${index+1}?`)) { this.panelState.splice(index, 1); if (this.collapsedPanels) this.collapsedPanels.delete(panel.id); this.renderPanelEditor(container, path, title); this.queuePanelSave(path, title); } });
      if (isCollapsed) {
        card.classList.add("es-panel-collapsed");
        return;
      }
      this.makePanelField(card, "SCENE", "es-label-scene", "Scene description", panel.scene, value => { panel.scene = value; this.queuePanelSave(path, title); }, true);
      const charHeader = this.el("div", "es-panel-section-heading", card);
      this.el("span", "es-label es-label-character", charHeader, "CHARACTER");
      const addChar = this.el("button", "es-small-btn", charHeader, "+ Add Character");
      addChar.addEventListener("click", () => { panel.characters.push({ name: "", type: "Dialogue", text: "" }); this.renderPanelEditor(container, path, title); this.queuePanelSave(path, title); });
      panel.characters.forEach((ch, ci) => {
        const group = this.el("div", "es-character-editor", card);
        const name = this.el("input", "es-panel-input", group); name.placeholder = "Character name"; name.value = ch.name || "";
        name.addEventListener("input", () => { ch.name = name.value; this.queuePanelSave(path, title); });
        const type = this.el("select", "es-panel-select", group);
        ["Dialogue", "Thought", "Monologue"].forEach(t => { const o = type.createEl("option", { text: t, value: t }); if ((ch.type || "Dialogue") === t) o.selected = true; });
        type.addEventListener("change", () => { ch.type = type.value; this.renderPanelEditor(container, path, title); this.queuePanelSave(path, title); });
        const remove = this.el("button", "es-small-btn es-panel-delete", group, "Remove");
        remove.addEventListener("click", () => { panel.characters.splice(ci, 1); this.renderPanelEditor(container, path, title); this.queuePanelSave(path, title); });
        const characterType = ["Dialogue", "Thought", "Monologue"].includes(ch.type) ? ch.type : "Dialogue";
        const typeClass = characterType === "Thought" ? "es-label-thought" : characterType === "Monologue" ? "es-label-monologue" : "es-label-dialogue";
        this.makePanelField(group, characterType.toUpperCase(), typeClass, "", ch.text || "", value => { ch.text = value; this.queuePanelSave(path, title); }, false);
      });
      const sfxHead = this.el("div", "es-panel-section-heading", card);
      this.el("span", "es-label es-label-sfx", sfxHead, "SFX");
      const addSfx = this.el("button", "es-small-btn", sfxHead, "+ Add SFX");
      addSfx.addEventListener("click", () => { panel.sfx.push(""); this.renderPanelEditor(container, path, title); this.queuePanelSave(path, title); });
      panel.sfx.forEach((sound, si) => {
        const line = this.el("div", "es-sfx-editor", card);
        const input = this.el("input", "es-panel-input", line); input.placeholder = "Sound effect…"; input.value = sound;
        input.addEventListener("input", () => { panel.sfx[si] = input.value; this.queuePanelSave(path, title); });
        const remove = this.el("button", "es-small-btn es-panel-delete", line, "×"); remove.addEventListener("click", () => { panel.sfx.splice(si,1); this.renderPanelEditor(container,path,title); this.queuePanelSave(path,title); });
      });
    });
  }

  makePanelField(parent, label, labelClass, placeholder, value, onChange, multiline) {
    const wrap = this.el("div", "es-panel-field", parent);
    this.el("span", `es-label ${labelClass}`, wrap, label);
    const field = this.el(multiline ? "textarea" : "input", multiline ? "es-panel-textarea" : "es-panel-input", wrap);
    field.placeholder = placeholder || (label === "THOUGHT" ? "Write internal thought…" : label === "MONOLOGUE" ? "Write monologue…" : "Write spoken dialogue…");
    field.value = value || "";
    field.addEventListener("input", () => onChange(field.value));
  }

  renderPanelPreview(container, panels) {
    container.empty();
    if (!panels.length) { this.el("p", "es-panel-empty", container, "This episode is empty."); return; }
    panels.forEach((panel, index) => {
      const card = this.el("article", "es-final-panel", container);
      this.el("div", "es-final-panel-number", card, `PANEL ${index + 1}`);
      if (panel.scene && panel.scene.trim()) {
        const block = this.el("div", "es-final-block", card);
        this.el("span", "es-label es-label-scene", block, "SCENE");
        this.el("div", "es-final-text", block, panel.scene);
      }
      (panel.characters || []).forEach(ch => {
        if (!ch.text || !ch.text.trim()) return;
        const block = this.el("div", "es-final-block", card);
        const characterType = ["Dialogue", "Thought", "Monologue"].includes(ch.type) ? ch.type : "Dialogue";
        const thought = characterType === "Thought";
        const typeClass = thought ? "es-label-thought" : characterType === "Monologue" ? "es-label-monologue" : "es-label-dialogue";
        this.el("span", `es-label ${typeClass}`, block, characterType.toUpperCase());
        const line = this.el("div", "es-final-text", block);
        const who = (ch.name || "Character").trim();
        line.createEl("strong", { text: `${who}: ` });
        const text = line.createEl("span", { text: ch.text });
        if (thought) text.addClass("es-thought-text");
        if (characterType === "Monologue") text.addClass("es-monologue-text");
      });
      (panel.sfx || []).forEach(sound => {
        if (!sound || !sound.trim()) return;
        const block = this.el("div", "es-final-block", card);
        this.el("span", "es-label es-label-sfx", block, "SFX");
        this.el("div", "es-final-text es-sfx-text", block, sound);
      });
    });
  }

  queuePanelSave(path, title) {
    if (this.saveStatus) this.saveStatus.setText("Saving…");
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
    this._saveTimer = window.setTimeout(async () => {
      await this.saveEpisode(path, this.currentEpisodeTitle() || title, this.panelBody());
    }, 350);
  }

  parseEpisode(content, file) {
    let title = "Untitled";
    let body = content;
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
    if (fmMatch) {
      const titleMatch = fmMatch[1].match(/^episodeTitle:\s*(.*)$/m);
      if (titleMatch) title = titleMatch[1].trim().replace(/^["']|["']$/g, "") || "Untitled";
      body = content.slice(fmMatch[0].length);
    }
    return { title, body };
  }

  queueSave(path, title, body) {
    if (this.saveStatus) this.saveStatus.setText("Saving…");
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
    this._saveTimer = window.setTimeout(async () => {
      await this.saveEpisode(path, title, body);
    }, 350);
  }

  async saveEpisode(path, title, body) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const existing = await this.app.vault.read(file);
    const fmMatch = existing.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
    const safeTitle = (title || "").replace(/\r?\n/g, " ").trim() || "Untitled";
    let frontmatter;
    let remainder;
    if (fmMatch) {
      let fm = fmMatch[1];
      const titleLine = `episodeTitle: ${JSON.stringify(safeTitle)}`;
      if (/^episodeTitle\s*:/mi.test(fm)) fm = fm.replace(/^episodeTitle\s*:.*$/mi, titleLine);
      else fm += `\nepisodeTitle: ${JSON.stringify(safeTitle)}`;
      frontmatter = `---\n${fm}\n---\n\n`;
      remainder = String(body || "").replace(/^\s+|\s+$/g, "");
    } else {
      frontmatter = `---\nepisodeTitle: ${JSON.stringify(safeTitle)}\n---\n\n`;
      remainder = String(body || existing).replace(/^\s+|\s+$/g, "");
    }
    await this.app.vault.modify(file, frontmatter + (remainder ? remainder + "\n" : ""));
    if (this.saveStatus) this.saveStatus.setText("Saved");
  }

  async flushSave() {
    if (this._saveTimer) {
      window.clearTimeout(this._saveTimer);
      this._saveTimer = null;
      if (this.currentPath) {
        const titleInput = this.contentEl.querySelector(".es-title-input");
        if (this.mode === "edit" && this.panelState) await this.saveEpisode(this.currentPath, titleInput ? titleInput.value : "Untitled", this.panelBody());
      }
    }
  }
}

module.exports = class EpisodeStudioPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({ folder: DEFAULT_FOLDER }, await this.loadData());
    this.registerView(VIEW_TYPE, leaf => new EpisodeStudioView(leaf, this));
    this.addRibbonIcon("book-open", "Open Episode Studio", () => this.activateView());
    this.addCommand({
      id: "open-episode-studio",
      name: "Open Episode Studio",
      callback: () => this.activateView()
    });
    this.addSettingTab(new EpisodeStudioSettingTab(this.app, this));
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  folderPath() { return normalizePath(this.settings.folder || DEFAULT_FOLDER); }

  async ensureFolder() {
    const folder = this.folderPath();
    const existing = this.app.vault.getAbstractFileByPath(folder);
    if (!existing) await this.app.vault.createFolder(folder);
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
};

class EpisodeStudioSettingTab extends require("obsidian").PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Episode Studio" });
    containerEl.createEl("p", { text: "Episodes are saved as Markdown files in this folder." });
    new (require("obsidian").Setting)(containerEl)
      .setName("Episodes folder")
      .setDesc("Vault folder used to store episode files. Default: Episodes")
      .addText(text => text
        .setPlaceholder("Episodes")
        .setValue(this.plugin.settings.folder || DEFAULT_FOLDER)
        .onChange(async value => {
          const folder = value.trim() || DEFAULT_FOLDER;
          this.plugin.settings.folder = folder;
          await this.plugin.saveData(this.plugin.settings);
        }));
  }
}
