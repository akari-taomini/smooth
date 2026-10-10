// SPDX-License-Identifier: MIT
import { PasteEngine, DEFAULTS, normalizeSettings } from './paste-engine.js';

const KEY = 'st_long_paste';
let engine, settings, panel, status, undoButton, context, completionClass;
let completionStatus = '加载中';
let toast, toastTimer;

function persist() { context.extensionSettings[KEY] = settings; context.saveSettingsDebounced(); }

function showStatus(result) {
    if (!status || !undoButton) return;
    if (result.phase === 'inserted') {
        status.textContent = `已填入 ${result.characters.toLocaleString()} 字符，用时 ${Math.round(result.insertionMs)} ms。`;
        undoButton.disabled = false;
        showUndoToast();
    } else if (result.phase === 'notified' && result.characters) {
        status.textContent = `${result.characters.toLocaleString()} 字符：填入 ${Math.round(result.insertionMs)} ms，输入监听执行 ${Math.round(result.handlerMs)} ms。`;
    } else if (result.phase === 'undone') {
        status.textContent = '已撤销本次粘贴。';
        hideToast();
    } else if (result.phase === 'undo-unavailable') {
        status.textContent = '文本已经继续编辑，不能直接撤销整次粘贴。';
        hideToast();
    } else if (result.phase === 'undo-expired') hideToast();
    undoButton.disabled = !engine?.canUndo();
}

function hideToast() { toast?.remove(); toast = null; clearTimeout(toastTimer); }
function showUndoToast() {
    hideToast();
    toast = document.createElement('div');
    toast.className = 'stlp-toast';
    const label = document.createElement('span');
    label.textContent = '长文本已粘贴';
    const undo = document.createElement('button');
    undo.className = 'menu_button';
    undo.dataset.stPasteUndo = '';
    undo.textContent = '撤销';
    undo.addEventListener('pointerdown', event => event.preventDefault());
    undo.addEventListener('click', () => engine.undo());
    const close = document.createElement('button');
    close.className = 'menu_button'; close.textContent = '×'; close.setAttribute('aria-label', '关闭提示');
    close.addEventListener('click', hideToast);
    toast.append(label, undo, close);
    document.body.append(toast);
    toastTimer = setTimeout(hideToast, 10000);
}

function mountPanel() {
    if (panel?.isConnected) return;
    const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!container) return;
    panel = document.createElement('div');
    panel.className = 'stlp-panel';
    panel.innerHTML = `<details><summary>长文本粘贴优化 · 0.1.0</summary>
        <label class="checkbox_label"><input type="checkbox" data-option="enabled">启用插件</label>
        <label class="checkbox_label"><input type="checkbox" data-option="intercept">接管长文本粘贴</label>
        <label class="checkbox_label"><input type="checkbox" data-option="guardAutocomplete">长文本暂停自动补全</label>
        <label class="checkbox_label"><input type="checkbox" data-option="spelling">长文本关闭拼写与自动纠正</label>
        <label>长文本阈值（字符） <input type="number" class="text_pole" data-option="threshold" min="1024" max="1000000" step="1024"></label>
        <small>覆盖文本框、文本区及同源内嵌页面。接管后提供单次撤销；富文本编辑器保留原行为。</small>
        <small class="stlp-compat"></small>
        <div class="stlp-status" role="status"></div>
        <button class="menu_button stlp-undo" data-st-paste-undo disabled>撤销本次粘贴</button>
        <button class="menu_button stlp-chat-limit">长聊天初始加载 50 条</button>
    </details>`;
    status = panel.querySelector('.stlp-status');
    status.textContent = '等待长文本粘贴。';
    panel.querySelector('.stlp-compat').textContent = `自动补全保护：${completionStatus}`;
    undoButton = panel.querySelector('.stlp-undo');
    undoButton.addEventListener('pointerdown', event => event.preventDefault());
    undoButton.addEventListener('click', () => engine.undo());
    for (const input of panel.querySelectorAll('[data-option]')) {
        const option = input.dataset.option;
        if (input.type === 'checkbox') input.checked = settings[option]; else input.value = settings[option];
        input.addEventListener('change', () => {
            if (option === 'enabled' && !input.checked) { engine.stop(); hideToast(); }
            settings[option] = input.type === 'checkbox' ? input.checked : Number(input.value);
            settings = normalizeSettings(settings);
            if (input.type === 'number') input.value = settings[option];
            if (settings.enabled && !engine.active) { engine.start(); if (completionClass) engine.hookAutocomplete(completionClass); }
            for (const field of engine.spellingFields()) engine.updateSpelling(field);
            persist();
        });
    }
    panel.querySelector('.stlp-chat-limit').addEventListener('click', () => {
        const input = document.querySelector('#chat_truncation');
        if (!input) { status.textContent = '未找到消息加载设置，请在用户设置中手动设为 50。'; return; }
        input.value = '50';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        status.textContent = '已设置初始加载 50 条。重新打开聊天后生效，历史记录仍保留。';
    });
    container.append(panel);
}

async function initialize() {
    if (engine) return;
    context = globalThis.SillyTavern?.getContext();
    if (!context?.extensionSettings || typeof context.saveSettingsDebounced !== 'function') {
        console.error('[st-long-paste] 酒馆扩展接口不可用，插件未启动。'); return;
    }
    settings = normalizeSettings(context.extensionSettings[KEY] || DEFAULTS);
    context.extensionSettings[KEY] = settings;
    engine = new PasteEngine({ settings: () => settings, onStatus: showStatus });
    // Install the input listener immediately; internal completion integration is optional.
    if (settings.enabled) engine.start();
    try {
        const module = await import('/scripts/autocomplete/AutoComplete.js');
        completionClass = module.AutoComplete;
        if (typeof completionClass?.prototype?.show !== 'function') throw new Error('接口不匹配');
        if (settings.enabled) engine.hookAutocomplete(completionClass);
        completionStatus = '可用';
    } catch (error) {
        completionStatus = '不可用，仅接管粘贴';
        console.warn('[st-long-paste] 自动补全接口无法接入：', error);
    }
    mountPanel();
    if (context.eventSource && context.eventTypes) {
        const event = context.eventTypes.APP_READY || context.eventTypes.APP_INITIALIZED;
        if (event) context.eventSource.once(event, () => { mountPanel(); });
    }
    if (!panel && document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountPanel, { once: true });
}

export function onDisable() { engine?.stop(); hideToast(); panel?.remove(); panel = null; }
export async function onEnable() {
    if (!engine) await initialize();
    else { if (settings.enabled) { engine.start(); if (completionClass) engine.hookAutocomplete(completionClass); } mountPanel(); }
}

await initialize();
