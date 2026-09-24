/**
 * A small, safe markdown renderer for model-written text (narration, actions,
 * thoughts, options, summaries, chat replies). Models format even when asked
 * not to, and players were reading raw **asterisks**.
 *
 * SAFETY: localStorage holds bearer session tokens, so model or user text must
 * never reach innerHTML. Everything here is built with createElement and
 * text nodes; a `<script>` in the input is rendered as the literal characters.
 *
 * Supported: **bold** / __bold__, *italic* / _italic_, `code`, paragraphs
 * (blank lines), line breaks, "- " / "* " / "+ " bullet lists, "1. " / "1) "
 * numbered lists, and "# Heading" lines (rendered as a bold line). Anything
 * else is plain text.
 */

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'h'; text: string };

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) blocks.push({ kind: 'p', lines: para });
    para = [];
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') { flush(); continue; }
    const heading = line.match(HEADING);
    if (heading) { flush(); blocks.push({ kind: 'h', text: heading[1]! }); continue; }
    const bullet = line.match(BULLET);
    const numbered = bullet ? null : line.match(NUMBERED);
    if (bullet || numbered) {
      flush();
      const kind = bullet ? 'ul' : 'ol';
      const item = (bullet ?? numbered)![1]!;
      const last = blocks[blocks.length - 1];
      if (last && last.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

// code | bold (** or __) | italic (* or _, not inside a word for _)
const INLINE = /(`[^`\n]+`)|(\*\*(?=\S)[^\n]*?\S\*\*|__(?=\S)[^\n]*?\S__)|(\*(?=[^\s*])[^*\n]*?[^\s*]\*|\*[^\s*]\*|(?<![\p{L}\p{N}])_(?=[^\s_])[^_\n]*?[^\s_]_(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])_[^\s_]_(?![\p{L}\p{N}]))/u;

function appendInline(parent: Node, text: string): void {
  let rest = text;
  while (rest.length > 0) {
    const m = rest.match(INLINE);
    if (!m || m.index === undefined) {
      parent.appendChild(document.createTextNode(rest));
      return;
    }
    if (m.index > 0) parent.appendChild(document.createTextNode(rest.slice(0, m.index)));
    const token = m[0];
    if (m[1]) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    } else if (m[2]) {
      const strong = document.createElement('strong');
      appendInline(strong, token.slice(2, -2));
      parent.appendChild(strong);
    } else {
      const em = document.createElement('em');
      appendInline(em, token.slice(1, -1));
      parent.appendChild(em);
    }
    rest = rest.slice(m.index + token.length);
  }
}

function appendLines(parent: Node, lines: string[]): void {
  lines.forEach((line, i) => {
    if (i > 0) parent.appendChild(document.createElement('br'));
    appendInline(parent, line);
  });
}

/**
 * Render `text` into `parent`. A single plain paragraph goes straight into
 * the parent (no wrapper element), so one-line entries look and read exactly
 * as they did as plain text.
 */
export function appendMarkdown(parent: HTMLElement, text: string): void {
  const blocks = parseBlocks(text);
  if (blocks.length === 1 && blocks[0]!.kind === 'p') {
    appendLines(parent, blocks[0]!.lines);
    return;
  }
  for (const block of blocks) {
    if (block.kind === 'p') {
      const p = document.createElement('p');
      p.className = 'md-p';
      appendLines(p, block.lines);
      parent.appendChild(p);
    } else if (block.kind === 'h') {
      const p = document.createElement('p');
      p.className = 'md-p';
      const strong = document.createElement('strong');
      appendInline(strong, block.text);
      p.appendChild(strong);
      parent.appendChild(p);
    } else {
      const list = document.createElement(block.kind);
      list.className = 'md-list';
      for (const item of block.items) {
        const li = document.createElement('li');
        appendInline(li, item);
        list.appendChild(li);
      }
      parent.appendChild(list);
    }
  }
}

/** The same text with the formatting marks removed — for buttons and inputs, which hold plain text. */
export function stripMarkdown(text: string): string {
  const out: string[] = [];
  for (const block of parseBlocks(text)) {
    if (block.kind === 'p') out.push(block.lines.join(' '));
    else if (block.kind === 'h') out.push(block.text);
    else out.push(block.items.join('; '));
  }
  const holder = document.createElement('div');
  appendInline(holder, out.join(' '));
  return holder.textContent ?? '';
}
