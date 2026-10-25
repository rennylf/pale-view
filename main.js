'use strict';

/*
 * Pale View（淡景）—— 把笔记素材摊成画布。
 */

const { Plugin, Modal, Notice, PluginSettingTab, Setting, normalizePath } = require('obsidian');

// ======================================================================
// 一、微信读书笔记解析
// ======================================================================

/**
 * 微信读书「一键复制」笔记解析器
 *
 * 输入示例：
 *   《书名》
 *
 *   作者
 *   42个笔记
 *
 *   1.1 导语
 *
 *   ◆ 2026/10/23发表想法
 *
 *   想法文字……
 *
 *   原文：划线原文……
 *
 *   ◆ 只有划线的笔记
 *
 * 输出：{ book, notes: [{ chapter, date, thought, quote }] }
 * 章节名称被丢弃，只保留章节号。
 */

const BULLET_RE = /^[◆•▪]\s*/;
const DATE_RE = /^(\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2})/;
const NOISE_RE = /^(?:-{2,}\s*)?(?:来自微信读书|本书由.*提供)\s*$/;
const MAX_HEADER_LEN = 40;

function matchSection(line) {
  if (!line || line.length > MAX_HEADER_LEN) return null;
  let m;
  if ((m = /^(\d+(?:\.\d+)*)[\s　]+(\S.*)$/.exec(line))) return m[1];
  if ((m = /^(\d+(?:\.\d+)+)(\S.*)$/.exec(line))) return m[1];
  if ((m = /^(\d+(?:\.\d+)+)$/.exec(line))) return m[1];
  return null;
}

function tidy(text) {
  return String(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseBlock(raw, chapter) {
  let lines = String(raw)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !NOISE_RE.test(line));

  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (!lines.length) return null;

  // 「2026/10/23发表想法」这类时间标记行
  let date = '';
  const dm = DATE_RE.exec(lines[0]);
  if (dm && /想法|评论|笔记/.test(lines[0])) {
    date = dm[1];
    lines.shift();
    while (lines.length && !lines[0]) lines.shift();
  }

  let quote = '';
  let thought = '';
  const qi = lines.findIndex((line) => /^原文\s*[：:]/.test(line));
  if (qi >= 0) {
    const head = lines[qi].replace(/^原文\s*[：:]\s*/, '');
    quote = [head, ...lines.slice(qi + 1)].join('\n');
    thought = lines.slice(0, qi).join('\n');
  } else if (date) {
    // 有「发表想法」时间戳但没跟原文：整条都是自己的想法
    thought = lines.join('\n');
  } else {
    quote = lines.join('\n');
  }

  return { chapter: chapter || '', date, thought: tidy(thought), quote: tidy(quote) };
}

function parseWeReadText(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const notes = [];
  const preamble = [];
  let book = '';
  let chapter = '';
  let cur = null;
  let sawContent = false;

  const flush = () => {
    if (!cur) return;
    const note = parseBlock(cur.lines.join('\n'), cur.chapter);
    if (note && (note.quote || note.thought)) notes.push(note);
    cur = null;
  };

  for (const original of lines) {
    const line = original.trim();

    if (BULLET_RE.test(line)) {
      flush();
      sawContent = true;
      cur = { chapter, lines: [line.replace(BULLET_RE, '')] };
      continue;
    }

    const sectionNo = matchSection(line);
    if (sectionNo) {
      flush();
      sawContent = true;
      chapter = sectionNo;
      continue;
    }

    if (cur) cur.lines.push(original);
    else if (!sawContent) preamble.push(line);
  }
  flush();

  for (const line of preamble) {
    const m = /^《(.+)》\s*$/.exec(line);
    if (m && !book) book = m[1].trim();
  }

  return { book, notes };
}

// ---------------------------------------------------------------- 卡片渲染

function buildCardText(note) {
  const parts = [];
  const head = [];
  if (note.chapter) head.push('**' + note.chapter + '**');
  if (note.date) head.push(note.date);
  if (head.length) parts.push(head.join(' · '));

  if (note.quote) {
    if (parts.length) parts.push('');
    parts.push(
      note.quote
        .split('\n')
        .map((line) => (line ? '> ' + line : '>'))
        .join('\n')
    );
  }

  if (note.thought) {
    if (parts.length) parts.push('');
    parts.push('想法：' + note.thought);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------- 布局计算

function isWide(ch) {
  const c = ch.codePointAt(0);
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6)
  );
}

function estimateHeight(text, width) {
  const usable = Math.max(140, width - 36);
  const lineHeight = 24;
  let lines = 0;
  for (const para of String(text).split('\n')) {
    if (!para.trim()) {
      lines += 1;
      continue;
    }
    let w = 0;
    for (const ch of para) w += isWide(ch) ? 16 : 8.4;
    lines += Math.max(1, Math.ceil(w / usable));
  }
  return Math.max(110, Math.round(lines * lineHeight + 40));
}

function layoutNodes(nodes, opts) {
  const columns = Math.max(1, Math.floor(Number(opts.columns) || 3));
  const width = Number(opts.cardWidth) || 340;
  const gapX = Number.isFinite(opts.gapX) ? opts.gapX : 60;
  const gapY = Number.isFinite(opts.gapY) ? opts.gapY : 48;

  let rowY = 0;
  let rowH = 0;
  nodes.forEach((node, i) => {
    const col = i % columns;
    if (col === 0) {
      if (i > 0) rowY += rowH + gapY;
      rowH = 0;
    }
    node.width = width;
    node.x = col * (width + gapX);
    node.y = rowY;
    rowH = Math.max(rowH, node.height || 0);
  });
  return nodes;
}

// ---------------------------------------------------------------- Canvas

function randomId() {
  const chars = '0123456789abcdef';
  let id = '';
  for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * 16)];
  return id;
}

/**
 * 生成 Obsidian Canvas 数据。
 * opts: { columns, cardWidth, gapX, gapY, colorThoughts, thoughtColor }
 */
function buildCanvas(notes, opts) {
  const options = opts || {};
  const width = Number(options.cardWidth) || 340;

  const nodes = notes.map((note) => {
    const text = buildCardText(note);
    const node = {
      id: randomId(),
      type: 'text',
      text,
      x: 0,
      y: 0,
      width,
      height: estimateHeight(text, width),
    };
    if (options.colorThoughts && note.thought) node.color = options.thoughtColor || '3';
    return node;
  });

  layoutNodes(nodes, {
    columns: options.columns,
    cardWidth: width,
    gapX: Number(options.gapX),
    gapY: Number(options.gapY),
  });

  return { nodes, edges: [] };
}

// ======================================================================
// 二、插件主体
// ======================================================================


const DEFAULT_SETTINGS = {
  columns: 3,
  cardWidth: 340,
  gapX: 60,
  gapY: 48,
  colorThoughts: true,
  thoughtColor: '3',
  folder: '',
};

const THOUGHT_COLORS = [
  ['1', '红'],
  ['2', '橙'],
  ['3', '黄'],
  ['4', '绿'],
  ['5', '青'],
  ['6', '紫'],
];

function safeFileName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

class PaleViewPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: 'weread-new-canvas-clipboard',
      name: 'WeRead: new canvas from clipboard',
      callback: () => this.importFromClipboard(),
    });

    this.addCommand({
      id: 'weread-new-canvas-paste',
      name: 'WeRead: new canvas from pasted text',
      callback: () => new PasteModal(this.app, this, '').open(),
    });

    this.addSettingTab(new WereadSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async importFromClipboard() {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      /* 剪贴板不可用，退回手动粘贴 */
    }
    if (!text || text.indexOf('◆') === -1) {
      new PasteModal(this.app, this, text || '').open();
      return;
    }
    await this.importText(text);
  }

  async importText(text) {
    let parsed;
    try {
      parsed = parseWeReadText(text);
    } catch (err) {
      new Notice('解析失败：' + err.message);
      return null;
    }

    const notes = parsed.notes.filter((n) => n.quote || n.thought);
    if (!notes.length) {
      new Notice('没有解析到笔记，请确认粘贴的是微信读书「一键复制」的内容');
      return null;
    }

    const folder = await this.resolveFolder();
    const base = safeFileName(parsed.book ? parsed.book + ' 阅读笔记' : '微信读书 阅读笔记');
    const path = await this.uniquePath(folder, base || '微信读书 阅读笔记');

    let file;
    try {
      file = await this.app.vault.create(
        path,
        JSON.stringify(buildCanvas(notes, this.settings), null, '\t')
      );
    } catch (err) {
      new Notice('创建画布失败：' + err.message);
      return null;
    }

    try {
      await this.app.workspace.getLeaf(true).openFile(file);
    } catch (err) {
      this.app.workspace.openLinkText(file.path, '', false);
    }

    new Notice(`已生成画布：${notes.length} 张卡片`);
    return file;
  }

  async resolveFolder() {
    const custom = String(this.settings.folder || '')
      .trim()
      .replace(/^\/+|\/+$/g, '');
    if (!custom) {
      const active = this.app.workspace.getActiveFile();
      return active ? active.parent.path : '';
    }

    const target = normalizePath(custom);
    if (!this.app.vault.getAbstractFileByPath(target)) {
      let cur = '';
      for (const part of target.split('/')) {
        cur = cur ? cur + '/' + part : part;
        if (!this.app.vault.getAbstractFileByPath(cur)) {
          try {
            await this.app.vault.createFolder(cur);
          } catch (err) {
            /* 已存在或并发创建，忽略 */
          }
        }
      }
    }
    return target;
  }

  async uniquePath(folder, base) {
    const join = (name) => normalizePath(folder ? folder + '/' + name : name);
    let path = join(base + '.canvas');
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = join(base + ' ' + i + '.canvas');
      i += 1;
    }
    return path;
  }
}

class PasteModal extends Modal {
  constructor(app, plugin, initialText) {
    super(app);
    this.plugin = plugin;
    this.initialText = initialText || '';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('weread-canvas-modal');

    contentEl.createEl('h3', { text: 'WeRead 笔记 → 画布' });
    contentEl.createEl('p', {
      text: '把微信读书里「一键复制」的笔记粘贴进来，每条笔记会拆成一张卡片，保留原文、想法、章节号与时间。',
      cls: 'setting-item-description',
    });

    const textarea = contentEl.createEl('textarea', {
      attr: {
        placeholder: '《书名》\n\n1.1 章节\n\n◆ 2026/10/23发表想法\n\n想法……\n\n原文：划线原文……',
        spellcheck: 'false',
      },
    });
    textarea.value = this.initialText;
    textarea.focus();

    const bar = contentEl.createDiv({ cls: 'weread-canvas-actions' });

    const pasteBtn = bar.createEl('button', { text: '读取剪贴板' });
    pasteBtn.onclick = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) textarea.value = text;
        else new Notice('剪贴板是空的');
      } catch (err) {
        new Notice('无法读取剪贴板，请手动粘贴');
      }
    };

    const submit = bar.createEl('button', { text: '创建画布', cls: 'mod-cta' });
    submit.onclick = async () => {
      const text = textarea.value.trim();
      if (!text) {
        new Notice('请先粘贴笔记内容');
        return;
      }
      this.close();
      await this.plugin.importText(text);
    };

    textarea.addEventListener('keydown', (evt) => {
      if ((evt.metaKey || evt.ctrlKey) && evt.key === 'Enter') {
        evt.preventDefault();
        submit.click();
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class WereadSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('每行卡片数')
      .setDesc('画布中卡片横向排列的列数。')
      .addSlider((slider) =>
        slider
          .setLimits(1, 8, 1)
          .setValue(this.plugin.settings.columns)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.columns = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('卡片宽度')
      .setDesc('单位像素，默认 340。')
      .addSlider((slider) =>
        slider
          .setLimits(240, 600, 20)
          .setValue(this.plugin.settings.cardWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.cardWidth = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('给带想法的卡片上色')
      .setDesc('只有划线、没有想法的卡片保持默认颜色。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.colorThoughts).onChange(async (value) => {
          this.plugin.settings.colorThoughts = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('想法卡片颜色')
      .addDropdown((dropdown) => {
        for (const [value, label] of THOUGHT_COLORS) dropdown.addOption(value, label);
        dropdown.setValue(this.plugin.settings.thoughtColor).onChange(async (value) => {
          this.plugin.settings.thoughtColor = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('保存文件夹')
      .setDesc('相对仓库根目录，留空表示放在当前笔记所在文件夹。')
      .addText((text) =>
        text
          .setPlaceholder('例如：阅读笔记/画布')
          .setValue(this.plugin.settings.folder)
          .onChange(async (value) => {
            this.plugin.settings.folder = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}

module.exports = PaleViewPlugin;
module.exports.parseWeReadText = parseWeReadText;
module.exports.buildCardText = buildCardText;
module.exports.buildCanvas = buildCanvas;
module.exports.estimateHeight = estimateHeight;
