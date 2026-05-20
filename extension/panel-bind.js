/**
 * CSP-safe event wiring for panel.html (no inline onclick/script).
 */
(function () {
  function splitArgs(inner) {
    const args = [];
    let cur = "";
    let q = null;
    let depth = 0;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (q) {
        cur += c;
        if (c === q && inner[i - 1] !== "\\") q = null;
        continue;
      }
      if (c === "'" || c === '"') {
        q = c;
        cur += c;
        continue;
      }
      if (c === "(") depth++;
      if (c === ")") depth--;
      if (c === "," && depth === 0) {
        args.push(cur.trim());
        cur = "";
        continue;
      }
      cur += c;
    }
    if (cur.trim()) args.push(cur.trim());
    return args;
  }

  function parseCall(code) {
    const m = code.trim().match(/^([A-Za-z_$][\w$]*)\s*\((.*)\)\s*;?\s*$/s);
    if (!m) return null;
    return { name: m[1], args: splitArgs(m[2]) };
  }

  function resolveArg(raw, el, ev) {
    const a = raw.trim();
    if (a === "this") return el;
    if (a === "event") return ev;
    if (/^-?\d+(\.\d+)?$/.test(a)) return Number(a);
    if ((a.startsWith("'") && a.endsWith("'")) || (a.startsWith('"') && a.endsWith('"'))) {
      return a.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"');
    }
    const gid = a.match(/^document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)$/);
    if (gid) return document.getElementById(gid[1]);
    return undefined;
  }

  function evalConditionPart(c, el, ev) {
    const p = c.trim();
    if (p === "event.target===this") return ev.target === el;
    if (p === "!aiPlanRunning") return !window.aiPlanRunning;
    if (p === "event.key==='Enter'") return ev.key === "Enter";
    if (p.startsWith("!")) return !evalConditionPart(p.slice(1), el, ev);
    return true;
  }

  function evalCondition(cond, el, ev) {
    return cond.split("&&").map((s) => s.trim()).every((p) => evalConditionPart(p, el, ev));
  }

  function runAssignment(code) {
    const m = code.match(
      /^document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)\.style\.display\s*=\s*['"]([^'"]+)['"]\s*$/
    );
    if (!m) return false;
    const node = document.getElementById(m[1]);
    if (node) node.style.display = m[2];
    return true;
  }

  function runHandler(code, el, ev) {
    if (!code) return;

    const ifM = code.match(/^if\s*\((.*)\)\s*(.+)$/);
    if (ifM) {
      if (!evalCondition(ifM[1], el, ev)) return;
      return runHandler(ifM[2].trim(), el, ev);
    }

    if (code === "event.stopPropagation()") {
      ev.stopPropagation();
      return;
    }

    if (runAssignment(code)) return;

    const call = parseCall(code);
    if (!call) {
      console.warn("[panel-bind] Unparsed:", code);
      return;
    }
    const fn = window[call.name];
    if (typeof fn !== "function") {
      console.warn("[panel-bind] Unknown:", call.name);
      return;
    }
    const args = call.args.map((a) => resolveArg(a, el, ev));
    return fn.apply(el, args);
  }

  function runStatements(code, el, ev) {
    code.split(";").map((p) => p.trim()).filter(Boolean).forEach((part) => runHandler(part, el, ev));
  }

  function bindAttr(attr, eventName) {
    document.addEventListener(
      eventName,
      function (ev) {
        const t = ev.target.closest("[" + attr + "]");
        if (!t) return;
        const code = t.getAttribute(attr);
        if (!code) return;
        runStatements(code, t, ev);
      },
      eventName === "click"
    );
  }

  bindAttr("data-cs-onclick", "click");
  bindAttr("data-cs-onkeydown", "keydown");
  bindAttr("data-cs-onchange", "change");
  bindAttr("data-cs-oninput", "input");
})();
