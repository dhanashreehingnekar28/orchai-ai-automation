import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from './MarkdownContent';

describe('MarkdownContent', () => {
  it('renders common Markdown and keeps raw HTML inert', () => {
    const html = renderToStaticMarkup(<MarkdownContent content={'## Heading\n\n**Important** and `code`\n\n- one\n- two\n\n|A|B|\n|---|---|\n|x|y|\n\n<script>alert(1)</script>'} />);
    expect(html).toContain('<h2>Heading</h2>');
    expect(html).toContain('<strong>Important</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<table>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
