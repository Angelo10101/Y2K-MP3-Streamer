// Lenient XML reader for WMS files. WMP accepts sloppy markup (unquoted attributes,
// mixed-case names, stray ampersands), which strict DOMParser rejects.

export interface WmsNode {
  tag: string; // lower-cased
  attrs: Record<string, string>; // lower-cased names
  children: WmsNode[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

export function parseXml(src: string): WmsNode {
  src = src.replace(/^﻿/, "");
  const root: WmsNode = { tag: "#root", attrs: {}, children: [] };
  const stack: WmsNode[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src[lt + 1] === "?" || src[lt + 1] === "!") {
      const end = src.indexOf(">", lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    // find end of tag, honouring quotes
    let j = lt + 1;
    let q = "";
    while (j < src.length) {
      const c = src[j];
      if (q) { if (c === q) q = ""; }
      else if (c === '"' || c === "'") q = c;
      else if (c === ">") break;
      j++;
    }
    const body = src.slice(lt + 1, j);
    i = j + 1;
    if (body[0] === "/") {
      const name = body.slice(1).trim().toLowerCase();
      // pop to the matching open tag (tolerates unclosed children)
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) { stack.length = k; break; }
      }
      continue;
    }
    const selfClose = body.endsWith("/");
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(selfClose ? body.slice(0, -1) : body);
    if (!m) continue;
    const node: WmsNode = { tag: m[1].toLowerCase(), attrs: {}, children: [] };
    for (const a of m[2].matchAll(ATTR_RE)) {
      node.attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
    }
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

export function findAll(n: WmsNode, tag: string, out: WmsNode[] = []): WmsNode[] {
  for (const c of n.children) {
    if (c.tag === tag) out.push(c);
    findAll(c, tag, out);
  }
  return out;
}
