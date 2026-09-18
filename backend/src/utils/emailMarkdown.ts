/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Markdown to email HTML.
 *
 * Mail clients strip stylesheets and scripts, so every element carries its
 * own inline style and the subset is the one a model reply actually uses:
 * headings, paragraphs, bulleted and numbered lists, blockquotes, fenced and
 * inline code, emphasis, links and rules. Everything is escaped before any
 * markup is added, links must be http(s), and no raw HTML passes through.
 */

export interface EmailMarkdownTheme {
  text: string;
  muted: string;
  accent: string;
  border: string;
  codeBackground: string;
  fontBody: string;
  fontMono: string;
}

export const DEFAULT_EMAIL_MARKDOWN_THEME: EmailMarkdownTheme = {
  text: '#0a0a0b',
  muted: '#67635d',
  accent: '#bd4225',
  border: 'rgba(10, 10, 11, 0.14)',
  codeBackground: '#e9e5dd',
  fontBody:
    "'Manrope', 'Space Grotesk', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  fontMono: "'DM Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
};

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const SAFE_LINK = /^https?:\/\/[^\s<>"']+$/i;

const inline = (escaped: string, theme: EmailMarkdownTheme): string => {
  // Code spans first so their contents are never emphasized or linked.
  const codes: string[] = [];
  let out = escaped.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codes.push(
      `<code style="font-family:${theme.fontMono};font-size:0.92em;background:${theme.codeBackground};border-radius:4px;padding:1px 5px">${code}</code>`
    );
    return `\uE000${codes.length - 1}\uE001`;
  });
  out = out.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (match, label: string, href: string) =>
      SAFE_LINK.test(href)
        ? `<a href="${href}" style="color:${theme.accent};text-decoration:underline">${label}</a>`
        : match
  );
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  return out.replace(
    /\uE000(\d+)\uE001/g,
    (_match, index: string) => codes[Number(index)] ?? ''
  );
};

interface ListFrame {
  ordered: boolean;
  indent: number;
  items: string[];
  open: boolean;
}

/** Renders Markdown to self-styled HTML for a mail body. */
export const renderMarkdownForEmail = (
  markdown: string,
  theme: EmailMarkdownTheme = DEFAULT_EMAIL_MARKDOWN_THEME
): string => {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  const paragraph: string[] = [];
  const lists: ListFrame[] = [];
  let quote: string[] = [];
  let code: string[] | null = null;
  let codeLanguage = '';

  const p = `margin:0 0 12px;line-height:1.55;font-family:${theme.fontBody};color:${theme.text}`;
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(
      `<p style="${p}">${inline(escapeHtml(paragraph.join(' ')), theme)}</p>`
    );
    paragraph.length = 0;
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    html.push(
      `<blockquote style="margin:0 0 12px;padding:4px 14px;border-left:3px solid ${theme.accent};color:${theme.muted};font-family:${theme.fontBody};line-height:1.55">${inline(escapeHtml(quote.join(' ')), theme)}</blockquote>`
    );
    quote = [];
  };
  const closeList = (frame: ListFrame): string => {
    const tag = frame.ordered ? 'ol' : 'ul';
    const items = frame.items
      .map(
        item =>
          `<li style="margin:0 0 6px;line-height:1.55;font-family:${theme.fontBody};color:${theme.text}">${item}</li>`
      )
      .join('');
    return `<${tag} style="margin:0 0 12px;padding-left:22px">${items}</${tag}>`;
  };
  const closeListsTo = (indent: number) => {
    while (lists.length > 0 && lists[lists.length - 1].indent >= indent) {
      const frame = lists.pop()!;
      const rendered = closeList(frame);
      const parent = lists[lists.length - 1];
      if (parent && parent.items.length > 0) {
        parent.items[parent.items.length - 1] += rendered;
      } else {
        html.push(rendered);
      }
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushQuote();
    closeListsTo(-1);
  };

  for (const raw of lines) {
    if (code) {
      if (/^\s*```/.test(raw)) {
        html.push(
          `<pre style="margin:0 0 12px;padding:12px 14px;border-radius:8px;background:${theme.codeBackground};font-family:${theme.fontMono};font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word"${codeLanguage ? ` data-language="${escapeHtml(codeLanguage)}"` : ''}>${escapeHtml(code.join('\n'))}</pre>`
        );
        code = null;
        codeLanguage = '';
      } else {
        code.push(raw);
      }
      continue;
    }
    const fence = raw.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      flushAll();
      code = [];
      codeLanguage = fence[1] ?? '';
      continue;
    }
    if (raw.trim() === '') {
      flushParagraph();
      flushQuote();
      continue;
    }
    const heading = raw.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length, 6);
      const size = [22, 19, 17, 15, 14, 13][level - 1];
      html.push(
        `<h${level} style="margin:${level <= 2 ? '22px' : '18px'} 0 8px;font-size:${size}px;line-height:1.3;font-weight:700;font-family:${theme.fontBody};color:${theme.text}">${inline(escapeHtml(heading[2]), theme)}</h${level}>`
      );
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      flushAll();
      html.push(
        `<hr style="border:0;border-top:1px solid ${theme.border};margin:18px 0">`
      );
      continue;
    }
    const quoted = raw.match(/^\s{0,3}>\s?(.*)$/);
    if (quoted) {
      flushParagraph();
      closeListsTo(-1);
      quote.push(quoted[1]);
      continue;
    }
    const item = raw.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.+)$/);
    if (item) {
      flushParagraph();
      flushQuote();
      const indent = item[1].replace(/\t/g, '  ').length;
      const ordered = /\d/.test(item[2]);
      const top = lists[lists.length - 1];
      if (!top || indent > top.indent) {
        lists.push({ ordered, indent, items: [], open: true });
      } else if (indent < top.indent) {
        closeListsTo(indent + 1);
        if (lists.length === 0 || lists[lists.length - 1].indent !== indent) {
          lists.push({ ordered, indent, items: [], open: true });
        }
      } else if (top.ordered !== ordered) {
        closeListsTo(indent);
        lists.push({ ordered, indent, items: [], open: true });
      }
      lists[lists.length - 1].items.push(inline(escapeHtml(item[3]), theme));
      continue;
    }
    if (lists.length > 0 && /^\s{2,}\S/.test(raw)) {
      // A wrapped continuation of the current list item.
      const frame = lists[lists.length - 1];
      frame.items[frame.items.length - 1] +=
        ` ${inline(escapeHtml(raw.trim()), theme)}`;
      continue;
    }
    if (quote.length > 0) {
      quote.push(raw.trim());
      continue;
    }
    closeListsTo(-1);
    paragraph.push(raw.trim());
  }
  if (code) {
    html.push(
      `<pre style="margin:0 0 12px;padding:12px 14px;border-radius:8px;background:${theme.codeBackground};font-family:${theme.fontMono};font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word">${escapeHtml(code.join('\n'))}</pre>`
    );
  }
  flushAll();
  return html.join('');
};
