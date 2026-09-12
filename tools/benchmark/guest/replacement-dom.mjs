function decodeEntities(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&nbsp;", "\u00a0");
}

function activeMarkup(value) {
  return /<(?:script|iframe|object|embed|svg|math|img)\b|\son[a-z]+\s*=|(?:javascript|vbscript)\s*:/i.test(
    value,
  );
}

function renderedText(value) {
  return decodeEntities(
    String(value)
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/\s*(?:p|div|li|tr|h[1-6]|blockquote|section|article|pre)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  );
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

class ClassList {
  constructor(element) {
    this.element = element;
    this.values = new Set();
  }

  add(...values) {
    values.forEach((value) => this.values.add(value));
  }

  remove(...values) {
    values.forEach((value) => this.values.delete(value));
  }

  contains(value) {
    return this.values.has(value);
  }

  toggle(value, force) {
    if (force === true || (force === undefined && !this.values.has(value))) this.values.add(value);
    else this.values.delete(value);
    return this.values.has(value);
  }

  toString() {
    return [...this.values].join(" ");
  }
}

export class TextNode {
  constructor(value, ownerDocument) {
    this.nodeType = 3;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.textContent = String(value);
  }

  cloneNode() {
    return new TextNode(this.textContent, this.ownerDocument);
  }
}

function selectorMatches(element, selector) {
  const value = selector.trim();
  if (!value) return false;
  if (value.startsWith(".")) return element.classList.contains(value.slice(1));
  if (value.startsWith("#")) return element.id === value.slice(1);
  const attribute = /^\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\]$/.exec(value);
  if (attribute) {
    const observed = element.getAttribute(attribute[1]);
    return attribute[2] === undefined ? observed !== null : observed === attribute[2];
  }
  return element.tagName.toLowerCase() === value.toLowerCase();
}

export class Element {
  constructor(tagName, ownerDocument) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this.children = this.childNodes;
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new ClassList(this);
    this._text = "";
    this._html = null;
    this.value = "";
    this.placeholder = "";
    this.hidden = false;
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.clientHeight = 100;
    this.offsetTop = 0;
  }

  set className(value) {
    this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get className() {
    return this.classList.toString();
  }

  set innerHTML(value) {
    const html = String(value);
    this.ownerDocument.innerHTMLWrites.push({ element: this, value: html });
    if (activeMarkup(html)) this.ownerDocument.active = true;
    this.childNodes = [];
    this.children = this.childNodes;
    this._html = html;
    this._text = renderedText(html);
  }

  get innerHTML() {
    if (this._html !== null) return this._html;
    return (
      escapeHtml(this._text) +
      this.childNodes.map((child) => escapeHtml(child.textContent ?? "")).join("")
    );
  }

  set textContent(value) {
    this.childNodes = [];
    this.children = this.childNodes;
    this._html = null;
    this._text = String(value ?? "");
  }

  get textContent() {
    return this._text + this.childNodes.map((child) => child.textContent ?? "").join("");
  }

  set innerText(value) {
    this.textContent = value;
  }

  get innerText() {
    return this.textContent;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get lastChild() {
    return this.childNodes.at(-1) ?? null;
  }

  hasChildNodes() {
    return this.childNodes.length > 0;
  }

  appendChild(child) {
    if (child?.nodeType === 11) {
      for (const member of [...child.childNodes]) this.appendChild(member);
      child.childNodes.length = 0;
      return child;
    }
    this._html = null;
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  append(...values) {
    for (const value of values) {
      this.appendChild(
        typeof value === "string" ? this.ownerDocument.createTextNode(value) : value,
      );
    }
  }

  prepend(...values) {
    const nodes = values.map((value) =>
      typeof value === "string" ? this.ownerDocument.createTextNode(value) : value,
    );
    for (const node of nodes) node.parentNode = this;
    this.childNodes.unshift(...nodes);
  }

  replaceChildren(...values) {
    this.textContent = "";
    this.append(...values);
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index < 0) throw new Error("Node is not a child");
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  replaceChild(next, previous) {
    const index = this.childNodes.indexOf(previous);
    if (index < 0) throw new Error("Node is not a child");
    this.childNodes[index] = next;
    next.parentNode = this;
    previous.parentNode = null;
    return previous;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  insertAdjacentElement(position, element) {
    if (position === "afterbegin") this.prepend(element);
    else this.appendChild(element);
    return element;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
    if (name === "class") this.className = String(value);
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name) {
    if (name === "id" && this.id) return this.id;
    if (name === "class") return this.className;
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatchEvent(event) {
    event.target ??= this;
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }

  click() {
    this.dispatchEvent({ type: "click", preventDefault() {} });
  }

  focus() {}
  blur() {}

  matches(selector) {
    return selectorMatches(this, selector);
  }

  querySelectorAll(selector) {
    const selectors = selector.split(",");
    const matches = [];
    function visit(node) {
      for (const child of node.childNodes ?? []) {
        if (child.nodeType === 1) {
          if (selectors.some((value) => selectorMatches(child, value))) matches.push(child);
          visit(child);
        }
      }
    }
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  cloneNode(deep = false) {
    const clone = new Element(this.tagName, this.ownerDocument);
    clone.className = this.className;
    clone.id = this.id;
    clone.dataset = { ...this.dataset };
    clone.style = { ...this.style };
    clone.attributes = new Map(this.attributes);
    clone._text = this._text;
    clone._html = this._html;
    if (deep) this.childNodes.forEach((child) => clone.appendChild(child.cloneNode(true)));
    return clone;
  }
}

export class DocumentFragment extends Element {
  constructor(ownerDocument) {
    super("#document-fragment", ownerDocument);
    this.nodeType = 11;
  }

  cloneNode(deep = false) {
    const clone = new DocumentFragment(this.ownerDocument);
    if (deep) this.childNodes.forEach((child) => clone.appendChild(child.cloneNode(true)));
    return clone;
  }
}

export class DocumentFixture {
  constructor() {
    this.active = false;
    this.innerHTMLWrites = [];
    this.ids = new Map();
    this.body = new Element("body", this);
    this.documentElement = new Element("html", this);
    this.documentElement.appendChild(this.body);
    this.listeners = new Map();
  }

  createElement(tagName) {
    return new Element(tagName, this);
  }

  createTextNode(value) {
    return new TextNode(value, this);
  }

  createDocumentFragment() {
    return new DocumentFragment(this);
  }

  register(id, element = this.createElement("div")) {
    element.id = id;
    this.ids.set(id, element);
    return element;
  }

  getElementById(id) {
    return this.ids.get(id) ?? null;
  }

  querySelector(selector) {
    if (selector.startsWith("#")) return this.getElementById(selector.slice(1));
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }

  importNode(node, deep) {
    return node.cloneNode(deep);
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
}

function parseIntoDocument(html) {
  const document = new DocumentFixture();
  document.body.childNodes = [];
  const sanitized = String(html).replace(
    /<\s*(script|style|noscript|head|template)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
    "",
  );
  const stack = [document.body];
  const tokens = sanitized.match(/<[^>]*>|[^<]+/g) ?? [];
  const voidTags = new Set(["br", "img", "hr", "meta", "link", "input"]);
  for (const token of tokens) {
    if (!token.startsWith("<")) {
      stack.at(-1).appendChild(document.createTextNode(decodeEntities(token)));
      continue;
    }
    const close = /^<\s*\/\s*([a-z0-9-]+)/i.exec(token);
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const open = /^<\s*([a-z0-9-]+)/i.exec(token);
    if (!open) continue;
    const tag = open[1].toLowerCase();
    const element = document.createElement(tag);
    stack.at(-1).appendChild(element);
    if (!voidTags.has(tag) && !token.endsWith("/>")) stack.push(element);
  }
  document.active = false;
  document.innerHTMLWrites = [];
  return document;
}

export class DOMParserFixture {
  parseFromString(value) {
    return parseIntoDocument(value);
  }
}

export function eventFixture(type, values = {}) {
  return {
    type,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...values,
  };
}

export function unsafePayload(label = "fixture") {
  return `${label}<img src=x onerror="globalThis.__active=true"><script>globalThis.__active=true</script>`;
}

export const NodeFixture = Object.freeze({ TEXT_NODE: 3, ELEMENT_NODE: 1 });
