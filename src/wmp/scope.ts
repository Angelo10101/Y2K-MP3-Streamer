// Runs skin JScript (theme script files and inline `jscript:` handlers) against the
// WMP object model. Skin scripts are untrusted: only a small allow-list of JS globals
// is exposed. This is best-effort, NOT a security boundary; only use skins you trust.

const ALLOWED_GLOBALS = [
  "Math", "Date", "String", "Number", "Boolean", "Array", "Object", "RegExp", "Error",
  "JSON", "parseInt", "parseFloat", "isNaN", "isFinite", "escape", "unescape", "undefined",
  "NaN", "Infinity", "encodeURIComponent", "decodeURIComponent", "console",
];

export class Scope {
  readonly store: Record<string, unknown> = Object.create(null);
  private timers = new Set<number>();

  constructor() {
    this.store.setTimeout = (f: unknown, ms: number) => {
      const id = window.setTimeout(() => { this.timers.delete(id); this.callAny(f); }, ms);
      this.timers.add(id);
      return id;
    };
    this.store.clearTimeout = (id: number) => { window.clearTimeout(id); this.timers.delete(id); };
  }

  /**
   * Every identifier resolves against the skin's store, so unknown names read as
   * `undefined` and assignments never leak onto `window`. Names in `local` (functions
   * declared by the script itself) fall through to the real function scope instead.
   */
  private makeProxy(local: Set<string> = new Set()): object {
    return new Proxy(this.store, {
      has: (_t, k) => typeof k === "string" && k !== "__s" && k !== "__v" && !local.has(k),
      get: (t, k) => {
        if (typeof k !== "string") return undefined;
        if (k in t) return t[k];
        if (ALLOWED_GLOBALS.includes(k)) return (window as unknown as Record<string, unknown>)[k];
        return undefined;
      },
      set: (t, k, v) => { if (typeof k === "string") t[k] = v; return true; },
    });
  }

  dispose() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }

  private callAny(f: unknown) {
    if (typeof f === "function") (f as () => void).call(undefined);
    else if (typeof f === "string") this.run(f);
  }

  /** Strips the `jscript:` prefix used by WMS attributes. */
  static clean(code: string): string {
    return code.replace(/^\s*jscript\s*:/i, "");
  }

  /** Runs statements (function declarations in a script file become globals). */
  run(code: string, label = "script"): unknown {
    code = Scope.clean(code);
    const decl = [...code.matchAll(/(?:^|[\s;{}])function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
    const export_ = decl.map((n) => `__s.${n}=${n}`).join(";");
    try {
      const f = new Function("__s", `with(__s){${code}\n;${export_}}`);
      return f(this.makeProxy(new Set(decl)));
    } catch (e) {
      console.warn(`[skin ${label}] ${e}`);
      return undefined;
    }
  }

  eval(expr: string): unknown {
    try {
      return new Function("__s", `with(__s){return (${Scope.clean(expr)})}`)(this.makeProxy());
    } catch {
      return undefined;
    }
  }

  assign(expr: string, value: unknown) {
    try {
      new Function("__s", "__v", `with(__s){${Scope.clean(expr)} = __v}`)(this.makeProxy(), value);
    } catch (e) {
      console.warn("[skin assign]", expr, e);
    }
  }

  /** Calls a global script function if the skin defined one. */
  call(name: string, ...args: unknown[]) {
    const f = this.store[name];
    if (typeof f === "function") {
      try { (f as (...a: unknown[]) => void)(...args); } catch (e) { console.warn(`[skin ${name}] ${e}`); }
    }
  }
}
