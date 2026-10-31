import { createElement, type ReactNode } from "react";

// Just enough markdown for Bart's notes: headings, paragraphs, quote blocks, lists, rules, code, emphasis,
// links and photos. It builds React elements (never HTML strings), so note text can't inject markup.
// Photos are `![alt](captures/<path>)` links into the private bucket; `images` maps each to a signed URL.
// Line breaks inside a paragraph are kept, as in Obsidian, since quotes are transcribed line by line.

type Images = Record<string, string>;

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const BULLET = /^\s{0,3}[-*+]\s+/;
const NUMBERED = /^\s{0,3}\d{1,9}[.)]\s+/;
const FENCE = /^\s{0,3}(```|~~~)/;
const URL_PART = String.raw`\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)`;
const IMAGE_LINE = new RegExp(String.raw`^\s*!\[([^\]]*)\]${URL_PART}\s*$`);
const INLINE = new RegExp(
  [
    "`([^`]+)`", // 1 code
    String.raw`!\[([^\]]*)\]${URL_PART}`, // 2 alt, 3 src
    String.raw`\[([^\]]+)\]${URL_PART}`, // 4 text, 5 href
    String.raw`\*\*(.+?)\*\*`, // 6 strong
    String.raw`__(.+?)__`, // 7 strong
    String.raw`\*(?!\s)(.+?)\*`, // 8 em
    String.raw`(?<![\p{L}\p{N}])_(?!\s)(.+?)_(?![\p{L}\p{N}])`, // 9 em
  ].join("|"),
  "gu",
);

export function Markdown({ source, images }: { source: string; images: Images }) {
  if (!source.trim()) return <p className="md-empty">This note is empty.</p>;
  return <div className="md">{blocks(source.replace(/\r\n?/g, "\n").split("\n"), images, "b")}</div>;
}

const startsBlock = (l: string) =>
  HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || BULLET.test(l) || NUMBERED.test(l) || FENCE.test(l) || IMAGE_LINE.test(l);

function blocks(lines: string[], images: Images, prefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `${prefix}-${i}`;
    let m: RegExpExecArray | null;
    if (!line.trim()) {
      i++;
    } else if ((m = FENCE.exec(line))) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(m[1]); i++) body.push(lines[i]);
      i++;
      out.push(
        <pre key={key}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
    } else if ((m = HEADING.exec(line))) {
      out.push(createElement(`h${m[1].length}`, { key }, inline(m[2], images, key)));
      i++;
    } else if (RULE.test(line)) {
      out.push(<hr key={key} />);
      i++;
    } else if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ""));
      out.push(<blockquote key={key}>{blocks(body, images, key)}</blockquote>);
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      const marker = BULLET.test(line) ? BULLET : NUMBERED;
      const items: string[][] = [];
      while (i < lines.length && lines[i].trim()) {
        if (marker.test(lines[i])) items.push([lines[i].replace(marker, "")]);
        else if (startsBlock(lines[i])) break;
        else items[items.length - 1].push(lines[i].trim());
        i++;
      }
      const List = marker === BULLET ? "ul" : "ol";
      out.push(
        <List key={key}>
          {items.map((item, j) => (
            <li key={j}>{withBreaks(item, images, `${key}-${j}`)}</li>
          ))}
        </List>,
      );
    } else if ((m = IMAGE_LINE.exec(line))) {
      out.push(
        <p key={key} className="md-photo">
          {image(m[2], m[1], images, key)}
        </p>,
      );
      i++;
    } else {
      const para = [line];
      for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines[i]); i++) para.push(lines[i]);
      out.push(<p key={key}>{withBreaks(para, images, key)}</p>);
    }
  }
  return out;
}

function withBreaks(lines: string[], images: Images, key: string): ReactNode[] {
  return lines.flatMap((l, j) => (j ? [<br key={`${key}-br${j}`} />, ...inline(l, images, `${key}-${j}`)] : inline(l, images, `${key}-${j}`)));
}

function inline(text: string, images: Images, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-i${n++}`;
    if (m[1] != null) out.push(<code key={k}>{m[1]}</code>);
    else if (m[3] != null) out.push(image(m[3], m[2], images, k));
    else if (m[5] != null) out.push(link(m[5], inline(m[4], images, k), k));
    else if (m[6] != null || m[7] != null) out.push(<strong key={k}>{inline(m[6] ?? m[7], images, k)}</strong>);
    else out.push(<em key={k}>{inline(m[8] ?? m[9], images, k)}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function image(src: string, alt: string, images: Images, key: string): ReactNode {
  const url = src.startsWith("captures/") ? images[src] : /^https?:\/\//i.test(src) ? src : undefined;
  if (!url) {
    return (
      <span key={key} className="md-missing">
        photo unavailable{alt ? ` · ${alt}` : ""}
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- signed Storage URLs; next/image would need the host configured
  return <img key={key} src={url} alt={alt} loading="lazy" />;
}

function link(href: string, children: ReactNode[], key: string): ReactNode {
  if (!/^(https?:|mailto:)/i.test(href)) return <span key={key}>{children}</span>;
  return (
    <a key={key} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}
