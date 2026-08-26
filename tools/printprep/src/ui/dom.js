/** Tiny DOM helpers - the UI is hand-built, no framework. */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function card(title, ...children) {
  const t = el('div', { class: 'card-t' }, title);
  return el('div', { class: 'card' }, t, ...children);
}

export function row(label, ...controls) {
  return el('div', { class: 'row' }, el('span', { class: 'lbl' }, label), ...controls);
}

export function rowInfo(label, tip, ...controls) {
  const info = el('i', { class: 'info' }, '?', el('span', { class: 'tip' }, tip));
  return el('div', { class: 'row' }, el('span', { class: 'lbl' }, label, info), ...controls);
}

export function num(value, { min, max, step = 1, unit, onchange } = {}) {
  const input = el('input', { type: 'number', value, min, max, step });
  input.addEventListener('change', () => onchange?.(Number(input.value)));
  const wrap = [input];
  if (unit) wrap.push(el('span', { class: 'unit' }, unit));
  return { input, nodes: wrap };
}

export function select(options, value, onchange) {
  const s = el('select', {},
    ...options.map((o) => el('option', { value: o.value, selected: o.value === value }, o.label)));
  s.addEventListener('change', () => onchange?.(s.value));
  return s;
}

export function seg(options, value, onchange) {
  const wrap = el('div', { class: 'seg' });
  const btns = options.map((o) => {
    const b = el('button', { type: 'button', class: o.value === value ? 'on' : '' }, o.label);
    b.addEventListener('click', () => {
      btns.forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      onchange?.(o.value);
    });
    wrap.append(b);
    return b;
  });
  return { wrap, set(v) { btns.forEach((b, i) => b.classList.toggle('on', options[i].value === v)); } };
}

export function checkbox(label, checked, onchange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onchange?.(input.checked));
  return el('label', { class: 'chk' }, input, label);
}

export function button(label, onclick, cls = '') {
  return el('button', { type: 'button', class: `btn ${cls}`, onclick }, label);
}

/**
 * A slider that snaps to named stops - the joint Fit control. Free values are
 * an invitation to type something the printer cannot resolve, so there are
 * five stops and nothing in between.
 */
export function steppedSlider(stops, index, onchange) {
  const input = el('input', { type: 'range', min: 0, max: stops.length - 1, step: 1, value: index });
  const labels = el('div', { class: 'steps' },
    ...stops.map((s, i) => {
      const span = el('span', { class: i === index ? 'on' : '' }, s.label);
      span.addEventListener('click', () => { input.value = i; sync(); onchange?.(i); });
      return span;
    }));
  const note = el('div', { class: 'note' }, stops[index].note || '');
  function sync() {
    const i = Number(input.value);
    [...labels.children].forEach((c, j) => c.classList.toggle('on', j === i));
    note.textContent = stops[i].note || '';
  }
  input.addEventListener('input', () => { sync(); onchange?.(Number(input.value)); });
  return { wrap: el('div', {}, input, labels, note), input };
}

let toastTimer = null;
export function toast(stageEl, msg, isError = false, ms = 3500) {
  let t = stageEl.querySelector('.toast');
  if (!t) { t = el('div', { class: 'toast' }); stageEl.append(t); }
  t.textContent = msg;
  t.classList.toggle('err', isError);
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

export function setProgress(frac) {
  const bar = document.querySelector('#prog i');
  if (bar) bar.style.width = frac >= 1 || frac <= 0 ? '0' : `${Math.round(frac * 100)}%`;
}

export function download(name, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
