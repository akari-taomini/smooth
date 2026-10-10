// SPDX-License-Identifier: MIT
// A single insertion per paste, one deferred input event, no text splitting.
export const DEFAULTS = Object.freeze({ enabled: true, threshold: 4096, intercept: true, guardAutocomplete: true, spelling: true });

export function normalizeSettings(settings = {}) {
    const threshold = Math.min(1000000, Math.max(1024, Math.round(Number(settings.threshold) || DEFAULTS.threshold)));
    return { ...DEFAULTS, ...settings, threshold };
}

export function supportedField(node) {
    if (!node || node.disabled || node.readOnly || node.closest?.('[data-st-paste-native]')) return false;
    const eligible = node.tagName === 'TEXTAREA' || (node.tagName === 'INPUT' && ['text', 'search', 'tel', 'url'].includes(node.type));
    return eligible && typeof node.setRangeText === 'function' && Number.isInteger(node.selectionStart) && Number.isInteger(node.selectionEnd);
}

export class PasteEngine {
    constructor({ settings, onStatus = () => {}, now = () => performance.now() }) {
        this.settings = settings;
        this.onStatus = onStatus;
        this.now = now;
        this.active = false;
        this.documents = new Map();
        this.frames = new WeakMap();
        this.pending = new Map();
        this.composing = new WeakSet();
        this.spelling = new WeakMap();
        this.spellingReferences = new Set();
        this.lastUndo = null;
        this.undoTimer = null;
        this.sending = new WeakSet();
        this.completionRestore = null;
    }

    start(doc = document) {
        this.active = true;
        this.mainDocument = doc;
        this.attach(doc);
    }

    attach(doc) {
        if (!doc?.defaultView || this.documents.has(doc)) return;
        const win = doc.defaultView;
        const removals = [];
        const listen = (target, name, handler) => {
            target.addEventListener(name, handler, true);
            removals.push(() => target.removeEventListener(name, handler, true));
        };
        const fieldFrom = event => event.composedPath?.()[0] || event.target;
        listen(win, 'paste', event => {
            if (event.defaultPrevented || !event.cancelable || !this.active || !this.settings().enabled || !this.settings().intercept) return;
            const field = fieldFrom(event);
            if (!supportedField(field) || this.composing.has(field) || event.clipboardData?.files?.length) return;
            const started = this.now();
            const text = event.clipboardData?.getData('text/plain');
            if (typeof text !== 'string' || text.length < this.settings().threshold) return;
            this.insert(event, field, text, started);
        });
        listen(win, 'beforeinput', event => {
            const field = fieldFrom(event);
            if (event.defaultPrevented || !event.cancelable || !this.active || !this.settings().enabled || this.composing.has(field)) return;
            if (event.inputType === 'historyUndo' && this.canUndo(field)) { this.consume(event); this.undo(); return; }
            // Some mobile clipboard actions expose beforeinput without a paste event.
            if (event.inputType !== 'insertFromPaste' || !this.settings().intercept || !supportedField(field) || event.dataTransfer?.files?.length) return;
            const text = event.dataTransfer?.getData('text/plain') || event.data;
            if (typeof text === 'string' && text.length >= this.settings().threshold) this.insert(event, field, text, this.now());
        });
        listen(win, 'input', event => {
            const field = fieldFrom(event);
            if (!this.sending.has(field)) this.cancelPending(field); // Real subsequent edits notify the application themselves.
            if (supportedField(field)) this.updateSpelling(field);
        });
        listen(win, 'compositionstart', event => this.composing.add(fieldFrom(event)));
        listen(win, 'compositionend', event => this.composing.delete(fieldFrom(event)));
        listen(win, 'keydown', event => {
            if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z' && this.canUndo(fieldFrom(event))) {
                this.consume(event); this.undo();
            }
        });
        // Commit input state before save/send/close actions and before the field loses focus.
        listen(win, 'pointerdown', event => {
            if (!event.target?.closest?.('[data-st-paste-undo]')) this.flushAll();
        });
        listen(win, 'click', () => this.flushAll()); // Keyboard or accessibility activation.
        listen(win, 'focusout', event => this.flush(fieldFrom(event)));
        listen(win, 'submit', () => this.flushAll());
        listen(win, 'pagehide', () => { this.flushAll(); if (doc !== this.mainDocument) this.detach(doc); });
        listen(doc, 'load', event => {
            if (event.target?.tagName === 'IFRAME') this.attachFrame(event.target);
        });
        this.documents.set(doc, removals);
        for (const frame of doc.querySelectorAll('iframe')) this.attachFrame(frame);
    }

    attachFrame(frame) {
        try {
            const previous = this.frames.get(frame);
            const doc = frame.contentDocument;
            if (previous && previous !== doc) this.detach(previous);
            if (doc?.defaultView) { this.frames.set(frame, doc); this.attach(doc); }
        } catch { /* Cross-origin frames retain native behavior. */ }
    }

    detach(doc) {
        for (const field of [...this.pending.keys()]) if (field.ownerDocument === doc) this.flush(field);
        for (const field of this.spellingFields()) if (field.ownerDocument === doc) this.restoreSpelling(field);
        if (this.lastUndo?.field.ownerDocument === doc) this.lastUndo = null;
        for (const remove of this.documents.get(doc) || []) remove();
        this.documents.delete(doc);
    }

    consume(event) { event.preventDefault(); event.stopImmediatePropagation(); }

    insert(event, field, text, started) {
        if (!supportedField(field) || this.composing.has(field)) return false;
        const before = field.value;
        const start = field.selectionStart, end = field.selectionEnd;
        // Let the native implementation handle explicit site length restrictions.
        if (field.maxLength >= 0 && text.length > field.maxLength - (before.length - (end - start))) return false;
        const direction = field.selectionDirection;
        const previousAttributes = this.spelling.get(field);
        this.disableSpelling(field);
        try {
            // Browser-native selection replacement; textarea line endings are normalized by the browser.
            field.setRangeText(text, start, end, 'end');
        } catch {
            if (!previousAttributes) this.restoreSpelling(field);
            return false; // The original paste remains available on failure.
        }
        this.consume(event);
        this.cancelPending(field);
        this.lastUndo = { field, before, after: field.value, start, end, direction };
        clearTimeout(this.undoTimer);
        this.undoTimer = setTimeout(() => { this.lastUndo = null; this.onStatus({ phase: 'undo-expired' }); }, 120000);
        const insertionMs = this.now() - started;
        this.onStatus({ phase: 'inserted', characters: text.length, insertionMs });
        this.schedule(field, text, 'insertFromPaste', { characters: text.length, insertionMs });
        return true;
    }

    schedule(field, data, inputType, stats) {
        const win = field.ownerDocument.defaultView;
        const entry = { field, data, inputType, stats, win, frame: null, timer: null };
        this.pending.set(field, entry);
        const deliver = () => this.flush(field);
        // Two frame boundaries allow the insertion to paint before application listeners.
        entry.frame = win.requestAnimationFrame(() => {
            entry.frame = win.requestAnimationFrame(deliver);
        });
        entry.timer = win.setTimeout(deliver, 120); // Hidden documents may never run rAF.
    }

    cancelPending(field) {
        const entry = this.pending.get(field);
        if (!entry) return;
        entry.win.cancelAnimationFrame(entry.frame);
        entry.win.clearTimeout(entry.timer);
        this.pending.delete(field);
    }

    flush(field) {
        const entry = this.pending.get(field);
        if (!entry) return;
        this.cancelPending(field);
        if (!field.isConnected) return;
        const started = this.now();
        this.sending.add(field);
        try {
            const win = field.ownerDocument.defaultView;
            let notification;
            try { notification = new win.InputEvent('input', { bubbles: true, composed: true, inputType: entry.inputType, data: entry.data }); }
            catch { notification = new win.Event('input', { bubbles: true, composed: true }); }
            field.dispatchEvent(notification);
        } finally { this.sending.delete(field); }
        this.onStatus({ phase: 'notified', ...entry.stats, handlerMs: this.now() - started });
    }

    flushAll() { for (const field of [...this.pending.keys()]) this.flush(field); }

    canUndo(field = this.lastUndo?.field) {
        return Boolean(this.lastUndo && field === this.lastUndo.field && field.isConnected && !field.disabled && !field.readOnly && field.value === this.lastUndo.after);
    }

    undo() {
        if (!this.canUndo()) { this.onStatus({ phase: 'undo-unavailable' }); return false; }
        const snapshot = this.lastUndo;
        this.cancelPending(snapshot.field);
        snapshot.field.value = snapshot.before;
        snapshot.field.focus();
        snapshot.field.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction);
        this.lastUndo = null;
        clearTimeout(this.undoTimer);
        this.updateSpelling(snapshot.field);
        this.schedule(snapshot.field, null, 'historyUndo', {});
        this.onStatus({ phase: 'undone' });
        return true;
    }

    disableSpelling(field) {
        if (!this.active || !this.settings().enabled || !this.settings().spelling || this.spelling.has(field)) return;
        const reference = typeof WeakRef === 'function' ? new WeakRef(field) : { deref: () => field };
        this.spellingReferences.add(reference);
        this.spelling.set(field, { reference, attributes: { spellcheck: field.getAttribute('spellcheck'), autocorrect: field.getAttribute('autocorrect') } });
        field.setAttribute('spellcheck', 'false');
        field.setAttribute('autocorrect', 'off');
    }

    updateSpelling(field) {
        if (this.active && this.settings().enabled && this.settings().spelling && field.value.length >= this.settings().threshold) this.disableSpelling(field);
        else this.restoreSpelling(field);
    }

    restoreSpelling(field) {
        const record = this.spelling.get(field);
        if (!record) return;
        for (const [name, value] of Object.entries(record.attributes)) {
            // Preserve a later attribute change made by another extension.
            const ownedValue = name === 'spellcheck' ? 'false' : 'off';
            if (field.getAttribute(name) !== ownedValue) continue;
            value === null ? field.removeAttribute(name) : field.setAttribute(name, value);
        }
        this.spellingReferences.delete(record.reference);
        this.spelling.delete(field);
    }

    spellingFields() {
        const fields = [];
        for (const reference of this.spellingReferences) {
            const field = reference.deref();
            if (field) fields.push(field); else this.spellingReferences.delete(reference);
        }
        return fields;
    }

    hookAutocomplete(AutoComplete) {
        if (this.completionRestore || typeof AutoComplete?.prototype?.show !== 'function') return false;
        const prototype = AutoComplete.prototype;
        const original = prototype.show;
        const engine = this;
        async function optimizedShow(...args) {
            const field = this.textarea;
            if (engine.active && engine.settings().enabled && engine.settings().guardAutocomplete && field &&
                (engine.composing.has(field) || field.value.length >= engine.settings().threshold)) {
                this.text = field.value;
                this.selectionStart = field.selectionStart;
                this.isReplaceable = false;
                this.isShowForced = false;
                return this.hide();
            }
            return original.apply(this, args);
        }
        prototype.show = optimizedShow;
        this.completionRestore = () => { if (prototype.show === optimizedShow) prototype.show = original; };
        return true;
    }

    stop() {
        // Deliver pending state while the completion guard is still active.
        this.flushAll();
        this.active = false;
        for (const doc of [...this.documents.keys()]) this.detach(doc);
        for (const field of this.spellingFields()) this.restoreSpelling(field);
        this.completionRestore?.();
        this.completionRestore = null;
        this.lastUndo = null;
        clearTimeout(this.undoTimer);
    }
}
