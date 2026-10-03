import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const { renderMarkdownForEmail, escapeHtml } = await import(
  pathToFileURL(path.resolve('backend/dist/utils/emailMarkdown.js')).href
);

test('headings, emphasis, lists and links become styled email HTML', () => {
  const html = renderMarkdownForEmail(
    [
      '# AI News',
      '',
      '## Model releases',
      '- **Anthropic** published a piece (Sep 17). *Why it matters:* a lot.',
      '- Second item with `inline code` and a [link](https://example.test/a?b=1).',
      '  wrapped continuation',
      '',
      '1. first',
      '2. second',
      '',
      'Closing paragraph.',
    ].join('\n')
  );
  assert.match(html, /<h1 style="[^"]*font-size:22px[^"]*">AI News<\/h1>/);
  assert.match(html, /<h2 style="[^"]*">Model releases<\/h2>/);
  assert.match(
    html,
    /<ul style="[^"]*"><li style="[^"]*"><strong>Anthropic<\/strong> published/
  );
  assert.match(html, /<em>Why it matters:<\/em>/);
  assert.match(html, /<code style="[^"]*">inline code<\/code>/);
  assert.match(
    html,
    /<a href="https:\/\/example\.test\/a\?b=1" style="[^"]*">link<\/a>\. wrapped continuation<\/li>/
  );
  assert.match(
    html,
    /<ol style="[^"]*"><li style="[^"]*">first<\/li><li style="[^"]*">second<\/li><\/ol>/
  );
  assert.match(html, /<p style="[^"]*">Closing paragraph\.<\/p>$/);
  // No literal markdown markers survive.
  assert.doesNotMatch(html, /\*\*|^#|\[link\]/m);
});

test('raw HTML, scripts and unsafe links are neutralized', () => {
  const html = renderMarkdownForEmail(
    [
      '<script>alert(1)</script> & <img src=x onerror=alert(1)>',
      '',
      '[click](javascript:alert(1)) and [ok](http://example.test)',
      '',
      '`<b>not bold</b>`',
    ].join('\n')
  );
  assert.doesNotMatch(html, /<(script|img)\b/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &lt;img/);
  assert.match(html, /\[click\]\(javascript:alert\(1\)\)/);
  assert.match(html, /<a href="http:\/\/example\.test"/);
  assert.match(
    html,
    /<code style="[^"]*">&lt;b&gt;not bold&lt;\/b&gt;<\/code>/
  );
  assert.equal(
    escapeHtml('<a href="x">&</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;'
  );
});

test('code fences, blockquotes, rules and nested lists keep their structure', () => {
  const html = renderMarkdownForEmail(
    [
      '> quoted **line**',
      '> continues',
      '',
      '---',
      '',
      '```js',
      'const x = "<y>";',
      '',
      '  indented();',
      '```',
      '',
      '- parent',
      '  - child one',
      '  - child two',
      '- sibling',
    ].join('\n')
  );
  assert.match(
    html,
    /<blockquote style="[^"]*">quoted <strong>line<\/strong> continues<\/blockquote>/
  );
  assert.match(html, /<hr style="[^"]*">/);
  assert.match(
    html,
    /<pre style="[^"]*" data-language="js">const x = &quot;&lt;y&gt;&quot;;\n\n  indented\(\);<\/pre>/
  );
  assert.match(
    html,
    /<li style="[^"]*">parent<ul style="[^"]*"><li style="[^"]*">child one<\/li><li style="[^"]*">child two<\/li><\/ul><\/li><li style="[^"]*">sibling<\/li>/
  );
});

test('the branded notification email renders the run result as HTML and keeps the text alternative', async () => {
  const { renderNotificationEmail } = await import(
    pathToFileURL(path.resolve('backend/dist/services/emailService.js')).href
  );
  const email = renderNotificationEmail({
    heading: '"AI news digest" finished',
    lines: [],
    markdown: '## Funding\n- **OpenAI** raised (Sep 15).',
    appUrl: 'https://chat.example.test',
    href: '/work/task-1',
    linkLabel: 'Open the result',
  });
  assert.match(email.html, /https:\/\/librewebui\.org\/logo-dark\.png/);
  assert.match(email.html, /Libre WebUI<\/span>/);
  assert.match(email.html, /<h2 style="[^"]*">Funding<\/h2>/);
  assert.match(email.html, /<strong>OpenAI<\/strong> raised/);
  assert.match(email.html, /background:#bd4225/);
  assert.match(
    email.html,
    /<a href="https:\/\/chat\.example\.test\/work\/task-1" style="[^"]*">Open the result<\/a>/
  );
  assert.match(email.html, /Settings &gt; Notifications/);
  // The text part carries the raw Markdown and the link.
  assert.match(email.text, /## Funding\n- \*\*OpenAI\*\* raised/);
  assert.match(
    email.text,
    /Open the result: https:\/\/chat\.example\.test\/work\/task-1/
  );
});

test('light and dark notification presets style all Markdown and preserve safe text', async () => {
  const { renderNotificationEmail } = await import(
    pathToFileURL(path.resolve('backend/dist/services/emailService.js')).href
  );
  const input = {
    heading: '<Heading>',
    lines: ['Plain & text'],
    appUrl: 'https://chat.example.test',
    href: '/work/task',
    linkLabel: '<Open>',
    markdown:
      '# Heading\n\nParagraph [link](https://example.test).\n\n- list\n\n> quote\n\n`inline`\n\n```\n<script>\n```\n\n---',
  };
  const defaultEmail = renderNotificationEmail(input);
  assert.deepEqual(
    defaultEmail,
    renderNotificationEmail({ ...input, emailTheme: 'light' })
  );
  const dark = renderNotificationEmail({ ...input, emailTheme: 'dark' });
  assert.equal(dark.text, defaultEmail.text);
  assert.match(defaultEmail.html, /background:#f3f0ea/);
  assert.match(dark.html, /background:#161615/);
  assert.match(dark.html, /background:#242422/);
  assert.match(dark.html, /color:#c3bdb3/);
  assert.match(dark.html, /color:#ff9878/);
  for (const tag of ['h1', 'p', 'li', 'code', 'pre']) {
    assert.match(dark.html, new RegExp(`<${tag} style="[^"]*color:#f3f0ea`));
  }
  assert.match(dark.html, /background:#353530/);
  assert.match(dark.html, /border-top:1px solid #5a5751/);
  assert.match(dark.html, /name="supported-color-schemes" content="dark"/);
  assert.match(dark.html, /&lt;script&gt;/);
  assert.doesNotMatch(dark.html, /<script/i);
  assert.match(dark.html, /&lt;Open&gt;/);
});

test('dark preset foregrounds meet normal text contrast on their rendered backgrounds', async () => {
  const { renderNotificationEmail } = await import(
    pathToFileURL(path.resolve('backend/dist/services/emailService.js')).href
  );
  const { html } = renderNotificationEmail({
    emailTheme: 'dark',
    heading: 'Contrast',
    lines: ['Text'],
    markdown: '> Quote\n\n[Link](https://example.test)\n\n`code`',
    appUrl: 'https://chat.example.test',
    href: '/',
  });
  const luminance = hex => {
    const channels = hex.match(/[a-f0-9]{2}/gi).map(channel => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const contrast = (foreground, background) => {
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  for (const [foreground, background] of [
    ['#f3f0ea', '#242422'],
    ['#c3bdb3', '#242422'],
    ['#c3bdb3', '#161615'],
    ['#ff9878', '#242422'],
    ['#f3f0ea', '#353530'],
    ['#161615', '#ff9878'],
  ]) {
    assert.ok(html.includes(foreground) && html.includes(background));
    assert.ok(
      contrast(foreground, background) >= 4.5,
      `${foreground} on ${background}`
    );
  }
});
