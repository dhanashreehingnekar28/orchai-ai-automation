import type { ReactNode } from 'react';

function inline(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const token = /(`[^`]+`|\*\*[^*]+\*\*|(?<!\*)\*[^*]+\*(?!\*)|__[^_]+__|_[^_]+_)/g;
  let cursor = 0;
  for (const match of text.matchAll(token)) {
    const value = match[0];
    const start = match.index ?? 0;
    if (start > cursor) parts.push(text.slice(cursor, start));
    const delimiterLength = value.startsWith('`') || value.startsWith('*') && !value.startsWith('**') || value.startsWith('_') && !value.startsWith('__') ? 1 : 2;
    const content = value.slice(delimiterLength, -delimiterLength);
    const node = value.startsWith('`') ? <code key={`${keyPrefix}-${start}`}>{content}</code>
      : value.startsWith('**') || value.startsWith('__') ? <strong key={`${keyPrefix}-${start}`}>{content}</strong>
        : <em key={`${keyPrefix}-${start}`}>{content}</em>;
    parts.push(node);
    cursor = start + value.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

const isTableRow = (line: string) => line.trim().startsWith('|') && line.trim().endsWith('|');
const isTableDivider = (line: string) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());

/** Small safe Markdown renderer for model text. Raw HTML remains inert text. */
export function MarkdownContent({ content }: { content: string }) {
  const lines = content.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line.trim())) {
      const code: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(<pre key={`code-${i}`}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const children = inline(heading[2], `h-${i}`);
      const key = `h-${i++}`;
      blocks.push(level === 1 ? <h1 key={key}>{children}</h1> : level === 2 ? <h2 key={key}>{children}</h2> : <h3 key={key}>{children}</h3>);
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const rows = [line]; i += 2;
      while (i < lines.length && isTableRow(lines[i])) rows.push(lines[i++]);
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
      const header = cells(rows[0]);
      blocks.push(<div className="markdown-table-scroll" key={`table-${i}`}><table><thead><tr>{header.map((cell, index) => <th key={index}>{inline(cell, `th-${i}-${index}`)}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, rowIndex) => <tr key={rowIndex}>{cells(row).map((cell, index) => <td key={index}>{inline(cell, `td-${i}-${rowIndex}-${index}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const listMatch = line.match(/^\s{0,3}([-*+] |\d+[.)] )/);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]);
      const items: string[] = [];
      while (i < lines.length && /^\s{0,3}([-*+] |\d+[.)] )/.test(lines[i])) items.push(lines[i++].replace(/^\s{0,3}([-*+] |\d+[.)] )/, ''));
      const children = items.map((item, index) => <li key={index}>{inline(item, `li-${i}-${index}`)}</li>);
      blocks.push(ordered ? <ol key={`list-${i}`}>{children}</ol> : <ul key={`list-${i}`}>{children}</ul>);
      continue;
    }
    const paragraph = [line.trim()]; i++;
    while (i < lines.length && lines[i].trim() && !/^```|^\s{0,3}#{1,6}\s|^\s{0,3}([-*+] |\d+[.)] )/.test(lines[i]) && !(isTableRow(lines[i]) && i + 1 < lines.length && isTableDivider(lines[i + 1]))) paragraph.push(lines[i++].trim());
    blocks.push(<p key={`p-${i}`}>{inline(paragraph.join(' '), `p-${i}`)}</p>);
  }
  return <div className="markdown-content">{blocks}</div>;
}
